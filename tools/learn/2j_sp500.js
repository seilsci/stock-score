// S&P500 편입일·업종(미국): 위키백과 "List of S&P 500 companies" 표 → data/sp500.json  { 종목: { added: "YYYY-MM-DD"|"", sector: "Information Technology" } }
//   현재 편입 종목만 들어 있음(과거에 빠진 종목은 없음). added = 지수에 들어간 날 → 그 날짜 이전에는 아직 편입 전이었다는 뜻(미래 편입 종목이 과거에 더 올랐을 가능성을 보는 시험용).
//   키 없음. 실행: node 2j_sp500.js  (한 번에 끝남)
const { fs, path, DATA } = require('./common');
const strip = h => h.replace(/<sup[\s\S]*?<\/sup>/g, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#160;|&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
function parseTable(html) {                       // 첫 번째 위키표(constituents)에서 Symbol · GICS Sector · Date added 열 찾기
  const t = (html.match(/<table[^>]*wikitable[^>]*>[\s\S]*?<\/table>/) || [])[0];
  if (!t) return null;
  const rows = [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[1]);
  const head = [...rows[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(m => strip(m[1]).toLowerCase());
  const iS = head.findIndex(h => h.startsWith('symbol') || h.startsWith('ticker')), iG = head.findIndex(h => h.includes('gics sector')), iD = head.findIndex(h => h.startsWith('date added'));
  if (iS < 0) return null;
  const out = {};
  rows.slice(1).forEach(r => {
    const c = [...r.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(m => strip(m[1]));
    const sym = (c[iS] || '').toUpperCase(); if (!sym) return;
    const d = (c[iD] || '').match(/\d{4}-\d{2}-\d{2}/);
    out[sym] = { added: d ? d[0] : '', sector: iG >= 0 ? (c[iG] || '') : '' };
  });
  return out;
}
module.exports = { parseTable };
if (require.main === module) (async () => {
  const r = await fetch('https://en.wikipedia.org/w/api.php?action=parse&page=List_of_S%26P_500_companies&prop=text&format=json', { headers: { 'User-Agent': 'stock-score-research (personal research script)' }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json(), res = parseTable(j.parse.text['*']);
  if (!res || !Object.keys(res).length) throw new Error('표를 못 찾음(위키 형식이 바뀐 듯) — 이 메시지를 Claude에게 알려 주세요');
  fs.writeFileSync(path.join(DATA, 'sp500.json'), JSON.stringify(res));
  const n = Object.keys(res).length, nd = Object.values(res).filter(x => x.added).length;
  console.log(`S&P500: ${n}종목 · 편입일 있는 ${nd}종목 · 업종 있는 ${Object.values(res).filter(x => x.sector).length}종목 → data/sp500.json`);
})();
