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

  try {
    const data = parse(html, verb);
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

function stripTags(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&shy;/g, '')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
    .replace(/\s+/g, ' ').trim();
}

// Extract all <td>/<th> texts from a table html string
function cellTexts(tableHtml) {
  const cells = [];
  let pos = 0;
  while (true) {
    const td = tableHtml.indexOf('<td', pos);
    const th = tableHtml.indexOf('<th', pos);
    let cs = -1, closeTag = '';
    if (td === -1 && th === -1) break;
    if (td === -1) { cs = th; closeTag = '</th>'; }
    else if (th === -1) { cs = td; closeTag = '</td>'; }
    else { cs = Math.min(td, th); closeTag = cs === td ? '</td>' : '</th>'; }
    const ce = tableHtml.indexOf(closeTag, cs);
    if (ce === -1) break;
    cells.push(stripTags(tableHtml.slice(cs, ce)));
    pos = ce + closeTag.length;
  }
  return cells;
}

// Find table whose nearest preceding link href contains urlKey
function findTableByUrlKey(html, urlKey) {
  let pos = 0;
  while (true) {
    const ts = html.indexOf('<table', pos);
    if (ts === -1) break;
    const te = html.indexOf('</table>', ts);
    if (te === -1) break;
    // look back 400 chars for a link with urlKey
    const before = html.slice(Math.max(0, ts - 400), ts);
    if (before.includes(urlKey)) {
      return html.slice(ts, te + 8);
    }
    pos = te + 8;
  }
  return null;
}

const PRONOUNS = ['ich', 'du', 'er/sie/es', 'wir', 'ihr', 'sie/Sie'];

// The table cells come as flat list: pronoun, form, pronoun, form...
// But verbformen splits words with spaces for phonetics — join them back
// Cells alternate: pronoun | conjugated-form (possibly multi-word like "bin ge wes en")
// Actually structure is: 6 rows × 2 cols → [pron, form, pron, form, ...]
function parseConjFlat(cells) {
  const result = {};
  // Filter out empty / header cells, find pronoun+form pairs
  const pronounMap = {
    'ich':'ich','du':'du',
    'er/sie/es':'er/sie/es','er':'er/sie/es',
    'wir':'wir','ihr':'ihr',
    'sie/sie':'sie/Sie','sie':'sie/Sie'
  };
  
  for (let i = 0; i < cells.length - 1; i++) {
    const key = pronounMap[cells[i].toLowerCase().replace(/\s/g,'')];
    if (key && !result[key]) {
      // next cell is the form — remove internal spaces used for syllable breaks
      // but keep spaces between actual words (e.g. "bin gewesen")
      const raw = cells[i + 1];
      // collapse syllable-split: "ge wes en" → "gewesen", but "bin ge wes en" → "bin gewesen"
      // Strategy: the form cell contains the conjugated form with syllable dots removed
      // Just clean it up - it may have format "bin ge wes en" meaning "bin gewesen"
      result[key] = raw.replace(/\s+/g, ' ').trim();
      i++; // skip the form cell
    }
  }
  return result;
}

// Better: parse table as rows (tr > td pairs)
function parseConjTable(tableHtml) {
  const result = {};
  const pronounMap = {
    'ich':'ich','du':'du',
    'er/sie/es':'er/sie/es',
    'wir':'wir','ihr':'ihr',
    'sie/sie':'sie/Sie',
  };
  
  // Get all rows
  let pos = 0;
  while (true) {
    const rs = tableHtml.indexOf('<tr', pos);
    if (rs === -1) break;
    const re = tableHtml.indexOf('</tr>', rs);
    if (re === -1) break;
    const rowHtml = tableHtml.slice(rs, re);
    pos = re + 5;
    
    const cells = cellTexts(rowHtml);
    if (cells.length >= 2) {
      const key = pronounMap[cells[0].toLowerCase().replace(/\s/g,'')];
      if (key) result[key] = cells[1];
    }
  }
  return result;
}

