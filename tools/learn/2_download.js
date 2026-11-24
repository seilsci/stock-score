// 1단계-2: 야후 월봉(최대 기간) 받기 → data/raw/*.json  (이미 받은 건 건너뜀: 끊겨도 다시 돌리면 이어서)
const { fs, path, DATA, RAW, getJSON, pool, yahooMonthly, gapBad } = require('./common');
const list = JSON.parse(fs.readFileSync(path.join(DATA, 'lists.json')));
const IDX = ['^KS11', '^KQ11', '^GSPC', '^IXIC'];   // 코스피·코스닥·S&P500·나스닥 지수
const items = IDX.map(y => ({ y })).concat(list);
const file = y => path.join(RAW, y.replace(/[^A-Za-z0-9.\-]/g, '_') + '.json');
let ok = 0, skip = 0, none = 0, fail = 0, gap = 0;
const P2 = Math.floor(Date.now() / 1000) + 86400;      // 오늘까지. 기간을 직접 정해야 야후가 월봉으로 줌(range=max는 오래된 종목을 3개월 간격으로 줌)
(async () => {
  await pool(items, +process.env.CONC || 6, async s => {
    const f = file(s.y);
    if (fs.existsSync(f)) { skip++; return; }
    try {
      const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s.y)}?period1=946684800&period2=${P2}&interval=1mo`);
      const m = yahooMonthly(j);
      if (m && gapBad(m) > 0.1) { gap++; fs.writeFileSync(f, '[]'); return; }      // 월 간격이 아니면 쓰지 않음(빈 파일로 표시)
      fs.writeFileSync(f, JSON.stringify(m || []));
      m && m.length ? ok++ : none++;
    } catch (e) { fail++; }
  }, '월봉');
  console.log(`월봉: 새로 ${ok}, 이미 있음 ${skip}, 데이터 없음 ${none}, 실패 ${fail}, 월 간격 이상이라 제외 ${gap}` + (fail ? ' → 다시 실행하면 실패한 것만 받음' : ''));
})();
