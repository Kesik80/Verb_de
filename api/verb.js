module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { w, debug } = req.query;
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

  // Debug: show 400 chars before each table (stripped tags)
  if (debug === '1') {
    const info = [];
    let pos = 0;
    while (true) {
      const ts = html.indexOf('<table', pos);
      if (ts === -1) break;
      const te = html.indexOf('</table>', ts);
      if (te === -1) break;
      const before = html.slice(Math.max(0, ts - 400), ts)
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(-200);
      const firstRow = html.slice(ts, Math.min(ts+300, te))
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
      info.push({ before, firstRow });
      pos = te + 8;
      if (info.length >= 20) break;
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
    .replace(/\s+/g,' ').trim();
}

function findTableByUrlKey(html, urlKey) {
  let pos = 0;
  while (true) {
    const ts = html.indexOf('<table', pos);
    if (ts === -1) break;
    const te = html.indexOf('</table>', ts);
    if (te === -1) break;
    if (html.slice(Math.max(0, ts - 600), ts).includes(urlKey))
      return html.slice(ts, te + 8);
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
  dataRows.slice(0,6).forEach((cells,i)=>{
    result[SLOT_KEYS[i]] = cells[1];
  });
  return result;
}

function parse(html, word) {
  let infinitiv = word;
  const infM = html.match(/class="[^"]*vInf[^"]*"[^>]*>\s*([a-zäöüß][a-zäöüß\s]{1,39}?)\s*</i);
  if (infM) infinitiv = infM[1].trim();

  // hauptformen — from rInf but filter garbage (must look like German verb forms)
  let hauptformen = { praesens_3sg:'', praeteritum_3sg:'', partizip2:'' };
  const hfM = html.match(/class="[^"]*rInf[^"]*"[^>]*>([\s\S]{1,500}?)<\/p>/);
  if (hfM) {
    const parts = strip(hfM[1]).split('·').map(s=>s.trim()).filter(s=>/^[a-zäöüß\s]+$/i.test(s));
    if (parts.length>=3)
      hauptformen = { praesens_3sg:parts[0], praeteritum_3sg:parts[1], partizip2:parts[2] };
  }

  let bedeutung = '';
  const bM = html.match(/class="[^"]*vMng[^"]*"[^>]*>([\s\S]{1,400}?)<\//);
  if (bM) bedeutung = strip(bM[1]);

  let hilfsverb = 'haben';

  // Try multiple urlKey variants for perfekt/plusquamperfekt
  const tenseKeys = [
    { key:'praesens',        keys:['/indikativ/praesens/'] },
    { key:'praeteritum',     keys:['/indikativ/praeteritum/'] },
    { key:'perfekt',         keys:['/indikativ/perfekt/','/konjugation/indikativ/perfekt/'] },
    { key:'plusquamperfekt', keys:['/indikativ/plusquamperfekt/','/konjugation/indikativ/plusquamperfekt/'] },
    { key:'futur1',          keys:['/indikativ/futur1/','/indikativ/futur/'] },
    { key:'konjunktiv2',     keys:['/konjunktiv/praeteritum/','/konjunktiv2/'] },
  ];

  const tenses = {};
  for (const {key, keys} of tenseKeys) {
    for (const urlKey of keys) {
      const t = findTableByUrlKey(html, urlKey);
      if (t) {
        const conj = parseConjTable(t);
        if (Object.keys(conj).length>=3) {
          tenses[key] = conj;
          if (key==='perfekt' && conj['ich'] && /^bin\b/i.test(conj['ich']))
            hilfsverb = 'sein';
          break;
        }
      }
    }
  }

  // Fill hauptformen from tenses
  if (!hauptformen.praesens_3sg)    hauptformen.praesens_3sg    = tenses.praesens?.['er/sie/es']||'';
  if (!hauptformen.praeteritum_3sg) hauptformen.praeteritum_3sg = tenses.praeteritum?.['er/sie/es']||'';
  if (!hauptformen.partizip2 && tenses.perfekt?.['er/sie/es']) {
    const pf = tenses.perfekt['er/sie/es'].trim().split(/\s+/);
    hauptformen.partizip2 = pf[pf.length-1];
  }

  // Imperativ — by position: du, ihr, Sie
  const IMP_SLOTS = ['du','ihr','Sie'];
  let imperativ = {};
  const impT = findTableByUrlKey(html, '/imperativ/');
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
      // Only rows where first cell looks like a pronoun (short word)
      if (cells.length===2 && cells[0].length<=10) dataRows.push(cells);
    }
    dataRows.slice(0,3).forEach((cells,i)=>{
      imperativ[IMP_SLOTS[i]] = cells[1];
    });
  }

  const beispiele = [];
  const bspRe = /class="[^"]*\bbsp\b[^"]*"[^>]*>([\s\S]{5,300}?)<\//g;
  let bm;
  while ((bm=bspRe.exec(html))!==null && beispiele.length<3) {
    const t = strip(bm[1]);
    if (t.length>5 && !beispiele.includes(t)) beispiele.push(t);
  }

  return { infinitiv, hauptformen, bedeutung, hilfsverb, tenses, imperativ, beispiele,
    source:`https://www.verbformen.ru/sprjazhenie/${encodeURIComponent(word)}.htm` };
}
