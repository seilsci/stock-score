// 4단계: 수익 예측 학습(릿지 회귀, 목표 = 로그 수익) + 시간 순서 검증 → data/report.txt, data/weights.json
// 수익 = 매수 신호 달 종가에 사서 매도 신호 달 종가에 판 수익(1년 넘게 보유 중이면 지금까지)
const { fs, path, DATA, progress } = require('./common');
const { prep, z, fitRidge, score, spearman, quint } = require('./ml');
const lines = fs.readFileSync(path.join(DATA, 'events.csv'), 'utf8').trim().split('\n');
const F = lines[0].split(',').slice(6);
const L = lines.slice(1).map(l => { const p = l.split(','); return p[5] === '' ? null :
  { ym: +p[1], hold: +p[3], t: +p[5], x: p.slice(6).map(v => v === '' ? NaN : +v) }; }).filter(Boolean);
const clipT = t => Math.max(-2, Math.min(3, t));      // 학습용: 극단값 자르기(로그 −86% ~ +1900%)
const out = [], log = s => { out.push(s); if (process.env.VERBOSE) console.log(s); };
const pct = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
const yrs = [...new Set(L.map(r => Math.floor(r.ym / 100)))].sort();

function walk(cols, lam) {
  const sc = [], tg = [];
  for (const Y of yrs) {
    if (Y < yrs[0] + 3) continue;
    const tr = L.filter(r => r.ym + 101 <= Y * 100 + 1), te = L.filter(r => Math.floor(r.ym / 100) === Y);
    if (tr.length < 500 || !te.length) continue;
    const P = prep(tr, cols), w = fitRidge(tr.map(r => z(r, P)), tr.map(r => clipT(r.t)), lam);
    te.forEach(r => { sc.push(score(w, z(r, P))); tg.push(r.t); });
  }
  const q = quint(sc, tg);
  return { sp: spearman(sc, tg), top: q[0].ml, q, sc, tg };
}

const all = quint(L.map(() => 0), L.map(r => r.t));
const win = L.filter(r => r.t > 0).length / L.length, gm = Math.exp(L.reduce((a, r) => a + r.t, 0) / L.length) - 1;
log(`# 월봉 10이평 매수 신호 — 수익 예측 학습 보고서 (${new Date().toISOString().slice(0, 10)})`);
log(`수익 확정 신호 ${L.length}건 · 수익 낸 비율 ${(win * 100).toFixed(1)}% · 평균 수익(기하) ${pct(gm)} (기준선)`);
log(`기간 ${yrs[0]}~${yrs[yrs.length - 1]}`);

log(`\n## 지표 하나씩 (수익과 순위 상관, 0에서 멀수록 잘 가름)`);
const uni = F.map((f, j) => { const rr = L.filter(r => Number.isFinite(r.x[j])); return { f, j, c: spearman(rr.map(r => r.x[j]), rr.map(r => r.t)) }; })
  .sort((a, b) => Math.abs(b.c) - Math.abs(a.c));
uni.forEach(u => log(`${u.f.padEnd(14)} ${u.c >= 0 ? '+' : ''}${u.c.toFixed(3)}`));

const cols = F.map((_, j) => j), price = cols.filter(j => !F[j].startsWith('m_'));
const sets = { '가격만': price, '가격 상위12': uni.filter(u => !F[u.j].startsWith('m_')).slice(0, 12).map(u => u.j) };
if (cols.length > price.length) sets['가격+거시'] = cols;
log(`\n## 시간 순서 검증 (과거로 학습 → 다음 해로 시험). 상위20% = 점수 상위 20%만 샀을 때 평균 수익(기하)`);
let best = null, nk = 0;
for (const [name, cs] of Object.entries(sets)) for (const lam of [10, 1000]) {
  progress('학습·검증', nk++ / (Object.keys(sets).length * 2));
  const r = walk(cs, lam);
  log(`${name.padEnd(8)} 벌점${String(lam).padStart(5)}  상위20% ${pct(Math.exp(r.top) - 1).padStart(7)}  순위상관 ${r.sp.toFixed(3)}`);
  if (!best || r.top > best.r.top) best = { name, cs, lam, r };
}
log(`→ 가장 좋은 것: ${best.name}, 벌점 ${best.lam}`);

log(`\n## 점수 구간별 실제 수익 (시험 구간, 점수 높은 순 20%씩)`);
log(`구간    건수   수익낸비율   평균(기하)   평균(산술)   중앙값`);
best.r.q.forEach((q, k) => log(`${k + 1}구간  ${String(q.n).padStart(6)}   ${(q.win * 100).toFixed(1).padStart(6)}%   ${pct(q.gmean).padStart(8)}   ${pct(q.mean).padStart(8)}   ${pct(q.med).padStart(7)}`));

// 최종: 전체로 다시 학습 + 점수(0~100) 환산용 분위
const P = prep(L, best.cs), w = fitRidge(L.map(r => z(r, P)), L.map(r => clipT(r.t)), best.lam);
const pr = L.map(r => score(w, z(r, P))).sort((a, b) => a - b);
const qs = Array.from({ length: 101 }, (_, k) => pr[Math.min(pr.length - 1, Math.floor(pr.length * k / 100))]);
log(`\n## 최종 가중치 (표준화 기준, +면 수익 쪽)`);
P.map((p, k) => ({ f: F[p.j], w: w[k + 1] })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
  .forEach(x => log(`${x.f.padEnd(14)} ${x.w >= 0 ? '+' : ''}${x.w.toFixed(4)}`));
fs.writeFileSync(path.join(DATA, 'weights.json'), JSON.stringify({
  made: new Date().toISOString(), target: 'log(1+수익)', n: L.length, model: best.name, lam: best.lam,
  top20: Math.exp(best.r.top) - 1, spearman: best.r.sp, b: w[0],
  feats: P.map((p, k) => ({ f: F[p.j], lo: p.lo, hi: p.hi, m: p.m, sd: p.sd, w: w[k + 1] })), pct: qs
}, null, 1));
fs.writeFileSync(path.join(DATA, 'report.txt'), out.join('\n') + '\n');
progress('학습·검증', 1); process.stdout.write('\n');
