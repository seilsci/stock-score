// 4_train.js·5_explore.js 공통: AUC, 표준화, 로지스틱 회귀
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

module.exports = { auc, prep, z, fitLR, solve, score };
