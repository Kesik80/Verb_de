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

// Collect all tables with their preceding raw HTML (300 chars)
function getAllTables(html) {
  const tables = [];
  let pos = 0;
  while (true) {
    const ts = html.indexOf('<table', pos);
    if (ts === -1) break;
    const te = html.indexOf('</table>', ts);
    if (te === -1) break;
    const before = html.slice(Math.max(0, ts - 300), ts);
    tables.push({ before, html: html.slice(ts, te + 8) });
    pos = te + 8;
  }
  return tables;
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
  const tables = getAllTables(html);

  // MP3 links go to verbformen.DE — find tables by mp3 path
  // Take LAST match for each key (full section comes after compact section)
  function findLast(mp3path) {
    let found = null;
    for (const t of tables) {
      if (t.before.includes(mp3path)) found = t.html;
    }
    return found;
  }

  // Infinitiv
  let infinitiv = word;
  const infM = html.match(/class="[^"]*vInf[^"]*"[^>]*>\s*([a-zäöüß][a-zäöüß\s]{1,39}?)\s*</i);
  if (infM) infinitiv = infM[1].trim();

  // Bedeutung
  let bedeutung = '';
  const bAll = [...html.matchAll(/class="[^"]*vMng[^"]*"[^>]*>([\s\S]{1,600}?)<\/[a-z]/g)];
  for (const m of bAll) {
    const t = strip(m[1]).replace(/^\W+/, '').trim();
    if (t.length > bedeutung.length && /[а-яёА-ЯЁ]/.test(t)) bedeutung = t;
  }
  bedeutung = bedeutung.slice(0, 100).replace(/\s*».*$/, '').trim();

  // Niveau, unregelmaessig
  const niveauM = html.match(/\b(A1|A2|B1|B2|C1|C2)\b/);
  const niveau = niveauM ? niveauM[1] : '';
  const unregelmaessig = /неправильн/i.test(html);

  let hilfsverb = 'haben';

  // Tenses — use mp3 path on verbformen.DE domain
  const tenseConfig = [
    { key:'praesens',        mp3:'/konjugation/indikativ/praesens/' },
    { key:'praeteritum',     mp3:'/konjugation/indikativ/praeteritum/' },
    { key:'perfekt',         mp3:'/konjugation/indikativ/perfekt/' },
    { key:'plusquamperfekt', mp3:'/konjugation/indikativ/plusquamperfekt/' },
    { key:'futur1',          mp3:'/konjugation/indikativ/futur1/' },
    { key:'konjunktiv2',     mp3:'/konjugation/konjunktiv/praeteritum/' },
  ];

  const tenses = {};
  for (const {key, mp3} of tenseConfig) {
    const t = findLast(mp3);
    if (t) {
      const conj = parseConjTable(t);
      if (Object.keys(conj).length >= 3) {
        tenses[key] = conj;
        if (key==='perfekt' && conj['ich']) {
          hilfsverb = /^bin\b/i.test(conj['ich']) ? 'sein' : 'haben';
        }
      }
    }
  }

  // Hauptformen + rInfStr
  const p3  = tenses.praesens?.['er/sie/es'] || '';
  const pt3 = tenses.praeteritum?.['er/sie/es'] || '';
  const pf3 = tenses.perfekt?.['er/sie/es'] || '';
  const hauptformen = { praesens_3sg: p3, praeteritum_3sg: pt3, partizip2: pf3 };
  const rInfStr = [p3, pt3, pf3].filter(Boolean).join(' · ');

  // Imperativ — last table with /konjugation/imperativ/
  const impT = findLast('/konjugation/imperativ/');
  const IMP_SLOTS = ['du','ihr','Sie'];
  let imperativ = {};
  if (impT) {
    const dataRows = [];
    let pos = 0;
    while (true) {
      const rs = impT.indexOf('<tr', pos);
      if (rs===-1) break;
      const re = impT.indexOf('</tr>', rs);
      if (re===-1) break;
      const cells = rowCells(impT.slice(rs,re));
      pos = re+5;
      if (cells.length===2) dataRows.push(cells);
    }
    // rows: du(0), wir(1), ihr(2), Sie(3)
    if (dataRows[0]) imperativ['du']  = dataRows[0][1];
    if (dataRows[2]) imperativ['ihr'] = dataRows[2][1];
    if (dataRows[3]) imperativ['Sie'] = dataRows[3][1];
  }

  // Beispiele
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
