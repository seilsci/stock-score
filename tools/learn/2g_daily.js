// 일봉 내려받기(백테스트 전용) → data/daily/<종목>.json.gz  {d:[YYYYMMDD,...], l:[저가,...], c:[종가,...]}
//   종목 목록 = data/events.csv의 종목(후보가 될 수 있는 종목). 이미 받은 종목은 건너뜀(이어받기, 25일 넘은 파일은 새로 받음). 초당 약 5건, 전체 약 10~20분.
//   일봉 판단 시험(묶음 16)이 씀: 보유 중 일 단위 손절·일봉 이평 이탈. 용량은 종목당 수십 KB(압축).
//   실행: node 2g_daily.js   (DAILY_MAX=숫자로 앞에서 몇 개만도 가능)
const zlib = require('zlib');
const { fs, path, DATA, getJSON, sleep } = require('./common');
const DIR = path.join(DATA, 'daily');
fs.mkdirSync(DIR, { recursive: true });
const file = y => path.join(DIR, y.replace(/[^A-Za-z0-9.\-]/g, '_') + '.json.gz');
const r4 = x => Math.round(x * 10000) / 10000;
(async () => {
  const lines = fs.readFileSync(path.join(DATA, 'events.csv'), 'utf8').split('\n'), h = lines[0].split(','), iy = h.indexOf('y');
  const syms = [...new Set(lines.slice(1).map(l => l.split(',')[iy]).filter(Boolean))];
  const P2 = Math.floor(Date.now() / 1000) + 86400, max = +process.env.DAILY_MAX || Infinity;
  let done = 0, got = 0, fail = 0, skip = 0, none = 0, idx = 0;
  const todo = syms.filter(y => { const f = file(y); if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < 25 * 86400000) { skip++; return false; } return true; }).slice(0, max);
  const worker = async () => {
    while (idx < todo.length) {
      const y = todo[idx++];
      try {
        const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?period1=1199145600&period2=${P2}&interval=1d`);
        const r = j && j.chart && j.chart.result && j.chart.result[0];
        const D = { d: [], l: [], c: [] };
        if (r && r.timestamp) {
          const off = (r.meta.gmtoffset || 0) + 6 * 3600, q = r.indicators.quote[0];
          r.timestamp.forEach((t, i) => {
            const c = q.close[i]; if (c == null || !(c > 0)) return;
            const d = new Date((t + off) * 1000);
            D.d.push(d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()); D.l.push(r4(q.low[i] > 0 ? q.low[i] : c)); D.c.push(r4(c));
          });
        }
        fs.writeFileSync(file(y), zlib.gzipSync(JSON.stringify(D)));
        D.d.length ? got++ : none++;
      } catch (e) { fail++; }
      done++;
      if (done % 100 === 0) console.log(`일봉 받기 ${done + skip}/${syms.length} (새로 ${got}, 자료 없음 ${none}, 실패 ${fail}, 이미 있음 ${skip})`);
      await sleep(100);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  console.log(`끝: 전체 ${syms.length}종목 · 새로 ${got} · 자료 없음 ${none} · 실패 ${fail} · 이미 있음 ${skip}` + (fail ? ' → 다시 실행하면 실패한 것만 이어서 받음' : ''));
})();
