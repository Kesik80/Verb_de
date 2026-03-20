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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ru-RU,ru;q=0.9,de;q=0.8',
        'Referer': 'https://www.verbformen.ru/',
      }
    });
    if (!r.ok) return res.status(502).json({ error: `verbformen.ru: ${r.status}`, url });
    html = await r.text();
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }

  // Debug mode: return raw HTML chunks to understand structure
  if (debug === '1') {
    // Find all <table occurrences and show context
    const tables = [];
    let pos = 0;
    while (true) {
      const ts = html.indexOf('<table', pos);
      if (ts === -1) break;
      const te = html.indexOf('</table>', ts);
      // Show 200 chars before table (to see heading) + first 300 of table
      const before = html.slice(Math.max(0, ts - 200), ts);
      const tableStart = html.slice(ts, Math.min(ts + 300, te === -1 ? ts + 300 : te));
      tables.push({ before: before.replace(/<[^>]+>/g, ' ').replace(/\s+/g,' ').trim(), tableStart: tableStart.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim() });
      pos = te === -1 ? ts + 6 : te + 8;
      if (tables.length >= 15) break;
    }
    // Also show rInf and vInf matches
    const rInfM = html.match(/class="[^"]*rInf[^"]*"[\s\S]{0,500}/);
    const vInfM = html.match(/class="[^"]*vInf[^"]*"[\s\S]{0,200}/);
    return res.status(200).json({
      totalLen: html.length,
      rInfSnippet: rInfM ? rInfM[0].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0,300) : null,
      vInfSnippet: vInfM ? vInfM[0].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0,200) : null,
      tables
    });
  }

  try {
    const data = parse(html, verb);
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message, snippet: html.slice(0, 500) });
  }
};

function stripTags(s) {
  return s.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/&shy;/g,'').replace(/&#(\d+);/g,(_,c)=>String.fromCharCode(+c)).replace(/\s+/g,' ').trim();
}

function tableRows(tableHtml) {
  const rows = [];
  let pos = 0;
  while (true) {
    const rs = tableHtml.indexOf('<tr', pos);
    if (rs === -1) break;
    const re = tableHtml.indexOf('</tr>', rs);
    if (re === -1) break;
    const rowHtml = tableHtml.slice(rs, re);
    pos = re + 5;
    const cells = [];
    let cp = 0;
    while (true) {
      const td = rowHtml.indexOf('<td', cp);
      const th = rowHtml.indexOf('<th', cp);
      let cs = -1, closeTag = '';
      if (td === -1 && th === -1) break;
      if (td === -1) { cs = th; closeTag = '</th>'; }
      else if (th === -1) { cs = td; closeTag = '</td>'; }
      else { cs = Math.min(td, th); closeTag = cs === td ? '</td>' : '</th>'; }
      const ce = rowHtml.indexOf(closeTag, cs);
      if (ce === -1) break;
      cells.push(stripTags(rowHtml.slice(cs, ce)));
      cp = ce + closeTag.length;
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function findTable(html, afterText) {
  const idx = html.indexOf(afterText);
  if (idx === -1) return null;
  const ts = html.indexOf('<table', idx);
  if (ts === -1 || ts - idx > 3000) return null;
  const te = html.indexOf('</table>', ts);
  if (te === -1) return null;
  return html.slice(ts, te + 8);
}

const PRONOUN_MAP = {
  'ich':'ich','du':'du',
  'er':'er/sie/es','sie':'er/sie/es','es':'er/sie/es','er/sie/es':'er/sie/es',
  'wir':'wir','ihr':'ihr','sie/sie':'sie/Sie',
};

function parseConjTable(tableHtml) {
  const result = {};
  for (const row of tableRows(tableHtml)) {
    if (row.length < 2) continue;
    const key = PRONOUN_MAP[row[0].toLowerCase().replace(/\s+/g,'')];
    if (key) result[key] = row[1];
  }
  return result;
}

function parse(html, word) {
  let infinitiv = word;
  const infM = html.match(/class="[^"]*vInf[^"]*"[^>]*>([^<]{2,30})</);
  if (infM) infinitiv = infM[1].trim();

  let hauptformen = { praesens_3sg:'', praeteritum_3sg:'', partizip2:'' };
  const hfM = html.match(/class="[^"]*rInf[^"]*"[^>]*>([\s\S]{1,400}?)<\/p>/);
  if (hfM) {
    const parts = stripTags(hfM[1]).split('·').map(s=>s.trim()).filter(Boolean);
    hauptformen = { praesens_3sg: parts[0]||'', praeteritum_3sg: parts[1]||'', partizip2: parts[2]||'' };
  }

  let bedeutung = '';
  const bM = html.match(/class="[^"]*vMng[^"]*"[^>]*>([\s\S]{1,300}?)<\//);
  if (bM) bedeutung = stripTags(bM[1]);

  let hilfsverb = 'haben';
  if (/sein<\/a>\s*\(Hilfsverb\)|Hilfsverb[^<]{0,80}>sein/i.test(html)) hilfsverb = 'sein';

  const tenseSearches = [
    { key: 'praesens',        needles: ['Präsens'] },
    { key: 'praeteritum',     needles: ['Präteritum'] },
    { key: 'perfekt',         needles: ['Perfekt'] },
    { key: 'plusquamperfekt', needles: ['Plusquamperfekt'] },
    { key: 'futur1',          needles: ['Futur I', 'Futur 1'] },
    { key: 'konjunktiv2',     needles: ['Konjunktiv II', 'Konjunktiv 2'] },
  ];

  const tenses = {};
  for (const { key, needles } of tenseSearches) {
    for (const needle of needles) {
      const t = findTable(html, needle);
      if (t) {
        const conj = parseConjTable(t);
        if (Object.keys(conj).length >= 3) { tenses[key] = conj; break; }
      }
    }
  }

  let imperativ = {};
  const impT = findTable(html, 'Imperativ');
  if (impT) {
    for (const row of tableRows(impT)) {
      if (row.length < 2) continue;
      const p = row[0].toLowerCase();
      if (p==='du') imperativ['du']=row[1];
      else if (p==='ihr') imperativ['ihr']=row[1];
      else if (p==='sie') imperativ['Sie']=row[1];
    }
  }

  const beispiele = [];
  const bspRe = /class="[^"]*\bbsp\b[^"]*"[^>]*>([\s\S]{5,300}?)<\//g;
  let bm;
  while ((bm = bspRe.exec(html)) !== null && beispiele.length < 3) {
    const t = stripTags(bm[1]);
    if (t.length > 5 && !beispiele.includes(t)) beispiele.push(t);
  }

  return { infinitiv, hauptformen, bedeutung, hilfsverb, tenses, imperativ, beispiele,
    source: `https://www.verbformen.ru/sprjazhenie/${encodeURIComponent(word)}.htm` };
}
