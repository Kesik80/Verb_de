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

// Get all tables with stripped text before them (400 chars) and their content
function getAllTables(html) {
  const tables = [];
  let pos = 0;
  while (true) {
    const ts = html.indexOf('<table', pos);
    if (ts === -1) break;
    const te = html.indexOf('</table>', ts);
    if (te === -1) break;
    const before = html.slice(Math.max(0, ts - 400), ts)
      .replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
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

  // Helper: find table whose "before" text ends with one of the markers
  function findByMarker(markers, occurrence = 0) {
    let count = 0;
    for (const t of tables) {
      const tail = t.before.slice(-80); // last 80 chars of context
      for (const m of markers) {
        if (tail.includes(m)) {
          if (count === occurrence) return t.html;
          count++;
          break;
        }
      }
    }
    return null;
  }

  // Infinitiv
  let infinitiv = word;
  const infM = html.match(/class="[^"]*vInf[^"]*"[^>]*>\s*([a-zäöüß][a-zäöüß\s]{1,39}?)\s*</i);
  if (infM) infinitiv = infM[1].trim();

  // Hauptformen from rInf: "ist · war · ist gewesen"
  // There are multiple rInf elements — find the one with verb forms (contains ·)
  // The correct one has German verb forms, not level info like "A1 · неправильный"
  let rInfStr = '';
  const rInfAll = [...html.matchAll(/class="[^"]*rInf[^"]*"[^>]*>([\s\S]{1,600}?)<\/p>/g)];
  for (const m of rInfAll) {
    const s = strip(m[1]);
    const parts = s.split('·').map(p => p.trim()).filter(Boolean);
    // Valid rInf has 3 parts that look like German verb forms (contain lowercase German letters)
    if (parts.length >= 3 && /^[a-zäöüß]/.test(parts[0])) {
      rInfStr = s;
      break;
    }
  }

  // Bedeutung — full Russian meaning from vMng
  let bedeutung = '';
  const bM = html.match(/class="[^"]*vMng[^"]*"[^>]*>([\s\S]{1,600}?)<\/[a-z]/);
  if (bM) bedeutung = strip(bM[1]).replace(/^🇷🇺\s*/, '').replace(/^[^а-яёА-ЯЁa-z]+/, '').trim();

  let hilfsverb = 'haben';

  // Tense config: markers that appear right before the table in "before" text
  // From debug: "Презенс", "Претеритум", "Перфект", "Плюсквам.", "Футурум I", "Конъюнктив II"
  // Präsens and Präteritum appear twice (compact + full) → use occurrence 1
  // Konj II appears twice → use occurrence 1
  // Others appear once in the full section
  const tenseConfig = [
    { key:'praesens',        markers:['Презенс'],       occ:1 },
    { key:'praeteritum',     markers:['Претеритум'],    occ:1 },
    { key:'perfekt',         markers:['Перфект'],       occ:0 },
    { key:'plusquamperfekt', markers:['Плюсквам'],      occ:0 },
    { key:'futur1',          markers:['Футурум I'],     occ:0 },
    { key:'konjunktiv2',     markers:['Конъюнктив II'], occ:1 },
  ];

  const tenses = {};
  for (const {key, markers, occ} of tenseConfig) {
    const t = findByMarker(markers, occ);
    if (t) {
      const conj = parseConjTable(t);
      if (Object.keys(conj).length >= 3) {
        tenses[key] = conj;
        if (key==='perfekt' && conj['ich'] && /^(habe|bin)\b/i.test(conj['ich'])) {
          hilfsverb = /^bin\b/i.test(conj['ich']) ? 'sein' : 'haben';
        }
      }
    }
  }

  // Hauptformen — parse rInf "ist · war · ist gewesen"
  // Split by · and clean
  const rInfParts = rInfStr.split('·').map(s => s.trim()).filter(Boolean);
  const hauptformen = {
    praesens_3sg:    rInfParts[0] || tenses.praesens?.['er/sie/es'] || '',
    praeteritum_3sg: rInfParts[1] || tenses.praeteritum?.['er/sie/es'] || '',
    partizip2:       rInfParts[2] || '',
  };

  // Imperativ — marker "Императив", occurrence 0
  // Row structure from debug: "- sei (du)", "wir seien", "(ihr) seid", "seien Sie"
  // Cells[0] is pronoun hint, cells[1] is form
  // But for machen: "mach (du)", "machen wir", "macht (ihr)", "machen Sie"
  // We need: du→cells[1] of row0, ihr→cells[1] of row2, Sie→cells[1] of row3
  let imperativ = {};
  const impTable = findByMarker(['Императив'], 0);
  if (impTable) {
    const dataRows = [];
    let pos = 0;
    while (true) {
      const rs = impTable.indexOf('<tr', pos);
      if (rs===-1) break;
      const re = impTable.indexOf('</tr>', rs);
      if (re===-1) break;
      const cells = rowCells(impTable.slice(rs,re));
      pos = re+5;
      if (cells.length===2) dataRows.push(cells);
    }
    // 4 rows: du, wir, ihr, Sie
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

  // Level (A1, A2, B1...) and unregelmäßig
  const niveauM = html.match(/\b(A1|A2|B1|B2|C1|C2)\b/);
  const niveau = niveauM ? niveauM[1] : '';
  const unregelmaessig = /unregelmäßig|неправильн/i.test(html);

  return { infinitiv, rInfStr, hauptformen, bedeutung, niveau, hilfsverb, unregelmaessig, tenses, imperativ, beispiele,
    source:`https://www.verbformen.ru/sprjazhenie/${encodeURIComponent(word)}.htm` };
}