function parse(html, word) {
  // Infinitiv — from page h1 or vInf class
  let infinitiv = word;
  const infM = html.match(/class="[^"]*vInf[^"]*"[^>]*>([^<]{2,40})</) ||
               html.match(/<h1[^>]*>([^<]{2,40})<\/h1>/);
  if (infM) infinitiv = infM[1].trim();

  // Hauptformen — look for rInf class or the 3-form summary
  let hauptformen = { praesens_3sg: '', praeteritum_3sg: '', partizip2: '' };
  // Try rInf
  const hfM = html.match(/class="[^"]*rInf[^"]*"[^>]*>([\s\S]{1,500}?)<\/p>/);
  if (hfM) {
    const parts = stripTags(hfM[1]).split('·').map(s => s.trim()).filter(Boolean);
    if (parts.length >= 3) {
      hauptformen = { praesens_3sg: parts[0], praeteritum_3sg: parts[1], partizip2: parts[2] };
    }
  }
  // Fallback: find from praesens table (er/sie/es row) and partizip
  // We'll fill this after parsing tenses below

  // Bedeutung / meaning
  let bedeutung = '';
  const bM = html.match(/class="[^"]*vMng[^"]*"[^>]*>([\s\S]{1,400}?)<\//);
  if (bM) bedeutung = stripTags(bM[1]);

  // Hilfsverb — look for "sein" near Perfekt section
  let hilfsverb = 'haben';
  // verbformen.ru marks it in the Perfekt table — if first person is "bin" → sein
  // We'll determine after parsing

  // Tenses — find by URL pattern in the preceding anchor
  const tenseKeys = [
    { key: 'praesens',        urlKey: '/indikativ/praesens/' },
    { key: 'praeteritum',     urlKey: '/indikativ/praeteritum/' },
    { key: 'perfekt',         urlKey: '/indikativ/perfekt/' },
    { key: 'plusquamperfekt', urlKey: '/indikativ/plusquamperfekt/' },
    { key: 'futur1',          urlKey: '/indikativ/futur1/' },
    { key: 'konjunktiv2',     urlKey: '/konjunktiv/praeteritum/' },
  ];

  const tenses = {};
  for (const { key, urlKey } of tenseKeys) {
    const tableHtml = findTableByUrlKey(html, urlKey);
    if (tableHtml) {
      const conj = parseConjTable(tableHtml);
      if (Object.keys(conj).length >= 3) {
        tenses[key] = conj;
        // Determine hilfsverb from perfekt
        if (key === 'perfekt' && conj['ich']) {
          if (conj['ich'].toLowerCase().startsWith('bin')) hilfsverb = 'sein';
        }
      }
    }
  }

  // Fill hauptformen from tenses if rInf failed
  if (!hauptformen.praesens_3sg && tenses.praesens?.['er/sie/es']) {
    hauptformen.praesens_3sg = tenses.praesens['er/sie/es'];
  }
  if (!hauptformen.praeteritum_3sg && tenses.praeteritum?.['er/sie/es']) {
    hauptformen.praeteritum_3sg = tenses.praeteritum['er/sie/es'];
  }
  if (!hauptformen.partizip2 && tenses.perfekt?.['er/sie/es']) {
    // Extract partizip from "ist gegangen" → "gegangen"
    const pf = tenses.perfekt['er/sie/es'];
    const pfParts = pf.split(' ');
    if (pfParts.length >= 2) hauptformen.partizip2 = pfParts[pfParts.length - 1];
  }

  // Imperativ
  let imperativ = {};
  const impTable = findTableByUrlKey(html, '/imperativ/') ||
                   findTableByUrlKey(html, 'imperativ/sein');
  if (impTable) {
    let pos = 0;
    while (true) {
      const rs = impTable.indexOf('<tr', pos);
      if (rs === -1) break;
      const re = impTable.indexOf('</tr>', rs);
      if (re === -1) break;
      const cells = cellTexts(impTable.slice(rs, re));
      pos = re + 5;
      if (cells.length >= 2) {
        const p = cells[0].toLowerCase();
        if (p === 'du') imperativ['du'] = cells[1];
        else if (p === 'ihr') imperativ['ihr'] = cells[1];
        else if (p === 'sie') imperativ['Sie'] = cells[1];
      }
    }
  }

  // Beispiele
  const beispiele = [];
  const bspRe = /class="[^"]*\bbsp\b[^"]*"[^>]*>([\s\S]{5,300}?)<\//g;
  let bm;
  while ((bm = bspRe.exec(html)) !== null && beispiele.length < 3) {
    const t = stripTags(bm[1]);
    if (t.length > 5 && !beispiele.includes(t)) beispiele.push(t);
  }

  return {
    infinitiv, hauptformen, bedeutung, hilfsverb,
    tenses, imperativ, beispiele,
    source: `https://www.verbformen.ru/sprjazhenie/${encodeURIComponent(word)}.htm`
  };
}
