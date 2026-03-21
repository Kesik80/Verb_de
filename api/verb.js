module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { w } = req.query;
  if (!w) return res.status(400).json({ error: 'w required' });

  const verb = w.trim().toLowerCase();
  const url = `https://www.verbformen.ru/sprjazhenie/${encodeURIComponent(verb)}.htm`;

  let html;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ru-RU,ru;q=0.9,de;q=0.8',
        'Referer': 'https://www.verbformen.ru/',
      }
    });
    if (!r.ok) return res.status(502).json({ error: `verbformen.ru: ${r.status}` });
    html = await r.text();
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }

  if (req.query.debug === '3') {
    // Show 500 chars RAW before each table (not stripped)
    const info = [];
    let pos = 0;
    let idx = 0;
    while (true) {
      const ts = html.indexOf('<table', pos);
      if (ts === -1 || idx > 25) break;
      const te = html.indexOf('</table>', ts);
      if (te === -1) break;
      // raw before — show links/hrefs
      const rawBefore = html.slice(Math.max(0, ts - 500), ts).slice(-300);
      // first row of table stripped
      const firstRow = html.slice(ts, Math.min(ts+200, te)).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,100);
      info.push({ idx, rawBefore, firstRow });
      pos = te + 8;
      idx++;
    }
    return res.status(200).json(info);
  }

  try {
    return res.status(200).json(parse(html, verb));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

function strip(s) {
  return s.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ')
    .replace(/&shy;/g,'').replace(/&#(\d+);/g,(_,c)=>String.fromCharCode(+c))
    .replace(/&middot;/g,'·').replace(/\s+/g,' ').trim();
}

// Find table preceded by a link whose href contains urlKey
function findTableByMp3(html, mp3key) {
  let pos = 0;
  while (true) {
    const ts = html.indexOf('<table', pos);
    if (ts === -1) break;
    const te = html.indexOf('</table>', ts);
    if (te === -1) break;
    const before = html.slice(Math.max(0, ts - 300), ts);
    if (before.includes(mp3key)) return html.slice(ts, te + 8);
    pos = te + 8;
  }
  return null;
}

function rowCells(rowHtml) {
  const cells = [];
  let cp = 0;
  while (true) {
    const td = rowHtml.indexOf('<td', cp);
    const th = rowHtml.indexOf('<th', cp);
    let cs = -1, ct = '';
    if (td===-1 && th===-1) break;
    if (td===-1){cs=th;ct='</th>';}
    else if(th===-1){cs=td;ct='</td>';}
    else{cs=Math.min(td,th);ct=cs===td?'</td>':'</th>';}
    const ce = rowHtml.indexOf(ct, cs);
    if (ce===-1) break;
    cells.push(strip(rowHtml.slice(cs,ce)));
    cp = ce + ct.length;
  }
  return cells;
}

const SLOT_KEYS = ['ich','du','er/sie/es','wir','ihr','sie/Sie'];

function parseConjTable(tableHtml) {
  const result = {};
  const dataRows = [];
  let pos = 0;
  while (true) {
    const rs = tableHtml.indexOf('<tr', pos);
    if (rs===-1) break;
    const re = tableHtml.indexOf('</tr>', rs);
    if (re===-1) break;
    const cells = rowCells(tableHtml.slice(rs,re));
    pos = re + 5;
    if (cells.length===2 && cells[0].length>0 && cells[1].length>0)
      dataRows.push(cells);
  }
  dataRows.slice(0,6).forEach((cells,i) => {
    result[SLOT_KEYS[i]] = cells[1];
  });
  return result;
}

function parse(html, word) {
  // Infinitiv
  let infinitiv = word;
  const infM = html.match(/class="[^"]*vInf[^"]*"[^>]*>\s*([a-zäöüß][a-zäöüß\s]{1,39}?)\s*</i);
  if (infM) infinitiv = infM[1].trim();

  // Bedeutung — Russian meaning, take longest vMng match
  let bedeutung = '';
  const bAll = [...html.matchAll(/class="[^"]*vMng[^"]*"[^>]*>([\s\S]{1,600}?)<\/[a-z]/g)];
  for (const m of bAll) {
    const t = strip(m[1]).replace(/^[^а-яёА-ЯЁ]+/, '').trim();
    if (t.length > bedeutung.length) bedeutung = t;
  }
  // Trim to first sentence or 80 chars
  bedeutung = bedeutung.replace(/\s*».*$/, '').trim().slice(0, 100);

  // Level A1/B2 etc — from the "A1 · неправильный · sein" rInf
  let niveau = '';
  const nivM = html.match(/\b(A1|A2|B1|B2|C1|C2)\b/);
  if (nivM) niveau = nivM[1];

  // Unregelmäßig
  const unregelmaessig = /неправильн/i.test(html);

  // Hilfsverb — detect from page text
  let hilfsverb = 'haben';

  // Tense tables — identified by MP3 link URL before each table
  // From debug tails: "ive/sein.mp3", "ein.mp3" etc — need the path segment
  // MP3 URLs follow pattern: /konjugation/indikativ/praesens/sein.mp3
  const tenseConfig = [
    { key:'praesens',        mp3:'/indikativ/praesens/' },
    { key:'praeteritum',     mp3:'/indikativ/praeteritum/' },
    { key:'perfekt',         mp3:'/indikativ/perfekt/' },
    { key:'plusquamperfekt', mp3:'/indikativ/plusquamperfekt/' },
    { key:'futur1',          mp3:'/indikativ/futur1/' },
    { key:'konjunktiv2',     mp3:'/konjunktiv/praeteritum/' },
  ];

  const tenses = {};
  for (const {key, mp3} of tenseConfig) {
    // Find ALL tables preceded by this mp3 key, take the LAST one (full section)
    let found = null;
    let pos = 0;
    while (true) {
      const ts = html.indexOf('<table', pos);
      if (ts === -1) break;
      const te = html.indexOf('</table>', ts);
      if (te === -1) break;
      const before = html.slice(Math.max(0, ts - 300), ts);
      if (before.includes(mp3)) found = html.slice(ts, te + 8);
      pos = te + 8;
    }
    if (found) {
      const conj = parseConjTable(found);
      if (Object.keys(conj).length >= 3) {
        tenses[key] = conj;
        if (key==='perfekt' && conj['ich']) {
          hilfsverb = /^bin\b/i.test(conj['ich']) ? 'sein' : 'haben';
        }
      }
    }
  }

  // Hauptformen: build "ist · war · ist gewesen" from tenses
  const p3 = tenses.praesens?.['er/sie/es'] || '';
  const pt3 = tenses.praeteritum?.['er/sie/es'] || '';
  const pf3 = tenses.perfekt?.['er/sie/es'] || '';
  const hauptformen = {
    praesens_3sg: p3,
    praeteritum_3sg: pt3,
    partizip2: pf3,
  };
  const rInfStr = [p3, pt3, pf3].filter(Boolean).join(' · ');

  // Imperativ — last table before /imperativ/ mp3
  const IMP_SLOTS = ['du','ihr','Sie'];
  let imperativ = {};
  let impFound = null;
  let pos2 = 0;
  while (true) {
    const ts = html.indexOf('<table', pos2);
    if (ts === -1) break;
    const te = html.indexOf('</table>', ts);
    if (te === -1) break;
    const before = html.slice(Math.max(0, ts - 300), ts);
    if (before.includes('/imperativ/')) impFound = html.slice(ts, te + 8);
    pos2 = te + 8;
  }
  if (impFound) {
    const dataRows = [];
    let pos = 0;
    while (true) {
      const rs = impFound.indexOf('<tr', pos);
      if (rs===-1) break;
      const re = impFound.indexOf('</tr>', rs);
      if (re===-1) break;
      const cells = rowCells(impFound.slice(rs,re));
      pos = re+5;
      if (cells.length===2) dataRows.push(cells);
    }
    // 4 rows: du, wir, ihr, Sie — we want du(0), ihr(2), Sie(3)
    if (dataRows[0]) imperativ['du']  = dataRows[0][1];
    if (dataRows[2]) imperativ['ihr'] = dataRows[2][1];
    if (dataRows[3]) imperativ['Sie'] = dataRows[3][1];
  }

  // Beispiele — find example sentences
  const beispiele = [];
  const bspRe = /class="[^"]*\bbsp\b[^"]*"[^>]*>([\s\S]{5,300}?)<\//g;
  let bm;
  while ((bm=bspRe.exec(html))!==null && beispiele.length<3) {
    const t = strip(bm[1]);
    if (t.length>5 && !beispiele.includes(t)) beispiele.push(t);
  }

  return {
    infinitiv, rInfStr, hauptformen, bedeutung,
    niveau, hilfsverb, unregelmaessig,
    tenses, imperativ, beispiele,
    source: `https://www.verbformen.ru/sprjazhenie/${encodeURIComponent(word)}.htm`
  };
}
