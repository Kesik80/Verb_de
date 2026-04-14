module.exports = async function handler(req, res) {
  // Разрешаем запросы с любых доменов (CORS)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  const { w } = req.query;
  if (!w) return res.status(400).json({ error: 'w required' });
  
  const verb = w.trim().toLowerCase();
  const url = `https://www.verbformen.ru/sprjazhenie/${encodeURIComponent(verb)}.htm`;
  
  let html;
  try {
    // Загружаем страницу с заголовками, чтобы нас не блокировали
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

  // Режим отладки (возвращает сырой текст)
  if (req.query.debug === 'tr') {
    const hits = [];
    const re = /([\u0410-\u042f\u0430-\u044f\u0401\u0451].{10,80})/g;
    let m;
    while ((m = re.exec(html)) !== null && hits.length < 15) {
      const ctx = html.slice(Math.max(0,m.index-80), m.index+100)
        .replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
      hits.push(ctx);
    }
    return res.status(200).json(hits);
  }

  try {
    return res.status(200).json(parse(html, verb));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
};

// Очистка HTML тегов и спецсимволовfunction strip(s) {
  return s.replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/&/g,'&')
    .replace(/­/g,'').replace(/&#(\d+);/g,(_,c)=>String.fromCharCode(+c))
    .replace(/·/g,'·').replace(/\s+/g,' ').trim();
}

// Форматирование ячейки таблицы (УДАЛЕНИЕ СКОБОК И ЛИШНИХ ПРОБЕЛОВ)
function formatCell(h) {
  return h
    // 1. Убираем HTML теги выделения
    .replace(/<u>(.*?)<\/u><\/b>/g,' $1 ')
    .replace(/<u>(.*?)<\/u><\/i><\/b>/g,' $1 ')
    .replace(/<u>(.*?)<\/u>/g,' $1 ')
    .replace(/<b>(.*?)<\/b>/g,' $1 ')
    .replace(/<i>(.*?)<\/i>/g,' $1 ')
    .replace(/<[^>]+>/g,'')
    // 2. Нормализация пробелов и символов
    .replace(/&nbsp;/g,' ').replace(/ &/g,' &').replace(/­/g,'')
    .replace(/&#(\d+);/g,(_,c)=>String.fromCharCode(+c))
    // 3. Убираем сноски и варианты через слэш
    .replace(/\/[^\s,]+/g, '')
    .replace(/[\u2070-\u2079\u00b9\u00b2\u00b3]+/g, '')
    // 4. ГЛАВНОЕ ИСПРАВЛЕНИЕ: Убираем скобки с буквой внутри: geh(e) -> gehe
    .replace(/\(([a-zäöüß]?)\)/gi, '$1')
    // 5. ГЛАВНОЕ ИСПРАВЛЕНИЕ: Убираем пробел перед окончанием: gehe n -> gehen, gehe t -> geht
    // Ищет пробел, за которым идут 1-2 буквы (окончание) в конце строки
    .replace(/\s+([a-zäöüß]{1,2})$/gi, '$1')
    // Убираем разрывы внутри корня, если они остались (ge g ang en -> gegangen)
    .replace(/(\w)\s+(\w)/g, '$1$2')
    .replace(/\s+/g, ' ').trim();
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
  let result = null;  let pos = 0;
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
  }  dataRows.slice(0,6).forEach((cells,i) => { result[SLOT_KEYS[i]] = cells[1]; });
  return result;
}

function parse(html, word) {
  // 1. Infinitiv
  let infinitiv = word;
  const infM = html.match(/class="[^"]*vInf[^"]*"[^>]*>\s*([a-zäöüß][a-zäöüß\s]{1,39}?)\s*</i);
  if (infM) infinitiv = infM[1].trim();

  // 2. Bedeutung (Перевод)
  let bedeutung = '';
  const skipRe = /реклам|сайт|баллов|войти|зарегистр|подписк|аккаунт|пользовател|набер|количеств|претеритум|конъюнктив|императив|перфект|плюсквам|футурум|инфинитив|партицип|упражне|грамматик|правила|переводы|значения|примеры|речевой вывод/i;
  const pronM = html.match(/\/[a-z\u0250-\u02ff\u00e6\u00f8\u0259\u026aː.]+\//);
  if (pronM) {
    const chunk = html.slice(Math.max(0, pronM.index - 1000), pronM.index);
    const cyrBlocks = [...chunk.matchAll(/[а-яёА-ЯЁ][а-яёА-ЯЁ\s,-.]{8,150}/g)];
    for (const b of [...cyrBlocks].reverse()) {
      const t = b[0].trim().replace(/[,\s]+$/, '');
      if (!skipRe.test(t) && t.length > 5) {
        bedeutung = t.slice(0, 120);
        break;
      }
    }
  }

  // 3. Niveau (Уровень)
  const niveauM = html.match(/\b(A1|A2|B1|B2|C1|C2)\b/);
  const niveau = niveauM ? niveauM[1] : '';

  // 4. Tenses (Времена)
  const tenseConfig = [
    { key:'praesens',        mp3:'indikativ/praesens/' },
    { key:'praeteritum',     mp3:'indikativ/praeteritum/' },
    { key:'perfekt',         mp3:'indikativ/perfekt/' },
    { key:'plusquam