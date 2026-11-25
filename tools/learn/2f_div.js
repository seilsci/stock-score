// 배당 내려받기(백테스트 전용, 사이트에는 안 씀) → data/div/<종목>.json  [[배당락일(초), 주당 배당금(그 종목 통화)], ...]
//   종목 목록 = data/events.csv의 종목(후보가 될 수 있는 종목). 이미 받은 종목은 건너뜀(이어받기), 초당 약 5건.
//   실행: node 2f_div.js  (DIV_MAX=숫자로 앞에서 몇 개만도 가능)
const { fs, path, DATA, getJSON, sleep } = require('./common');
const DIR = path.join(DATA, 'div');
fs.mkdirSync(DIR, { recursive: true });
const file = y => path.join(DIR, y.replace(/[^A-Za-z0-9.\-]/g, '_') + '.json');
(async () => {
  const lines = fs.readFileSync(path.join(DATA, 'events.csv'), 'utf8').split('\n'), h = lines[0].split(','), iy = h.indexOf('y');
  const syms = [...new Set(lines.slice(1).map(l => l.split(',')[iy]).filter(Boolean))];
  const P2 = Math.floor(Date.now() / 1000) + 86400, max = +process.env.DIV_MAX || Infinity;
  let done = 0, got = 0, fail = 0, skip = 0, idx = 0;
  const todo = syms.filter(y => { if (fs.existsSync(file(y))) { skip++; return false; } return true; }).slice(0, max);
  const worker = async () => {
    while (idx < todo.length) {
      const y = todo[idx++];
      try {
        const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?period1=946684800&period2=${P2}&interval=1mo&events=div`);
        const ev = (j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].events && j.chart.result[0].events.dividends) || {};
        const arr = Object.values(ev).map(d => [d.date, +(+d.amount).toPrecision(6)]).sort((a, b) => a[0] - b[0]);
        fs.writeFileSync(file(y), JSON.stringify(arr)); got++;
      } catch (e) { fail++; }
      done++;
      if (done % 100 === 0) console.log(`배당 받기 ${done + skip}/${syms.length} (새로 ${got}, 실패 ${fail}, 이미 있음 ${skip})`);
      await sleep(100);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  console.log(`끝: 전체 ${syms.length}종목 · 새로 ${got} · 실패 ${fail} · 이미 있음 ${skip}`);
})();
