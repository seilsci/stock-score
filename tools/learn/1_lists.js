// 1단계-1: 종목 목록 (네이버 시총 순) → data/lists.json
const { fs, path, DATA, getJSON } = require('./common');
const num = s => +String(s || '').replace(/[^0-9.]/g, '') || 0;
const US_N = +process.env.US_N || 3000;      // 미국은 시총 상위 N개만
const KR_N = +process.env.KR_N || 99999;     // 한국은 전부

async function pages(base) {
  const first = await getJSON(base + 'page=1&pageSize=100');
  const n = Math.ceil(first.totalCount / 100), out = [first];
  for (let p = 2; p <= n; p++) out.push(await getJSON(base + `page=${p}&pageSize=100`));
  return out.flatMap(d => (d && d.stocks) || []);
}
(async () => {
  const kr = [], us = [];
  for (const m of ['KOSPI', 'KOSDAQ'])
    (await pages(`https://m.stock.naver.com/api/stocks/marketValue/${m}?`)).forEach(x =>
      kr.push({ mk: m, code: x.itemCode, name: x.stockName, type: x.stockEndType, cap: num(x.marketValue),
                y: x.itemCode + (m === 'KOSPI' ? '.KS' : '.KQ') }));
  for (const ex of ['NASDAQ', 'NYSE', 'AMEX'])
    (await pages(`https://api.stock.naver.com/stock/exchange/${ex}/marketValue?`)).forEach(x =>
      us.push({ mk: 'US', code: x.symbolCode, name: x.stockName, type: x.stockEndType || 'stock',
                cap: num(x.marketValue), y: String(x.symbolCode).replace(/\s+/g, '-') }));
  kr.sort((a, b) => b.cap - a.cap); us.sort((a, b) => b.cap - a.cap);
  const list = kr.slice(0, KR_N).concat(us.slice(0, US_N));
  const LIMIT = +process.env.LIMIT || 0;      // 시험용: 앞에서 N개만
  const out = LIMIT ? kr.slice(0, LIMIT / 2).concat(us.slice(0, LIMIT / 2)) : list;
  fs.writeFileSync(path.join(DATA, 'lists.json'), JSON.stringify(out));
  console.log(`목록: 한국 ${kr.length}개 중 ${Math.min(kr.length, KR_N)}, 미국 ${us.length}개 중 ${Math.min(us.length, US_N)} → ${out.length}종목`);
})().catch(e => { console.error(e); process.exit(1); });
