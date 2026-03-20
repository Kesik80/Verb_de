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

  // Debug: show raw rows of praesens table
  if (debug === '1') {
    const tableHtml = findTableByUrlKey(html, '/indikativ/praesens/');
    if (!tableHtml) return res.status(200).json({ error: 'praesens table not found' });
    // show all tr > cells raw
    const rows = [];
    let pos = 0;
    while (true) {
      const rs = tableHtml.indexOf('<tr', pos);
      if (rs === -1) break;
      const re = tableHtml.indexOf('</tr>', rs);
      if (re === -1) break;
      const rowHtml = tableHtml.slice(rs, re);
      pos = re + 5;
      // raw html of each cell
      const rawCells = [];
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
        rawCells.push(rowHtml.slice(cs, ce + closeTag.length).slice(0, 200));
        cp = ce + closeTag.length;
      }
      rows.push(rawCells);
    }
    return res.status(200).json({ tableFound: true, rows });
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

function findTableByUrlKey(html, urlKey) {
  let pos = 0;
  while (true) {
    const ts = html.indexOf('<table', pos);
    if (ts === -1) break;
    const te = html.indexOf('</table>', ts);
    if (te === -1) break;
    const before = html.slice(Math.max(0, ts - 600), ts);
    if (before.includes(urlKey)) return html.slice(ts, te + 8);
    pos = te + 8;
  }
  return null;
}

function cellTexts(rowHtml) {
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
  return cells;
}

// verbformen.ru table structure:
// each row has cells like: [pronoun_sg, form_sg, pronoun_pl, form_pl]
// OR it might be two separate columns SG | PL
const PRONOUN_MAP = {
  'ich':'ich','du':'du',
  'er/sie/es':'er/sie/es','er':'er/sie/es',
  'wir':'wir','ihr':'ihr',
  'sie/sie':'sie/Sie','sie':'sie/Sie',
};

function parseConjTable(tableHtml) {
  const result = {};
  let pos = 0;
  while (true) {
    const rs = tableHtml.indexOf('<tr', pos);
    if (rs === -1) break;
    const re = tableHtml.indexOf('</tr>', rs);
    if (re === -1) break;
    const cells = cellTexts(tableHtml.slice(rs, re));
    pos = re + 5;

    // Row might have 2 cells [pron, form] or 4 cells [pron_sg, form_sg, pron_pl, form_pl]
    if (cells.length === 2) {
      const k = PRONOUN_MAP[cells[0].toLowerCase().replace(/\s/g,'')];
      if (k) result[k] = cells[1];
    } else if (cells.length === 4) {
      const k1 = PRONOUN_MAP[cells[0].toLowerCase().replace(/\s/g,'')];
      if (k1) result[k1] = cells[1];
      const k2 = PRONOUN_MAP[cells[2].toLowerCase().replace(/\s/g,'')];
      if (k2) result[k2] = cells[3];
    } else if (cells.length === 6) {
      // might have colspan headers; try pairs
      for (let i = 0; i < cells.length - 1; i += 2) {
        const k = PRONOUN_MAP[cells[i].toLowerCase().replace(/\s/g,'')];
        if (k) result[k] = cells[i+1];
      }
    }
  }
  return result;
}

function parse(html, word) {
  // Infinitiv — from vInf class specifically
  let infinitiv = word;
  const infM = html.match(/class="[^"]*vInf[^"]*"[^>]*>\s*([a-zäöüß]{2,40})\s*</i);
  if (infM) infinitiv = infM[1].trim();

  // Hauptformen
  let hauptformen = { praesens_3sg: '', praeteritum_3sg: '', partizip2: '' };
  const hfM = html.match(/class="[^"]*rInf[^"]*"[^>]*>([\s\S]{1,500}?)<\/p>/);
  if (hfM) {
    const parts = stripTags(hfM[1]).split('·').map(s => s.trim()).filter(Boolean);
    if (parts.length >= 3) {
      hauptformen = { praesens_3sg: parts[0], praeteritum_3sg: parts[1], partizip2: parts[2] };
    }
  }

  // Bedeutung
  let bedeutung = '';
  const bM = html.match(/class="[^"]*vMng[^"]*"[^>]*>([\s\S]{1,400}?)<\//);
  if (bM) bedeutung = stripTags(bM[1]);

  let hilfsverb = 'haben';

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
      if (Object.keys(conj).length >= 2) {
        tenses[key] = conj;
        if (key === 'perfekt' && conj['ich']) {
          if (/^bin\b/i.test(conj['ich'])) hilfsverb = 'sein';
        }
      }
    }
  }

  // Fill hauptformen from tenses if needed
  if (!hauptformen.praesens_3sg && tenses.praesens?.['er/sie/es'])
    hauptformen.praesens_3sg = tenses.praesens['er/sie/es'];
  if (!hauptformen.praeteritum_3sg && tenses.praeteritum?.['er/sie/es'])
    hauptformen.praeteritum_3sg = tenses.praeteritum['er/sie/es'];
  if (!hauptformen.partizip2 && tenses.perfekt?.['er/sie/es']) {
    const pf = tenses.perfekt['er/sie/es'].split(' ');
    if (pf.length >= 2) hauptformen.partizip2 = pf[pf.length - 1];
  }

  // Imperativ
  let imperativ = {};
  const impTable = findTableByUrlKey(html, '/imperativ/');
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
