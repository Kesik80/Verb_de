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
if (req.query.debug === 'vtype') {
// Find all occurrences of правил with surrounding context
const hits = [];
const re = /правил/gi;
let m;
while ((m = re.exec(html)) !== null && hits.length < 20) {
const ctx = html.slice(Math.max(0,m.index-120), m.index+80)
.replace(/\s+/g,' ').trim();
hits.push(ctx);
}
return res.status(200).json({ total_hits: hits.length, hits });
}
try {
return res.status(200).json(parse(html, verb));
} catch (e) {
return res.status(500).json({ error: e.message });
}
};
function strip(s) {
return s.replace(/<[^>]+>/g,'').replace(/&/g,'&').replace(/ /g,' ')
.replace(/­/g,'').replace(/&#(\d+);/g,(_,c)=>String.fromCharCode(+c))
.replace(/·/g,'·').replace(/\s+/g,' ').trim();
}
function formatCell(h) {
  // First remove all HTML tags WITHOUT adding spaces (syllables are split by tags)
  return h
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&shy;/g, '')
    .replace(/&middot;/g, '·')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
    // Remove alternative forms after slash
    .replace(/\/[^\s,]+/g, '')
    // Remove footnote superscripts
    .replace(/[\u2070-\u2079\u00b9\u00b2\u00b3]+/g, '')
    // Remove parentheses with optional spaces inside: (e ) → e
    .replace(/\(\s*([a-z\u00e4\u00f6\u00fc\u00df]*)\s*\)/g, '$1')
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
const rowHtml = tableHtml.slice(rs, re);pos = re + 5;
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
let infinitiv = word;
const infM = html.match(/class="[^"]vInf[^"]"[^>]*>\s*([a-z\xc4\xe4\xd6\xf6\xdc\xfc\xdf][a-z\xc4\xe4\xd6\xf6\xdc\xfc\xdf\s]{1,39}?)\s*</i);
if (infM) infinitiv = infM[1].trim();
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
const niveauM = html.match(/\b(A1|A2|B1|B2|C1|C2)\b/);
const niveau = niveauM ? niveauM[1] : '';
// Most reliable source: <p class="rInf"> block which contains "C2 · правильный · haben"
// This is the verb card badge — exactly what we need, no false positives
const rInfMatch = html.match(/<p[^>]*class="[^"]*rInf[^"]*"[^>]*>([\s\S]{0,300}?)<\/p>/i);
const rInfText = rInfMatch ? rInfMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
// Fallback: paragraph just after <h1> (contains "Спряжение глагола X правильное/неправильное")
const h1ParaMatch = html.match(/<h1[^>]*>[\s\S]{0,200}<\/h1>\s*<p>([\s\S]{0,400}?)<\/p>/i);
const h1ParaText = h1ParaMatch ? h1ParaMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
const searchIn = rInfText + ' ' + h1ParaText;
const unregelmaessig = /неправильн/i.test(searchIn);
const regelmaessig = !unregelmaessig && /правильн/i.test(searchIn);
const verbType = unregelmaessig ? 'unregelm\xe4\xdfig' : (regelmaessig ? 'regelm\xe4\xdfig' : '');
let hilfsverb = 'haben';
const tenseConfig = [
{ key:'praesens', mp3:'indikativ/praesens/' },{ key:'praeteritum', mp3:'indikativ/praeteritum/' },
{ key:'perfekt', mp3:'indikativ/perfekt/' },
{ key:'plusquamperfekt', mp3:'indikativ/plusquamperfekt/' },
{ key:'futur1', mp3:'indikativ/futur1/' },
{ key:'konjunktiv2', mp3:'konjunktiv/praeteritum/' },
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
const p3  = strip(tenses.praesens?.['er/sie/es'] || '');
const pt3 = strip(tenses.praeteritum?.['er/sie/es'] || '');
const pf3 = strip(tenses.perfekt?.['er/sie/es'] || '');
const rInfStr = [p3, pt3, pf3].filter(Boolean).join(' \xb7 ');
const hauptformen = { praesens_3sg: p3, praeteritum_3sg: pt3, partizip2: pf3 };
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
if (dataRows[0]) imperativ['du']  = dataRows[0][1];if (dataRows[2]) imperativ['ihr'] = dataRows[2][1];
if (dataRows[3]) imperativ['Sie'] = dataRows[3][1];
}
const mp3s = {};
const mp3Segs = {
praesens:    'indikativ/praesens/',
praeteritum: 'indikativ/praeteritum/',
perfekt:     'indikativ/perfekt/',
konjunktiv2: 'konjunktiv/praeteritum/',
};
for (const [key, seg] of Object.entries(mp3Segs)) {
const url = findMp3(html, seg);
if (url) mp3s[key] = url;
}
mp3s.infinitiv = findMp3(html, '/konjugation/infinitiv/') ||
findMp3(html, 'konjugation/infinitiv1/') ||
findMp3(html, 'konjugation/infinitiv2/') || '';
mp3s.stammformen = findMp3(html, 'konjugation/stammformen/') || '';
const beispiele = [];
const bspRe = /class="[^"]\bbsp\b[^"]"[^>]*>([\s\S]{5,300}?)<\/div/g;
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