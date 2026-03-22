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

function formatCell(h) {
  return h
    .replace(/<b><u>(.*?)<\/u><\/b>/g,'<span class="vf-stress">$1</span>')
    .replace(/<b><i><u>(.*?)<\/u><\/i><\/b>/g,'<span class="vf-stress">$1</span>')
    .replace(/<u>(.*?)<\/u>/g,'<span class="vf-stress">$1</span>')
    .replace(/<b>(.*?)<\/b>/g,'<span class="vf-bold">$1</span>')
    .replace(/<i>(.*?)<\/i>/g,'<span class="vf-it">$1</span>')
    .replace(/<[^>]+>/g,'')
    .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&shy;/g,'')
    .replace(/&#(\d+);/g,(_,c)=>String.fromCharCode(+c))
    .trim();
}

function findTableAfterMp3(html, mp3key) {
  let result = null;
  let pos = 0;
  while (true) {
    const mp3pos = html.indexOf(mp3key, pos);
    if (mp3pos === -1) break;
    const ts = html.indexOf('<table', mp3pos);
    if (ts !== -1 && ts - mp3pos <= 500) {
      const te = html.indexOf('</table>', ts);
      if (te !== -1) result = html.slice(ts, te + 8);
    }
    pos = mp3pos + 1;
  }
  return result;
}

function findMp3(html, segment) {
  let result = null;
  let pos = 0;
  while (true) {
    const idx = html.indexOf(segment, pos);
    if (idx === -1) break;
    const hrefStart = html.lastIndexOf('href="', idx);
    if (hrefStart !== -1 && idx - hrefStart < 200) {
      const urlEnd = html.indexOf('"', hrefStart + 6);
      const url = html.slice(hrefStart + 6, urlEnd);
      if (url.endsWith('.mp3')) result = url;
    }
    pos = idx + 1;
  }
  return result;
}

const SLOT_KEYS = ['ich','du','er/sie/es','wir','ihr','sie/Sie'];

