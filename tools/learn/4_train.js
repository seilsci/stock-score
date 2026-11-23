// 4·5단계: 지표 하나씩 비교 + 가중치 학습(로지스틱 회귀) + 시간 순서 검증 → data/report.txt, data/weights.json
const { fs, path, DATA, progress } = require('./common');
const lines = fs.readFileSync(path.join(DATA, 'events.csv'), 'utf8').trim().split('\n');
const head = lines[0].split(','), F = head.slice(5);
const all = lines.slice(1).map(l => {
  const p = l.split(',');
  return { y: p[0], ym: +p[1], label: p[2] === '' ? null : +p[2], hold: +p[3], ret: p[4] === '' ? null : +p[4],
           x: p.slice(5).map(v => v === '' ? NaN : +v) };
});
const L = all.filter(r => r.label !== null);
const out = [];
const log = s => { out.push(s); if (process.env.VERBOSE) console.log(s); };
const pct = x => (x * 100).toFixed(1) + '%';

const { auc, prep, z, fitLR, solve, score } = require('./ml');
// ── 요약
const base = L.filter(r => r.label).length / L.length;
log(`# 월봉 10이평 매수 신호 학습 보고서 (${new Date().toISOString().slice(0, 10)})`);
log(`정답 있는 신호 ${L.length}건, 12개월 유지 ${pct(base)} (기준선)`);
const yrs = [...new Set(L.map(r => Math.floor(r.ym / 100)))].sort();
log(`기간 ${yrs[0]}~${yrs[yrs.length - 1]}`);

// ── 4단계: 지표 하나씩 (AUC 0.5 = 소용없음, 멀수록 잘 가름)
log(`\n## 지표 하나씩 (AUC, 0.5에서 멀수록 잘 가름. <0.5는 클수록 나쁨)`);
const uni = F.map((f, j) => {
  const rr = L.filter(r => Number.isFinite(r.x[j]));
  return { f, j, a: auc(rr.map(r => r.x[j]), rr.map(r => r.label)) };
}).sort((a, b) => Math.abs(b.a - 0.5) - Math.abs(a.a - 0.5));
uni.forEach(u => log(`${u.f.padEnd(10)} ${u.a.toFixed(3)}`));

// ── 5단계: 시간 순서 검증 (그해 1월 전에 정답이 확정된 신호로 학습 → 그해 신호로 시험)
function walk(cols, lam) {
  const sc = [], lab = [], rows = [];
  for (const Y of yrs) {
    if (Y < yrs[0] + 3) continue;
    const tr = L.filter(r => r.ym + 100 + 1 <= Y * 100 + 1);      // 신호월+12개월 < 그해 1월
    const te = L.filter(r => Math.floor(r.ym / 100) === Y);
    if (tr.length < 500 || !te.length) continue;
    const P = prep(tr, cols), w = fitLR(tr.map(r => z(r, P)), tr.map(r => r.label), lam);
    te.forEach(r => { sc.push(score(w, z(r, P))); lab.push(r.label); rows.push(r); });
  }
  return { a: auc(sc, lab), sc, lab, rows };
}
const allCols = F.map((_, j) => j);
const price = allCols.filter(j => !F[j].startsWith('m_'));
const hasMacro = allCols.some(j => F[j].startsWith('m_') && L.some(r => Number.isFinite(r.x[j])));
const sets = { '가격만': price, '가격 상위12': uni.filter(u => !F[u.j].startsWith('m_')).slice(0, 12).map(u => u.j) };
if (hasMacro) { sets['가격+거시'] = allCols; sets['전체 상위16'] = uni.slice(0, 16).map(u => u.j); }
log(`\n## 시간 순서 검증 AUC (과거로 학습 → 다음 해로 시험)`);
let best = null, nk = 0;
for (const [name, cols] of Object.entries(sets)) for (const lam of [1, 30]) {
  progress('학습·검증', nk++ / (Object.keys(sets).length * 2));
  const r = walk(cols, lam);
  log(`${name.padEnd(8)} 벌점${String(lam).padStart(3)}  AUC ${r.a.toFixed(3)}  (시험 ${r.lab.length}건)`);
  if (!best || r.a > best.r.a) best = { name, cols, lam, r };
}
log(`→ 가장 좋은 것: ${best.name}, 벌점 ${best.lam}` + (hasMacro ? '' : '  (거시 지표 못 받음)'));

// 점수 5구간별 실제 결과 (시험 구간)
const R = best.r, ord = R.sc.map((s, i) => i).sort((a, b) => R.sc[b] - R.sc[a]);
log(`\n## 점수 구간별 실제 결과 (시험 구간, 점수 높은 순 20%씩)`);
log(`구간   건수   12개월유지   평균보유(개월)   매도까지 수익(중앙값)`);
for (let q = 0; q < 5; q++) {
  const ids = ord.slice(Math.floor(ord.length * q / 5), Math.floor(ord.length * (q + 1) / 5));
  const g = ids.filter(i => R.lab[i]).length / ids.length;
  const hold = ids.reduce((t, i) => t + Math.min(R.rows[i].hold, 60), 0) / ids.length;
  const rets = ids.map(i => R.rows[i].ret).filter(x => x !== null).sort((a, b) => a - b);
  const med = rets.length ? rets[Math.floor(rets.length / 2)] : NaN;
  log(`${q + 1}구간  ${String(ids.length).padStart(5)}   ${pct(g).padStart(8)}   ${hold.toFixed(1).padStart(10)}   ${pct(med).padStart(12)}`);
}

// ── 최종 가중치: 정답 있는 전체로 다시 학습
const P = prep(L, best.cols), w = fitLR(L.map(r => z(r, P)), L.map(r => r.label), best.lam);
log(`\n## 최종 가중치 (표준화 기준, +면 갈 돌파 쪽)`);
P.map((p, k) => ({ f: F[p.j], w: w[k + 1] })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
  .forEach(x => log(`${x.f.padEnd(10)} ${x.w >= 0 ? '+' : ''}${x.w.toFixed(3)}`));
fs.writeFileSync(path.join(DATA, 'weights.json'), JSON.stringify({
  made: new Date().toISOString(), n: L.length, base, auc: best.r.a, model: best.name, lam: best.lam,
  b: w[0], feats: P.map((p, k) => ({ f: F[p.j], lo: p.lo, hi: p.hi, m: p.m, sd: p.sd, w: w[k + 1] }))
}, null, 1));
fs.writeFileSync(path.join(DATA, 'report.txt'), out.join('\n') + '\n');
progress('학습·검증', 1); process.stdout.write('\n');
