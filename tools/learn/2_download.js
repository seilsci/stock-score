// 1단계-2: 야후 월봉(최대 기간) 받기 → data/raw/*.json  (이미 받은 건 건너뜀: 끊겨도 다시 돌리면 이어서)
const { fs, path, DATA, getJSON, pool, yahooMonthly } = require('./common');
const list = JSON.parse(fs.readFileSync(path.join(DATA, 'lists.json')));
const IDX = ['^KS11', '^KQ11', '^GSPC', '^IXIC'];   // 코스피·코스닥·S&P500·나스닥 지수
const items = IDX.map(y => ({ y })).concat(list);
const file = y => path.join(DATA, 'raw', y.replace(/[^A-Za-z0-9.\-]/g, '_') + '.json');
let ok = 0, skip = 0, none = 0, fail = 0;
(async () => {
  await pool(items, +process.env.CONC || 6, async s => {
    const f = file(s.y);
    if (fs.existsSync(f)) { skip++; return; }
    try {
      const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s.y)}?range=max&interval=1mo`);
      const m = yahooMonthly(j);
      fs.writeFileSync(f, JSON.stringify(m || []));
      m && m.length ? ok++ : none++;
    } catch (e) { fail++; }
  }, '월봉');
  console.log(`월봉: 새로 ${ok}, 이미 있음 ${skip}, 데이터 없음 ${none}, 실패 ${fail}` + (fail ? ' → 다시 실행하면 실패한 것만 받음' : ''));
})();
