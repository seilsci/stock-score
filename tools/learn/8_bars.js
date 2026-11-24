// 매매일지 차트용 월봉: trades.json에 나온 종목만 종가를 모아 bars.json으로 저장
//   data/raw2에 있으면 그걸 쓰고, 없으면 야후에서 받음(period1=2000&interval=1mo)
//   형식: { "_s": 6, "종목키": [ym, 시가, 고가, 저가, 종가, 거래량, ym, ...] }  (월 순서대로, _s = 한 달당 값 개수 6. 5(거래량 없음)·2(종가만, [ym, 종가, ...])는 옛 형식. 옛 형식은 _s 없이 [ym, 종가, ...] 2개씩)
//   단독 실행:  node tools/learn/8_bars.js     (7_backtest.js 끝에서도 자동 실행)
const { fs, path, DATA, RAW, getJSON, pool, yahooMonthly } = require('./common');
const file = y => path.join(RAW, y.replace(/[^A-Za-z0-9.\-]/g, '_') + '.json');
const j = JSON.parse(fs.readFileSync(path.join(DATA, 'trades.json')));
const keys = new Set(j.trades.map(t => t.y));
Object.values(j.snapshots).forEach(h => h.forEach(x => keys.add(x.y)));
try { Object.values(JSON.parse(fs.readFileSync(path.join(DATA, 'ledger.json'))).months).forEach(m => (m.cands || []).forEach(c => keys.add(c.y))); } catch (e) {}   // 장부의 후보 종목(못 사면 대체하는 종목)도 월봉이 있어야 시작 시점 재계산이 됨
const out = { _s: 6 };
let local = 0, net = 0, miss = 0;
const sig = v => +(+v).toPrecision(9);
// 2006년 이전 월봉은 쓰지 않음(신호는 2008-12 이후, 10이평·36~84개월 차트에 충분, 파일 크기)
const sig5 = v => +(+v).toPrecision(5);        // 시가·고가·저가는 차트에 그리기만 해서 5자리면 충분(파일 크기)        // 9자리: 매매일지 "시작 시점 바꾸기"가 가격으로 현금·수량을 다시 계산하므로 반올림 오차가 거의 없게

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
    out[y] = m.filter(x => x[0] >= 200601).flatMap(x => [x[0], sig5(x[1] || x[4]), sig5(Math.max(x[2] || 0, x[1] || 0, x[4])), sig5(Math.min(x[3] || Infinity, x[1] || Infinity, x[4])), sig(x[4]), Math.round(+(+x[5] || 0).toPrecision(3))]);
  }, '차트 월봉');
  fs.writeFileSync(path.join(DATA, 'bars.json'), JSON.stringify(out));
  console.log(`\n차트 월봉: 종목 ${keys.size}개 중 저장 ${Object.keys(out).length - 1} (raw2 ${local}, 새로 받음 ${net}, 없음 ${miss}) → ${path.join(DATA, 'bars.json')}`);
})();
