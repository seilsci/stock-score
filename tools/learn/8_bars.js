// 매매일지 차트용 월봉: trades.json에 나온 종목만 종가를 모아 bars.json으로 저장
//   data/raw2에 있으면 그걸 쓰고, 없으면 야후에서 받음(period1=2000&interval=1mo)
//   형식: { "종목키": [ym, 종가, ym, 종가, ...] }  (월 순서대로)
//   단독 실행:  node tools/learn/8_bars.js     (7_backtest.js 끝에서도 자동 실행)
const { fs, path, DATA, RAW, getJSON, pool, yahooMonthly } = require('./common');
const file = y => path.join(RAW, y.replace(/[^A-Za-z0-9.\-]/g, '_') + '.json');
const j = JSON.parse(fs.readFileSync(path.join(DATA, 'trades.json')));
const keys = new Set(j.trades.map(t => t.y));
Object.values(j.snapshots).forEach(h => h.forEach(x => keys.add(x.y)));
const out = {};
let local = 0, net = 0, miss = 0;
const sig = v => +(+v).toPrecision(6);        // 6자리로 줄여 파일 크기를 아낌

(async () => {
  await pool([...keys], +process.env.CONC || 6, async y => {
    let m = null;
    try { m = JSON.parse(fs.readFileSync(file(y))); } catch (e) {}
    if (m && m.length) local++;
    if (!m || !m.length) {
      try {
        const P2 = Math.floor(Date.now() / 1000) + 86400;
        m = yahooMonthly(await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?period1=946684800&period2=${P2}&interval=1mo`));
        if (m && m.length) net++;
      } catch (e) { m = null; }
    }
    if (!m || !m.length) { miss++; return; }
    out[y] = m.flatMap(x => [x[0], sig(x[4])]);
  }, '차트 월봉');
  fs.writeFileSync(path.join(DATA, 'bars.json'), JSON.stringify(out));
  console.log(`\n차트 월봉: 종목 ${keys.size}개 중 저장 ${Object.keys(out).length} (raw2 ${local}, 새로 받음 ${net}, 없음 ${miss}) → ${path.join(DATA, 'bars.json')}`);
})();
