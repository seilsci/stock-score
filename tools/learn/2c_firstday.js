// 월별 첫 거래일 가격(시가·종가) 받기: 야후 일봉 → data/first/<종목>.json = [[YYYYMM, 시가, 종가], ...]
//   이미 받은 종목은 건너뜀(끊겨도 다시 돌리면 이어서). 이번 달까지 들어 있지 않고 20일 넘게 지난 파일은 새로 받음.
const { fs, path, DATA, getJSON, pool } = require('./common');
const list = JSON.parse(fs.readFileSync(path.join(DATA, 'lists.json')));
const DIR = path.join(DATA, 'first'); fs.mkdirSync(DIR, { recursive: true });
const file = y => path.join(DIR, y.replace(/[^A-Za-z0-9.\-]/g, '_') + '.json');
const now = new Date(), CUR = now.getFullYear() * 100 + now.getMonth() + 1;
const P2 = Math.floor(Date.now() / 1000) + 86400;
let ok = 0, skip = 0, none = 0, fail = 0;
function firstDays(j) {
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp) return null;
  const off = (r.meta.gmtoffset || 0) + 6 * 3600, q = r.indicators.quote[0], by = new Map();
  r.timestamp.forEach((t, i) => {
    const c = q.close[i]; if (c == null) return;
    const d = new Date((t + off) * 1000), ym = d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;
    const p = by.get(ym);
    if (!p || t < p.t) by.set(ym, { t, o: q.open[i] || c, c });       // 그 달에서 가장 이른 날
  });
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([ym, v]) => [ym, v.o, v.c]);
}
(async () => {
  await pool(list, +process.env.CONC || 6, async s => {
    const f = file(s.y);
    if (fs.existsSync(f)) {
      let last = 0; try { const a = JSON.parse(fs.readFileSync(f)); last = a.length ? a[a.length - 1][0] : 0; } catch (e) {}
      const age = Date.now() - fs.statSync(f).mtimeMs;
      if (last >= CUR || age < 20 * 86400000 || last === 0) { skip++; return; }   // 최신이거나, 최근에 받았거나, 자료 없음으로 표시된 종목
    }
    try {
      const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s.y)}?period1=${process.env.FD_P1 || 1199145600}&period2=${P2}&interval=1d`);
      const m = firstDays(j);
      fs.writeFileSync(f, JSON.stringify(m || []));
      m && m.length ? ok++ : none++;
    } catch (e) { fail++; }
  }, '첫날가격');
  const yc = {}, ex = {}; let nf = 0, ne = 0;                                  // 연도별 점검: 그 해에 첫날 가격이 있는 종목 수(받기가 제대로 됐는지 중간에도 볼 수 있게)
  for (const s of list) { const f = file(s.y); if (!fs.existsSync(f)) continue; let a = []; try { a = JSON.parse(fs.readFileSync(f)); } catch (e) {} if (!a.length) continue; nf++; if (s.type === 'etf') ne++; const ys = new Set(a.map(x => String(x[0]).slice(0, 4))); ys.forEach(y => { yc[y] = (yc[y] || 0) + 1; }); }
  console.log(`첫날 가격 연도별 종목 수(받은 파일 ${nf}/${list.length}, 그중 미국 ETF ${ne}): ` + Object.keys(yc).sort().map(y => y + ' ' + yc[y]).join(' · '));
  console.log(`첫날 가격: 새로 ${ok}, 이미 있음 ${skip}, 데이터 없음 ${none}, 실패 ${fail}` + (fail ? ' → 다시 실행하면 실패한 것만 이어서 받음' : ''));
})();
