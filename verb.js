export default async function handler(req, res) {
  // CORS
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
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ru,de;q=0.9',
        'Referer': 'https://www.verbformen.ru/',
      }
    });
    if (!r.ok) return res.status(502).json({ error: `verbformen.ru вернул ${r.status}` });
    html = await r.text();
  } catch (e) {
    return res.status(502).json({ error: `Не удалось получить страницу: ${e.message}` });
  }

  try {
    const data = parse(html, w);
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: `Ошибка парсинга: ${e.message}`, raw: html.slice(0, 500) });
  }
}

function text(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c)).trim();
}

function between(str, open, close, from = 0) {
  const s = str.indexOf(open, from);
  if (s === -1) return null;
  const e = str.indexOf(close, s + open.length);
  if (e === -1) return null;
  return { val: str.slice(s + open.length, e), end: e + close.length };
}

function extractCells(tableHtml) {
  const cells = [];
  let pos = 0;
  while (true) {
    // find td or th
    const td = tableHtml.indexOf('<td', pos);
    const th = tableHtml.indexOf('<th', pos);
    let start = -1;
    let tag = '';
    if (td === -1 && th === -1) break;
    if (td === -1) { start = th; tag = 'th'; }
    else if (th === -1) { start = td; tag = 'td'; }
    else if (td < th) { start = td; tag = 'td'; }
    else { start = th; tag = 'th'; }

    const closeTag = `</${tag}>`;
    const e = tableHtml.indexOf(closeTag, start);
    if (e === -1) break;
    const inner = tableHtml.slice(start, e + closeTag.length);
    cells.push(text(inner));
    pos = e + closeTag.length;
  }
  return cells;
}

function extractTableByHeading(html, heading) {
  // Find section by h2/h3 containing heading text
  const idx = html.indexOf(heading);
  if (idx === -1) return null;
  const tableStart = html.indexOf('<table', idx);
  const tableEnd = html.indexOf('</table>', tableStart);
  if (tableStart === -1 || tableEnd === -1) return null;
  return html.slice(tableStart, tableEnd + '</table>'.length);
}

function parseConjTable(tableHtml) {
  // Rows: pronoun | sg | pl  or  pronoun | form
  const rows = {};
  let pos = 0;
  while (true) {
    const trStart = tableHtml.indexOf('<tr', pos);
    if (trStart === -1) break;
    const trEnd = tableHtml.indexOf('</tr>', trStart);
    if (trEnd === -1) break;
    const rowHtml = tableHtml.slice(trStart, trEnd + '</tr>'.length);
    const cells = extractCells(rowHtml);
    pos = trEnd + '</tr>'.length;
    if (cells.length >= 2) {
      const pronoun = cells[0];
      if (pronoun && pronoun.match(/^(ich|du|er|wir|ihr|sie|Sie|er\/sie\/es|er\s*\/\s*sie\s*\/\s*es)$/i)) {
        rows[pronoun] = cells[1];
      }
    }
  }
  return rows;
}

const PRONOUNS = ['ich', 'du', 'er/sie/es', 'wir', 'ihr', 'sie/Sie'];

function normalizeConj(raw) {
  // Map whatever pronouns were found to standard set
  const result = {};
  for (const [k, v] of Object.entries(raw)) {
    const kl = k.toLowerCase().replace(/\s+/g, '');
    if (kl === 'ich') result['ich'] = v;
    else if (kl === 'du') result['du'] = v;
    else if (kl.startsWith('er')) result['er/sie/es'] = v;
    else if (kl === 'wir') result['wir'] = v;
    else if (kl === 'ihr') result['ihr'] = v;
    else if (kl === 'sie' || kl === 'sie/sie') result['sie/Sie'] = v;
  }
  return result;
}

function parse(html, word) {
  // 1. Infinitiv
  let infinitiv = word;
  const infMatch = html.match(/class="[^"]*vInf[^"]*"[^>]*>([^<]+)</);
  if (infMatch) infinitiv = infMatch[1].trim();

  // 2. Hauptformen  (ist · war · ist gewesen)
  let hauptformen = { praesens_3sg: '', praeteritum_3sg: '', partizip2: '' };
  // verbformen.ru shows them in .rInf or in a special box
  const hfMatch = html.match(/class="[^"]*rInf[^"]*"[^>]*>([\s\S]*?)<\/p>/);
  if (hfMatch) {
    const hfText = text(hfMatch[1]);
    const parts = hfText.split('·').map(s => s.trim()).filter(Boolean);
    if (parts[0]) hauptformen.praesens_3sg = parts[0];
    if (parts[1]) hauptformen.praeteritum_3sg = parts[1];
    if (parts[2]) hauptformen.partizip2 = parts[2];
  }

  // 3. Bedeutung
  let bedeutung = '';
  const bMatch = html.match(/class="[^"]*vMng[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/);
  if (bMatch) bedeutung = text(bMatch[1]);

  // 4. Hilfsverb
  let hilfsverb = 'haben';
  if (html.includes('Вспомогательный глагол: sein') || html.includes('>sein<') && html.includes('auxiliar')) {
    hilfsverb = 'sein';
  }

  // 5. Find tense sections by searching known German headings on the site
  // verbformen.ru uses section headings like "Präsens", "Präteritum", etc.
  const tenseMap = {
    praesens:        ['Präsens', 'Настоящее время'],
    praeteritum:     ['Präteritum', 'Прошедшее время (Präteritum)'],
    perfekt:         ['Perfekt', 'Прошедшее время (Perfekt)'],
    plusquamperfekt: ['Plusquamperfekt'],
    futur1:          ['Futur I', 'Futur 1'],
    konjunktiv2:     ['Konjunktiv II', 'Konjunktiv 2'],
  };

  const tenses = {};
  for (const [key, headings] of Object.entries(tenseMap)) {
    for (const h of headings) {
      const tableHtml = extractTableByHeading(html, h);
      if (tableHtml) {
        const raw = parseConjTable(tableHtml);
        if (Object.keys(raw).length > 0) {
          tenses[key] = normalizeConj(raw);
          break;
        }
      }
    }
  }

  // 6. Imperativ
  let imperativ = {};
  const impTable = extractTableByHeading(html, 'Imperativ') || extractTableByHeading(html, 'Повелительное наклонение');
  if (impTable) {
    const cells = extractCells(impTable);
    // typically: du | form | — | ihr | form | —  or similar
    for (let i = 0; i < cells.length - 1; i++) {
      if (cells[i].toLowerCase() === 'du') imperativ['du'] = cells[i + 1];
      if (cells[i].toLowerCase() === 'ihr') imperativ['ihr'] = cells[i + 1];
      if (cells[i] === 'Sie') imperativ['Sie'] = cells[i + 1];
    }
  }

  // 7. Beispiele
  const beispiele = [];
  const bspRegex = /class="[^"]*bsp[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/g;
  let bm;
  while ((bm = bspRegex.exec(html)) !== null && beispiele.length < 3) {
    const t = text(bm[1]);
    if (t.length > 5) beispiele.push(t);
  }

  return {
    infinitiv,
    hauptformen,
    bedeutung,
    hilfsverb,
    tenses,
    imperativ,
    beispiele,
    source: `https://www.verbformen.ru/spryazhenie/?w=${encodeURIComponent(word)}`
  };
}
