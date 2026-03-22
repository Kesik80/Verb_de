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

  if (req.query.debug === '4') {
    // Show raw HTML of perfekt table
    const mp3key = '/konjugation/indikativ/perfekt/';
    const mp3pos = html.indexOf(mp3key);
    if (mp3pos === -1) return res.status(200).json({ error: 'mp3 not found' });
    const ts = html.indexOf('<table', mp3pos);
    const te = html.indexOf('</table>', ts);
    const rawTable = ts === -1 ? 'no table' : html.slice(ts, te + 8);
    return res.status(200).json({ dist: ts - mp3pos, rawTable });
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

// Find the LAST table that appears after mp3key in html
// Strategy: find mp3 link position, then find next <table> after it
function findTableAfterMp3(html, mp3key) {
  let result = null;
  let pos = 0;
  while (true) {
    const mp3pos = html.indexOf(mp3key, pos);
    if (mp3pos === -1) break;
    // Find next <table> after this mp3 link
    const ts = html.indexOf('<table', mp3pos);
    if (ts === -1) { pos = mp3pos + 1; continue; }
    // Make sure table is within 500 chars of mp3 link
    if (ts - mp3pos > 500) { pos = mp3pos + 1; continue; }
    const te = html.indexOf('</table>', ts);
    if (te === -1) break;
    result = html.slice(ts, te + 8);
    pos = mp3pos + 1;
  }
  return result; // returns LAST match
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

// Convert verbformen HTML markup to our span-based format
function formatCell(html) {
  return html
    .replace(/<b><u>(.*?)<\/u><\/b>/g, '<span class="vf-stress">$1</span>')
    .replace(/<b><i><u>(.*?)<\/u><\/i><\/b>/g, '<span class="vf-stress">$1</span>')
    .replace(/<u>(.*?)<\/u>/g, '<span class="vf-stress">$1</span>')
    .replace(/<b>(.*?)<\/b>/g, '<span class="vf-bold">$1</span>')
    .replace(/<i>(.*?)<\/i>/g, '<span class="vf-it">$1</span>')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&shy;/g,'')
    .replace(/&#(\d+);/g,(_,c)=>String.fromCharCode(+c))
    .trim();
}

function parseConjTable(tableHtml) {
  const result = {};
  const dataRows = [];
  let pos = 0;
  while (true) {
    const rs = tableHtml.indexOf('<tr', pos);
    if (rs===-1) break;
    const re = tableHtml.indexOf('</tr>', rs);
    if (re===-1) break;
    // Get raw cell HTML (not stripped)
    const rowHtml = tableHtml.slice(rs, re);
    pos = re + 5;
    // Extract raw td content
    const rawCells = [];
    let cp = 0;
    while (true) {
      const td = rowHtml.indexOf('<td', cp);
      if (td === -1) break;
      const tde = rowHtml.indexOf('</td>', td);
      if (tde === -1) break;
      // Get inner html of td
      const gtEnd = rowHtml.indexOf('>', td);
      rawCells.push(rowHtml.slice(gtEnd + 1, tde));
      cp = tde + 5;
    }
    if (rawCells.length >= 2) {
      const pronoun = strip(rawCells[0]);
      if (!pronoun) continue;
      const form = rawCells.length >= 3
        ? formatCell(rawCells[1]) + ' ' + formatCell(rawCells[2])
        : formatCell(rawCells[1]);
      dataRows.push([pronoun, form.trim()]);
    }
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

  // Tenses — find table that comes right after the mp3 link
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
    const t = findTableAfterMp3(html, mp3);
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
  const impT = findTableAfterMp3(html, '/konjugation/imperativ/');
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

  // Extract mp3 URLs for each tense
  const mp3s = {};
  const mp3Keys = {
    praesens:        '/konjugation/indikativ/praesens/',
    praeteritum:     '/konjugation/indikativ/praeteritum/',
    perfekt:         '/konjugation/indikativ/perfekt/',
    plusquamperfekt: '/konjugation/indikativ/plusquamperfekt/',
    futur1:          '/konjugation/indikativ/futur1/',
    konjunktiv2:     '/konjugation/konjunktiv/praeteritum/',
  };
  for (const [key, path] of Object.entries(mp3Keys)) {
    // Find last occurrence of this path (full section)
    let mp3url = null;
    let pos = 0;
    while (true) {
      const idx = html.indexOf(path, pos);
      if (idx === -1) break;
      // Extract full URL: find href=" before idx
      const hrefStart = html.lastIndexOf('href="', idx);
      if (hrefStart !== -1 && idx - hrefStart < 10) {
        const urlEnd = html.indexOf('"', hrefStart + 6);
        mp3url = html.slice(hrefStart + 6, urlEnd);
      }
      pos = idx + 1;
    }
    if (mp3url) mp3s[key] = mp3url;
  }

  // Also get infinitiv mp3
  const infMp3M = html.match(/href="(https:\/\/www\.verbformen\.de\/konjugation\/infinitiv[^"]+\.mp3)"/);
  if (infMp3M) mp3s.infinitiv = infMp3M[1];

  return {
    infinitiv, rInfStr, hauptformen, bedeutung,
    niveau, hilfsverb, unregelmaessig,
    tenses, imperativ, beispiele, mp3s,
    source: `https://www.verbformen.ru/sprjazhenie/${encodeURIComponent(word)}.htm`
  };
}
