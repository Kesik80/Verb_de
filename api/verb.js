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
    .replace(/\s+/g,' ').trim();
}

// Find the Nth table after a text marker (Russian heading before table)
// occurrence: which occurrence to use (0 = first, 1 = second, ...)
function findTableAfter(html, marker, occurrence = 0) {
  let pos = 0;
  let found = 0;
  while (true) {
    const idx = html.indexOf(marker, pos);
    if (idx === -1) return null;
    const ts = html.indexOf('<table', idx);
    if (ts === -1 || ts - idx > 500) { pos = idx + 1; continue; }
    const te = html.indexOf('</table>', ts);
    if (te === -1) return null;
    if (found === occurrence) return html.slice(ts, te + 8);
    found++;
    pos = te + 8;
  }
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

// The page has two sections: compact summary (top) and full conjugation (bottom)
// We want the FULL section tables — they appear SECOND for präsens/präteritum
// For Perfekt/Plusquam/Futur they only appear once in full section
function parse(html, word) {
  // Infinitiv
  let infinitiv = word;
  const infM = html.match(/class="[^"]*vInf[^"]*"[^>]*>\s*([a-zäöüß][a-zäöüß\s]{1,39}?)\s*</i);
  if (infM) infinitiv = infM[1].trim();

  // Bedeutung
  let bedeutung = '';
  const bM = html.match(/class="[^"]*vMng[^"]*"[^>]*>([\s\S]{1,400}?)<\//);
  if (bM) bedeutung = strip(bM[1]);

  let hilfsverb = 'haben';

  // Map: tense key → [Russian marker, occurrence index]
  // From debug: full-section tables appear after these Russian texts
  // Präsens appears twice (compact + full) → use occurrence 1 (second)
  // Präteritum appears twice → use occurrence 1
  // Perfekt appears once in full section
  const tenseConfig = [
    { key:'praesens',        marker:'Презенс',    occ:1 },
    { key:'praeteritum',     marker:'Претеритум', occ:1 },
    { key:'perfekt',         marker:'Перфект',    occ:0 },
    { key:'plusquamperfekt', marker:'Плюсквам.',  occ:0 },
    { key:'futur1',          marker:'Футурум I',  occ:0 },
    { key:'konjunktiv2',     marker:'Конъюнктив II', occ:1 },
  ];

  const tenses = {};
  for (const {key, marker, occ} of tenseConfig) {
    const t = findTableAfter(html, marker, occ);
    if (t) {
      const conj = parseConjTable(t);
      if (Object.keys(conj).length >= 3) {
        tenses[key] = conj;
        if (key==='perfekt' && conj['ich'] && /^bin\b/i.test(conj['ich']))
          hilfsverb = 'sein';
      }
    }
  }

  // Hauptformen from tenses
  const hauptformen = {
    praesens_3sg:    tenses.praesens?.['er/sie/es'] || '',
    praeteritum_3sg: tenses.praeteritum?.['er/sie/es'] || '',
    partizip2:       '',
  };
  if (tenses.perfekt?.['er/sie/es']) {
    const pf = tenses.perfekt['er/sie/es'].trim().split(/\s+/);
    hauptformen.partizip2 = pf[pf.length-1];
  }

  // Imperativ — after "Императив" marker, occurrence 0
  const IMP_SLOTS = ['du','ihr','Sie'];
  let imperativ = {};
  const impT = findTableAfter(html, 'Императив', 0);
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
      if (cells.length===2 && cells[0].length<=15) dataRows.push(cells);
    }
    // Imperativ rows: "(du) sei", "wir seien", "(ihr) seid", "seien Sie"
    // Just take forms from col[1], assign to du/ihr/Sie by position
    const forms = dataRows.map(r => r[1]).filter(Boolean);
    if (forms[0]) imperativ['du']  = forms[0];
    if (forms[2]) imperativ['ihr'] = forms[2];
    if (forms[3]) imperativ['Sie'] = forms[3];
  }

  // Beispiele
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
