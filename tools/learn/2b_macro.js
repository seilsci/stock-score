// 1단계-3: 거시 지표(미국 연준 FRED, 키 없음) → data/macro.json  { YYYYMM: {cpi_yoy, ...} }
// 발표가 늦는 월간 지표(물가·실업률·기준금리)는 한 달 늦게 반영(그때는 몰랐던 값 안 쓰기)
const { fs, path, DATA, sleep, progress } = require('./common');
const S = ['CPIAUCSL', 'UNRATE', 'FEDFUNDS', 'DGS10', 'T10Y2Y', 'DEXKOUS', 'DTWEXBGS', 'VIXCLS', 'BAMLH0A0HYM2'];
const dir = path.join(DATA, 'macro'); fs.mkdirSync(dir, { recursive: true });

async function csv(id) {
  const f = path.join(dir, id + '.csv');
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < 20 * 3600e3) return fs.readFileSync(f, 'utf8');
  for (let k = 0; k < 4; k++) {
    try {
      const r = await fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + id,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(60000) });
      if (r.ok) { const t = await r.text(); if (/^\D/.test(t)) { fs.writeFileSync(f, t); return t; } }
    } catch (e) {}
    await sleep(3000 * (k + 1));
  }
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}
// 달마다 마지막 값
function monthly(t) {
  const m = new Map();
  t.trim().split(/\r?\n/).slice(1).forEach(l => {
    const [d, v] = l.split(',');
    if (!d || v === undefined || v === '.' || v === '') return;
    m.set(+d.slice(0, 4) * 100 + +d.slice(5, 7), +v);
  });
  return m;
}
const back = (ym, k) => { let y = Math.floor(ym / 100), mo = ym % 100 - k; while (mo < 1) { mo += 12; y--; } return y * 100 + mo; };

(async () => {
  const M = {}; let ok = 0;
  for (let i = 0; i < S.length; i++) {
    progress('거시 지표', i / S.length);
    const t = await csv(S[i]); if (t) { M[S[i]] = monthly(t); ok++; }
  }
  progress('거시 지표', 1); process.stdout.write('\n');
  const g = (id, ym) => M[id] ? M[id].get(ym) : undefined;
  const pct = (a, b) => a !== undefined && b ? a / b - 1 : '';
  const dif = (a, b) => a !== undefined && b !== undefined ? a - b : '';
  const out = {};
  for (let y = 1995; y <= new Date().getFullYear(); y++) for (let mo = 1; mo <= 12; mo++) {
    const ym = y * 100 + mo, l1 = back(ym, 1), l13 = back(ym, 13), p12 = back(ym, 12);
    out[ym] = {
      cpi_yoy: pct(g('CPIAUCSL', l1), g('CPIAUCSL', l13)),
      unrate: g('UNRATE', l1) ?? '', unrate_chg12: dif(g('UNRATE', l1), g('UNRATE', l13)),
      ff: g('FEDFUNDS', l1) ?? '', ff_chg12: dif(g('FEDFUNDS', l1), g('FEDFUNDS', l13)),
      y10: g('DGS10', ym) ?? '', y10_chg12: dif(g('DGS10', ym), g('DGS10', p12)),
      t10y2y: g('T10Y2Y', ym) ?? '',
      krw_chg12: pct(g('DEXKOUS', ym), g('DEXKOUS', p12)), usd_chg12: pct(g('DTWEXBGS', ym), g('DTWEXBGS', p12)),
      vix: g('VIXCLS', ym) ?? '', hy: g('BAMLH0A0HYM2', ym) ?? ''
    };
  }
  fs.writeFileSync(path.join(DATA, 'macro.json'), JSON.stringify(out));
  if (M.DEXKOUS) fs.writeFileSync(path.join(DATA, 'fx.json'), JSON.stringify(Object.fromEntries(M.DEXKOUS)));   // 월말 원/달러
  console.log(`거시 지표: ${ok}/${S.length}개 받음` + (ok < S.length ? ' (못 받은 건 빈 값으로 학습)' : ''));
})();
