// 1단계-1: 종목 목록 (네이버 시총 순) → data/lists.json
const { fs, path, DATA, getJSON } = require('./common');
const num = s => +String(s || '').replace(/[^0-9.]/g, '') || 0;
// 학습 대상 범위 = 사이트(apps-script/Code.gs의 KOSPI_N·KOSDAQ_N·US_N)와 같게 유지: 코스피 300 + 코스닥 200 + 미국 500 (시총 순)
// 넓게 보려면 WIDE=1 (한국 전 종목 + 미국 3000). 개수는 KOSPI_N·KOSDAQ_N·US_N 환경변수로도 바꿀 수 있음
const WIDE = process.env.WIDE === '1';
const KOSPI_N = +process.env.KOSPI_N || (WIDE ? 99999 : 300);
const KOSDAQ_N = +process.env.KOSDAQ_N || (WIDE ? 99999 : 200);
const US_N = +process.env.US_N || (WIDE ? 3000 : 500);

// 제외 종목: 채권·금리·머니마켓 등 가격이 거의 안 움직이는 상품, 레버리지·인버스(음의 복리). apps-script/Code.gs의 EXCLUDE_RE와 같게 유지
const EXCLUDE = /채권|국채|국고채|회사채|특수은행채|금융채|국공채|통안채|크레딧|하이일드|단기자금|금리|머니마켓|레버리지|인버스|곱버스|\b[23]X\b|1\.5X/;

const EXCLUDE_US = /Muni|Municipal|Bond Trust|(Fund|Fd|Closed).*(High Yield|High Income|Floating Rate|Credit|Loan|Treasury|Mortgage|Duration|Preferred|Income Solutions|Dynamic Income|Corporate & Income|Multi-Sector|Core Bond)|(High Yield|High Income|Floating Rate|Credit|Loan|Treasury|Preferred|Income Solutions|Dynamic Income|Corporate & Income|Multi-Sector|Core Bond).*(Fund|Fd|Closed)/i;      // 미국: 채권·지방채·우선주 중심 폐쇄형 펀드 제외(apps-script/Code.gs EXCLUDE_US_RE와 같게 유지)

async function pages(base) {
  const first = await getJSON(base + 'page=1&pageSize=100');
  const n = Math.ceil(first.totalCount / 100), out = [first];
  for (let p = 2; p <= n; p++) out.push(await getJSON(base + `page=${p}&pageSize=100`));
  return out.flatMap(d => (d && d.stocks) || []);
}
(async () => {
  const kr = [], us = [];
  for (const m of ['KOSPI', 'KOSDAQ'])
    (await pages(`https://m.stock.naver.com/api/stocks/marketValue/${m}?`)).filter(x => !EXCLUDE.test(x.stockName)).forEach(x =>
      kr.push({ mk: m, code: x.itemCode, name: x.stockName, type: x.stockEndType, cap: num(x.marketValue),
                y: x.itemCode + (m === 'KOSPI' ? '.KS' : '.KQ') }));
  for (const ex of ['NASDAQ', 'NYSE', 'AMEX'])
    (await pages(`https://api.stock.naver.com/stock/exchange/${ex}/marketValue?`)).filter(x => !EXCLUDE_US.test(x.stockName)).forEach(x =>
      us.push({ mk: 'US', code: x.symbolCode, name: x.stockName, type: x.stockEndType || 'stock',
                cap: num(x.marketValue), y: String(x.symbolCode).replace(/\s+/g, '-') }));
  try { const E = JSON.parse(fs.readFileSync(path.join(__dirname, 'us_etf.json'))); if (process.env.US_ETF !== '0') E.etfs.forEach(e => us.push({ mk: 'US', code: e.y, name: e.name, type: 'etf', cap: e.cap, y: e.y })); } catch (e) { console.error('us_etf.json 없음: 미국 ETF 없이 진행(node 1b_us_etf.js로 만들 수 있음)'); }      // 미국 ETF(순자산을 시총처럼 순위에 넣음, 끄려면 US_ETF=0)
  kr.sort((a, b) => b.cap - a.cap); us.sort((a, b) => b.cap - a.cap);
  const krSel = kr.filter(x => x.mk === 'KOSPI').slice(0, KOSPI_N).concat(kr.filter(x => x.mk === 'KOSDAQ').slice(0, KOSDAQ_N));
  const list = krSel.concat(us.slice(0, US_N));
  const LIMIT = +process.env.LIMIT || 0;      // 시험용: 앞에서 N개만
  const out = LIMIT ? kr.slice(0, LIMIT / 2).concat(us.slice(0, LIMIT / 2)) : list;
  fs.writeFileSync(path.join(DATA, 'lists.json'), JSON.stringify(out));
  console.log(`목록(${WIDE ? '넓은 범위' : '사이트와 같은 범위'}): 한국 ${krSel.length}개(코스피 ${Math.min(kr.filter(x => x.mk === 'KOSPI').length, KOSPI_N)} + 코스닥 ${Math.min(kr.filter(x => x.mk === 'KOSDAQ').length, KOSDAQ_N)}), 미국 ${Math.min(us.length, US_N)}개 → ${out.length}종목`);
})().catch(e => { console.error(e); process.exit(1); });
