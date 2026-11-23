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

function auc(sc, lab) {   // 순위 기반 AUC
  const idx = sc.map((s, i) => i).sort((a, b) => sc[a] - sc[b]);
  let r = 0, np = 0, rank = 1;
  for (let k = 0; k < idx.length;) {
    let e = k; while (e + 1 < idx.length && sc[idx[e + 1]] === sc[idx[k]]) e++;
    const avgR = (rank + rank + e - k) / 2;
    for (let t = k; t <= e; t++) if (lab[idx[t]]) { r += avgR; np++; }
    rank += e - k + 1; k = e + 1;
  }
  const nn = lab.length - np;
  return np && nn ? (r - np * (np + 1) / 2) / (np * nn) : NaN;
}
// 표준화·자르기(1~99%)·빈 값은 평균
function prep(train, cols) {
  return cols.map(j => {
    const v = train.map(r => r.x[j]).filter(Number.isFinite).sort((a, b) => a - b);
    const lo = v[Math.floor(v.length * 0.01)], hi = v[Math.floor(v.length * 0.99)];
    const cl = v.map(x => Math.min(hi, Math.max(lo, x)));
    const m = cl.reduce((a, b) => a + b, 0) / cl.length;
    const sd = Math.sqrt(cl.reduce((a, b) => a + (b - m) ** 2, 0) / cl.length) || 1;
    return { j, lo, hi, m, sd };
  });
}
const z = (r, P) => P.map(p => { const v = r.x[p.j]; return Number.isFinite(v) ? (Math.min(p.hi, Math.max(p.lo, v)) - p.m) / p.sd : 0; });
// 로지스틱 회귀 (뉴턴법, L2)
function fitLR(X, y, lam = 1) {
  const d = X[0].length + 1; let w = new Array(d).fill(0);
  for (let it = 0; it < 25; it++) {
    const g = new Array(d).fill(0), Hm = Array.from({ length: d }, () => new Array(d).fill(0));
    X.forEach((x, i) => {
      const xx = [1].concat(x); let s = 0; for (let k = 0; k < d; k++) s += w[k] * xx[k];
      const p = 1 / (1 + Math.exp(-s)), q = p * (1 - p);
      for (let a = 0; a < d; a++) { g[a] += (p - y[i]) * xx[a]; for (let b = a; b < d; b++) Hm[a][b] += q * xx[a] * xx[b]; }
    });
    for (let a = 1; a < d; a++) { g[a] += lam * w[a]; Hm[a][a] += lam; }
    for (let a = 0; a < d; a++) for (let b = 0; b < a; b++) Hm[a][b] = Hm[b][a];
    const step = solve(Hm, g); let mx = 0;
    for (let k = 0; k < d; k++) { w[k] -= step[k]; mx = Math.max(mx, Math.abs(step[k])); }
    if (mx < 1e-6) break;
  }
  return w;
}
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => r.concat([b[i]]));
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / d; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / (r[i] || 1e-12));
}
const score = (w, zx) => { let s = w[0]; zx.forEach((v, k) => s += w[k + 1] * v); return s; };

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
