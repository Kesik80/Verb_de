module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { w } = req.query;
  if (!w) return res.status(400).json({ error: 'Параметр w обязателен' });

  const url = `https://www.verbformen.ru/spryazhenie/?w=${encodeURIComponent(w)}`;

  let html;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,de;q=0.8',
        'Referer': 'https://www.verbformen.ru/',
      }
    });
    if (!r.ok) return res.status(502).json({ error: `verbformen.ru ответил ${r.status}` });
    html = await r.text();
  } catch (e) {
    return res.status(502).json({ error: `Сеть: ${e.message}` });
  }

  try {
    const data = parse(html, w);
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({
      error: `Парсинг: ${e.message}`,
      htmlSnippet: html.slice(0, 1000)
    });
  }
};

function stripTags(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&shy;/g, '')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
    .replace(/\s+/g, ' ')
    .trim();
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
  if (ts === -1 || ts - idx > 2000) return null;
  const te = html.indexOf('</table>', ts);
  if (te === -1) return null;
  return html.slice(ts, te + 8);
}

const PRONOUN_MAP = {
  'ich': 'ich', 'du': 'du',
  'er': 'er/sie/es', 'sie': 'er/sie/es', 'es': 'er/sie/es',
  'er/sie/es': 'er/sie/es',
  'wir': 'wir', 'ihr': 'ihr',
  'sie/sie': 'sie/Sie',
};

function parseConjTable(tableHtml) {
  const result = {};
  for (const row of tableRows(tableHtml)) {
    if (row.length < 2) continue;
    const key = PRONOUN_MAP[row[0].toLowerCase().replace(/\s+/g, '')];
    if (key) result[key] = row[1];
  }
  return result;
}

function parse(html, word) {
  let infinitiv = word;
  const infM = html.match(/class="[^"]*vInf[^"]*"[^>]*>([^<]{2,30})</);
  if (infM) infinitiv = infM[1].trim();

  let hauptformen = { praesens_3sg: '', praeteritum_3sg: '', partizip2: '' };
  const hfM = html.match(/class="[^"]*rInf[^"]*"[^>]*>([\s\S]{1,300}?)<\/p>/);
  if (hfM) {
    const parts = stripTags(hfM[1]).split('·').map(s => s.trim()).filter(Boolean);
    hauptformen = {
      praesens_3sg: parts[0] || '',
      praeteritum_3sg: parts[1] || '',
      partizip2: parts[2] || ''
    };
  }

  let bedeutung = '';
  const bM = html.match(/class="[^"]*vMng[^"]*"[^>]*>([\s\S]{1,200}?)<\//);
  if (bM) bedeutung = stripTags(bM[1]);

  let hilfsverb = 'haben';
  if (/hilfsverb[^<]{0,50}sein/i.test(html)) hilfsverb = 'sein';

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
      if (p === 'du') imperativ['du'] = row[1];
      else if (p === 'ihr') imperativ['ihr'] = row[1];
      else if (p === 'sie') imperativ['Sie'] = row[1];
    }
  }

  const beispiele = [];
  const bspRe = /class="[^"]*\bbsp\b[^"]*"[^>]*>([\s\S]{5,200}?)<\//g;
  let bm;
  while ((bm = bspRe.exec(html)) !== null && beispiele.length < 3) {
    const t = stripTags(bm[1]);
    if (t.length > 5 && !beispiele.includes(t)) beispiele.push(t);
  }

  return {
    infinitiv, hauptformen, bedeutung, hilfsverb,
    tenses, imperativ, beispiele,
    source: `https://www.verbformen.ru/spryazhenie/?w=${encodeURIComponent(word)}`
  };
}
