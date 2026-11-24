// 경사 부스팅 트리(GBM) — 외부 라이브러리 없이 순수 JS (PC에 node만 있으면 됨). 제곱 오차, 깊이 제한 트리, 히스토그램 분할.
//  fit(rows, y, opt): rows = [[지표값...]...](NaN 허용), cols = 쓸 지표 번호 → 모델 객체(JSON으로 저장 가능)
//  predict(model, row): 한 신호의 예측값. 사이트(Apps Script·index·journal)도 같은 식으로 계산함(evalModel).
//  전처리는 ml.js prep과 같음: 1~99% 자르기, 빈 값은 (자른) 평균 → 트리 분할값은 자른 값 기준
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function prepCols(rows, cols) {
  return cols.map(j => {
    const v = rows.map(r => r[j]).filter(Number.isFinite).sort((a, b) => a - b);
    const lo = v[Math.floor(v.length * 0.01)], hi = v[Math.floor(v.length * 0.99)];
    const cl = v.map(x => Math.min(hi, Math.max(lo, x)));
    const m = cl.reduce((a, b) => a + b, 0) / cl.length;
    return { j, lo, hi, m, med: cl[Math.floor(cl.length / 2)] };
  });
}
const DEF = { rounds: 300, lr: 0.03, depth: 3, minLeaf: 150, l2: 10, bins: 48, ff: 0.8, bag: 0.8, seed: 1 };

function fit(rows, y, cols, opt = {}) {
  const o = { ...DEF, ...opt }, n = rows.length, F = cols.length, rnd = mulberry(o.seed);
  const P = prepCols(rows, cols);
  // 값 → 구간 번호(분위 기준 o.bins개)
  const thr = [], X = new Uint8Array(n * F);
  P.forEach((p, k) => {
    const vals = new Float64Array(n);
    for (let i = 0; i < n; i++) { const v = rows[i][p.j]; vals[i] = Number.isFinite(v) ? Math.min(p.hi, Math.max(p.lo, v)) : p.m; }
    const s = Float64Array.from(vals).sort(); const t = [];
    for (let b = 1; b < o.bins; b++) { const v = s[Math.floor(n * b / o.bins)]; if (!t.length || v > t[t.length - 1]) t.push(v); }
    // 구간 경계 = 값 ≤ t[b] 이면 b 이하 구간. 가장 큰 경계 뒤는 마지막 구간
    const tt = t.filter(v => v < s[n - 1]); thr.push(tt);
    for (let i = 0; i < n; i++) { let lo = 0, hi = tt.length; const v = vals[i]; while (lo < hi) { const mid = (lo + hi) >> 1; if (tt[mid] < v) lo = mid + 1; else hi = mid; } X[i * F + k] = lo; }
  });
  const init = y.reduce((a, b) => a + b, 0) / n, pred = new Float64Array(n).fill(init), trees = [];
  const NB = o.bins + 1;
  for (let r = 0; r < o.rounds; r++) {
    const res = new Float64Array(n); for (let i = 0; i < n; i++) res[i] = y[i] - pred[i];
    const use = new Uint8Array(n); for (let i = 0; i < n; i++) use[i] = rnd() < o.bag ? 1 : 0;
    const fOn = []; for (let k = 0; k < F; k++) if (rnd() < o.ff) fOn.push(k); if (!fOn.length) fOn.push(0);
    // 깊이 우선 아닌 층별 성장: nodes = 현재 층의 [{idx: 표본 번호 배열}]
    const T = { f: [], t: [], l: [], r: [], v: [], bn: [] };
    const addNode = () => { T.f.push(-1); T.t.push(0); T.l.push(-1); T.r.push(-1); T.v.push(0); T.bn.push(0); return T.f.length - 1; };
    const root = addNode(); let level = [{ id: root, rows: [] }];
    for (let i = 0; i < n; i++) if (use[i]) level[0].rows.push(i);
    for (let d = 0; d <= o.depth; d++) {
      const next = [];
      for (const nd of level) {
        const idx = nd.rows; let G = 0; for (const i of idx) G += res[i]; const H = idx.length;
        const leaf = () => { T.v[nd.id] = o.lr * G / (H + o.l2); };
        if (d === o.depth || H < 2 * o.minLeaf) { leaf(); continue; }
        let best = null;
        const base = G * G / (H + o.l2);
        for (const k of fOn) {
          const hg = new Float64Array(NB), hc = new Float64Array(NB);
          for (const i of idx) { const b = X[i * F + k]; hg[b] += res[i]; hc[b] += 1; }
          let gl = 0, hl = 0;
          for (let b = 0; b < thr[k].length; b++) {
            gl += hg[b]; hl += hc[b];
            const hr = H - hl; if (hl < o.minLeaf || hr < o.minLeaf) continue;
            const gr = G - gl, gain = gl * gl / (hl + o.l2) + gr * gr / (hr + o.l2) - base;
            if (!best || gain > best.gain) best = { gain, k, b };
          }
        }
        if (!best || best.gain <= 1e-9) { leaf(); continue; }
        const L = [], R = [];
        for (const i of idx) (X[i * F + best.k] <= best.b ? L : R).push(i);
        const li = addNode(), ri = addNode();
        T.f[nd.id] = best.k; T.bn[nd.id] = best.b; T.t[nd.id] = thr[best.k][best.b]; T.l[nd.id] = li; T.r[nd.id] = ri;
        next.push({ id: li, rows: L }, { id: ri, rows: R });
      }
      level = next; if (!level.length) break;
    }
    // 전체 표본 예측 갱신 (자루에 안 든 표본도)
    for (let i = 0; i < n; i++) {
      let nd = 0;
      while (T.f[nd] >= 0) nd = X[i * F + T.f[nd]] <= T.bn[nd] ? T.l[nd] : T.r[nd];
      pred[i] += T.v[nd];
    }
    delete T.bn; trees.push(T);
  }
  return { feats: P.map((p, k) => ({ f: null, j: p.j, lo: p.lo, hi: p.hi, m: p.m, med: p.med })), init, trees };
}
// 한 신호(지표 배열 row)의 예측값. 모델 객체 안 feats[k].j 번 지표를 씀
function predict(model, row) {
  const x = model.feats.map(p => { const v = row[p.j]; return Number.isFinite(v) ? Math.min(p.hi, Math.max(p.lo, v)) : p.m; });
  return evalModel(model, x);
}
// 이미 자르고 빈 값을 채운 값 배열 x(모델 지표 순서) → 예측값. 사이트에서 같은 식을 씀
function evalModel(model, x) {
  let s = model.init;
  for (const T of model.trees) { let nd = 0; while (T.f[nd] >= 0) nd = x[T.f[nd]] <= T.t[nd] ? T.l[nd] : T.r[nd]; s += T.v[nd]; }
  return s;
}
module.exports = { fit, predict, evalModel };