function parseConjTable(tableHtml) {
  const result = {};
  const dataRows = [];
  let pos = 0;
  while (true) {
    const rs = tableHtml.indexOf('<tr', pos);
    if (rs === -1) break;
    const re = tableHtml.indexOf('</tr>', rs);
    if (re === -1) break;
    const rowHtml = tableHtml.slice(rs, re);
    pos = re + 5;
    const rawCells = [];
    let cp = 0;
    while (true) {
      const td = rowHtml.indexOf('<td', cp);
      if (td === -1) break;
      const tde = rowHtml.indexOf('</td>', td);
      if (tde === -1) break;
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
  dataRows.slice(0,6).forEach((cells,i) => { result[SLOT_KEYS[i]] = cells[1]; });
  return result;
}

function parse(html, word) {
  // Infinitiv
  let infinitiv = word;
  const infM = html.match(/class="[^"]*vInf[^"]*"[^>]*>\s*([a-z\xc4\xe4\xd6\xf6\xdc\xfc\xdf][a-z\xc4\xe4\xd6\xf6\xdc\xfc\xdf\s]{1,39}?)\s*</i);
  if (infM) infinitiv = infM[1].trim();

  // Bedeutung — extract Cyrillic translation list
  let bedeutung = '';
  const cyrM = html.match(/[\u0430-\u044f\u0451\u0410-\u042f\u0401][\u0430-\u044f\u0451\u0410-\u042f\u0401\s\-]{2,25}(?:,\s*[\u0430-\u044f\u0451\u0410-\u042f\u0401][\u0430-\u044f\u0451\u0410-\u042f\u0401\s\-]{2,25}){1,6}/);
  if (cyrM) bedeutung = cyrM[0].slice(0, 120).trim();

  // Niveau
  const niveauM = html.match(/\b(A1|A2|B1|B2|C1|C2)\b/);
  const niveau = niveauM ? niveauM[1] : '';

  // Verb type
  const unregelmaessig = /\u043d\u0435\u043f\u0440\u0430\u0432\u0438\u043b\u044c\u043d/i.test(html);
  const regelmaessig = /\u043f\u0440\u0430\u0432\u0438\u043b\u044c\u043d/i.test(html) && !unregelmaessig;
  const verbType = unregelmaessig ? 'unregelm\xe4\xdfig' : (regelmaessig ? 'regelm\xe4\xdfig' : '');

  let hilfsverb = 'haben';

  // Tenses
  const tenseConfig = [
    { key:'praesens',        mp3:'indikativ/praesens/' },
    { key:'praeteritum',     mp3:'indikativ/praeteritum/' },
    { key:'perfekt',         mp3:'indikativ/perfekt/' },
    { key:'plusquamperfekt', mp3:'indikativ/plusquamperfekt/' },
    { key:'futur1',          mp3:'indikativ/futur1/' },
    { key:'konjunktiv2',     mp3:'konjunktiv/praeteritum/' },
  ];

  const tenses = {};
  for (const {key, mp3} of tenseConfig) {
    const t = findTableAfterMp3(html, mp3);
    if (t) {
      const conj = parseConjTable(t);
      if (Object.keys(conj).length >= 3) {
        tenses[key] = conj;
        if (key === 'perfekt' && conj['ich']) {
          hilfsverb = /^bin\b/i.test(strip(conj['ich'])) ? 'sein' : 'haben';
        }
      }
    }
  }

  // Hauptformen
  const p3  = strip(tenses.praesens?.['er/sie/es'] || '');
  const pt3 = strip(tenses.praeteritum?.['er/sie/es'] || '');
  const pf3 = strip(tenses.perfekt?.['er/sie/es'] || '');
  const rInfStr = [p3, pt3, pf3].filter(Boolean).join(' \xb7 ');
  const hauptformen = { praesens_3sg: p3, praeteritum_3sg: pt3, partizip2: pf3 };

  // Imperativ
  const IMP_SLOTS = ['du','ihr','Sie'];
  let imperativ = {};
  const impT = findTableAfterMp3(html, '/imperativ/');
  if (impT) {
    const dataRows = [];
    let pos = 0;
    while (true) {
      const rs = impT.indexOf('<tr', pos);
      if (rs === -1) break;
      const re = impT.indexOf('</tr>', rs);
      if (re === -1) break;
      const cells = [];
      let cp = 0;
      const rowHtml = impT.slice(rs, re);
      while (true) {
        const td = rowHtml.indexOf('<td', cp);
        if (td === -1) break;
        const tde = rowHtml.indexOf('</td>', td);
        if (tde === -1) break;
        cells.push(strip(rowHtml.slice(td, tde)));
        cp = tde + 5;
      }
      if (cells.length === 2) dataRows.push(cells);
      pos = re + 5;
    }
    if (dataRows[0]) imperativ['du']  = dataRows[0][1];
    if (dataRows[2]) imperativ['ihr'] = dataRows[2][1];
    if (dataRows[3]) imperativ['Sie'] = dataRows[3][1];
  }

  // MP3 URLs
  const mp3s = {};
  const mp3Segs = {
    praesens:   'indikativ/praesens/',
    praeteritum:'indikativ/praeteritum/',
    perfekt:    'indikativ/perfekt/',
    konjunktiv2:'konjunktiv/praeteritum/',
    infinitiv:  'konjugation/infinitiv',
  };
  for (const [key, seg] of Object.entries(mp3Segs)) {
    const url = findMp3(html, seg);
    if (url) mp3s[key] = url;
  }

  // Beispiele
  const beispiele = [];
  const bspRe = /class="[^"]*\bbsp\b[^"]*"[^>]*>([\s\S]{5,300}?)<\//g;
  let bm;
  while ((bm = bspRe.exec(html)) !== null && beispiele.length < 3) {
    const t = strip(bm[1]);
    if (t.length > 5 && !beispiele.includes(t)) beispiele.push(t);
  }

  return {
    infinitiv, rInfStr, hauptformen, bedeutung,
    niveau, verbType, hilfsverb, unregelmaessig,
    tenses, imperativ, beispiele, mp3s,
    source: `https://www.verbformen.ru/sprjazhenie/${encodeURIComponent(word)}.htm`
  };
}
