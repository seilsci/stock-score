// 비교용 지수 월봉 → bench.json  { ks: {YYYYMM: 종가}, sp: {...}, nq: {...} }
//   ks = 코스피(^KS11), sp = S&P 500(^GSPC, SPY 같은 ETF가 따라가는 지수), nq = 나스닥 100(^NDX, QQQ가 따라가는 지수)
//   data/raw2에 있으면 쓰고 없으면 야후에서 받음. 매매일지가 "같은 입금으로 지수를 적립했다면"을 계산하는 데 씀(배당·수수료·세금 제외).
const { fs, path, DATA, RAW, getJSON, yahooMonthly } = require('./common');
const SYM = { ks: '^KS11', sp: '^GSPC', nq: '^NDX' };
const file = y => path.join(RAW, y.replace(/[^A-Za-z0-9.\-]/g, '_') + '.json');
const sig = v => +(+v).toPrecision(8);
(async () => {
  const out = {};
  for (const [k, y] of Object.entries(SYM)) {
    let m = null; try { m = JSON.parse(fs.readFileSync(file(y))); } catch (e) {}
    if (!m || !m.length) {
      try { m = yahooMonthly(await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?period1=946684800&period2=${Math.floor(Date.now() / 1000) + 86400}&interval=1mo`)); if (m && m.length) fs.writeFileSync(file(y), JSON.stringify(m)); } catch (e) { m = null; }
    }
    out[k] = {}; (m || []).forEach(b => { if (b[0] >= (+process.env.BENCH_FROM || 201101) && b[4] > 0) out[k][b[0]] = sig(b[4]); });
    console.log(`${k} (${y}): ${Object.keys(out[k]).length}개월`);
  }
  fs.writeFileSync(path.join(DATA, 'bench.json'), JSON.stringify(out));
})();
