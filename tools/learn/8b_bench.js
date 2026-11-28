// 비교용 지수 월봉 → bench.json  { ks: {YYYYMM: 종가}, sp: {...}, nq: {...} }
//   ks = 코스피(^KS11), sp = S&P 500(^GSPC, SPY 같은 ETF가 따라가는 지수), nq = 나스닥 100(^NDX, QQQ가 따라가는 지수)
//   data/raw2에 있으면 쓰고 없으면 야후에서 받음. 매매일지가 "같은 입금으로 지수를 적립했다면"을 계산하는 데 씀(수수료·세금 제외).
//   (2026-11-28) ks·sp·nq는 이제 **배당 포함(TR)** 값: sp=^SP500TR, nq=QQQ 수정종가(나스닥100 TR 대용, 보수 연 0.2%), ks=KODEX 200(069500.KS) 수정종가(2007-01~; 그 전은 ^KS11 가격을 이어 붙임 → 2005~2006은 배당 빠짐). 가격 지수는 ksP·spP·nqP로 따로 저장.
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
  // 배당 포함(TR) 지수: 야후 수정종가. 실패하면 가격 지수를 그대로 둠(그때는 TR이 아님)
  const adjSeries = async y => { const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?period1=946684800&period2=${Math.floor(Date.now() / 1000) + 86400}&interval=1mo`); const c = j.chart.result[0], adj = (c.indicators.adjclose || [{}])[0].adjclose || c.indicators.quote[0].close, o = {}; c.timestamp.forEach((ts, i) => { const d = new Date(ts * 1000 + 9 * 3600e3), v = adj[i]; if (v > 0) o[d.getUTCFullYear() * 100 + d.getUTCMonth() + 1] = v; }); return o; };
  const from = +process.env.BENCH_FROM || 201101, trOut = {};
  try {
    const sp = await adjSeries('^SP500TR'), nq = await adjSeries('QQQ'), kd = await adjSeries('069500.KS');
    const kp = {}; Object.assign(kp, out.ks);                                                    // ^KS11 가격(from 이후)
    const kdm = Object.keys(kd).map(Number).sort((x, y) => x - y), mi = m => Math.floor(m / 100) * 12 + (m % 100);
    let k0 = kdm[kdm.length - 1]; for (let i = kdm.length - 1; i > 0; i--) { if (mi(kdm[i]) - mi(kdm[i - 1]) !== 1) break; k0 = kdm[i - 1]; }      // KODEX 200은 2007-02~2009-02 자료가 비어 있음 → 끊김 없이 이어진 가장 이른 달부터만 쓰고 그 전은 ^KS11 가격으로 이어 붙임
    const ratio = kd[k0] / (out.ks[k0] || kp[k0]);   // KODEX 200 첫 달에 가격 지수를 맞춰 이어 붙임
    const ks = {}; Object.keys(out.ks).forEach(m => { if (+m < k0) ks[m] = sig(out.ks[m] * ratio); }); Object.keys(kd).forEach(m => { if (+m >= from && +m >= k0) ks[m] = sig(kd[m]); });
    const pick = o => { const r = {}; Object.keys(o).forEach(m => { if (+m >= from) r[m] = sig(o[m]); }); return r; };
    trOut.ks = ks; trOut.sp = pick(sp); trOut.nq = pick(nq);
    ['ks', 'sp', 'nq'].forEach(k => { out[k + 'P'] = out[k]; out[k] = trOut[k]; console.log(`${k} TR: ${Object.keys(out[k]).length}개월`); });
  } catch (e) { console.log('TR 지수 받기 실패 — 가격 지수 그대로 씀:', e.message); }
  fs.writeFileSync(path.join(DATA, 'bench.json'), JSON.stringify(out));
})();
