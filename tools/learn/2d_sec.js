// 재무 자료(미국): SEC EDGAR 공시 → data/sec/<종목>.json  (영업이익·매출·순이익·현금·자산·부채·배당)
//   - 키 없음. SEC 규칙: 초당 10건 이하, 요청 머리말(User-Agent)에 알아볼 수 있는 이름. 연락처를 넣으려면 환경변수 SEC_UA="이름 메일" (저장소에는 넣지 않음)
//   - 각 값에 "공시한 날(filed)"을 같이 저장 → fund.js가 신호 시점에 이미 공시된 값만 씀(미래 정보 차단). 정정 공시(재작성)는 각각 따로 남김.
//   - 이미 받은 종목은 건너뜀(끊겨도 다시 돌리면 이어서). 한국은 아직 없음(DART는 다음 단계).
const { fs, path, DATA, pool, sleep, progress } = require('./common');
const UA = process.env.SEC_UA || 'stock-score-research (personal research, no commercial use)';
const DIR = path.join(DATA, 'sec'); fs.mkdirSync(DIR, { recursive: true });
const file = y => path.join(DIR, y.replace(/[^A-Za-z0-9.\-]/g, '_') + '.json');
const TAGS = {                                   // 우리 이름: [SEC us-gaap 항목들(앞에 있을수록 우선)]
  OI: ['OperatingIncomeLoss'],
  REV: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax'],
  NI: ['NetIncomeLoss', 'ProfitLoss'],
  CASH: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'],
  ASSETS: ['Assets'], LIAB: ['Liabilities'],
  DIV: ['PaymentsOfDividendsCommonStock', 'PaymentsOfDividends']
};
async function sec(url, tries = 5) {
  for (let k = 0; k < tries; k++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(40000) });
      if (r.status === 404) return null;
      if (r.status === 403 || r.status === 429) { await sleep(8000 * (k + 1)); continue; }       // 너무 빠르거나 머리말 문제: 쉬었다가 다시
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { await sleep(1500 * (k + 1)); }
  }
  throw new Error('받기 실패');
}
// SEC 응답 → 필요한 값만: { OI: [[끝날, 값, 시작날|null, 공시일, 양식], ...], ... }
function reduce(j) {
  const g = j && j.facts && j.facts['us-gaap']; if (!g) return null;
  const out = {};
  for (const [name, tags] of Object.entries(TAGS)) {
    out[name] = {};
    for (const t of tags) {
      const u = g[t] && g[t].units && g[t].units.USD; if (!u) continue;
      out[name][t] = u.filter(x => x.end && x.filed && Number.isFinite(x.val)).map(x => [x.end, x.val, x.start || null, x.filed, x.form || '']);
    }
  }
  return out;
}
(async () => {
  const list = JSON.parse(fs.readFileSync(path.join(DATA, 'lists.json'))).filter(s => s.mk === 'US');
  let map = {};
  const m = await sec('https://www.sec.gov/files/company_tickers.json');
  Object.values(m || {}).forEach(x => { map[String(x.ticker).toUpperCase()] = String(x.cik_str).padStart(10, '0'); });
  let ok = 0, skip = 0, none = 0, fail = 0;
  await pool(list, +process.env.CONC || 3, async s => {
    const f = file(s.y);
    if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < 20 * 86400000) { skip++; return; }     // 최근 20일 안에 받은 것은 건너뜀(새 공시는 가끔 갱신)
    const cik = map[String(s.code || s.y).toUpperCase()] || map[String(s.y).toUpperCase()];
    if (!cik) { fs.writeFileSync(f, '{}'); none++; return; }
    try {
      const j = await sec(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
      const r = reduce(j);
      if (!r) { fs.writeFileSync(f, '{}'); none++; } else { fs.writeFileSync(f, JSON.stringify({ cik, f: r })); ok++; }
    } catch (e) { fail++; }
    await sleep(130);                                                    // 초당 10건 이하로
  }, '재무 공시');
  console.log(`재무 공시(SEC): 새로 ${ok}, 이미 있음 ${skip}, 자료 없음 ${none}, 실패 ${fail}` + (fail ? ' → 다시 실행하면 실패한 것만 이어서 받음' : ''));
})();
