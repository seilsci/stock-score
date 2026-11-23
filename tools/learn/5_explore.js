// 5단계: 여러 실험 한꺼번에 (모두 같은 데이터·같은 시간 순서 검증) → data/explore.txt
// 시험 연도: 2012~ 2년 간격(속도). 학습 = 그해 1월 전에 정답이 확정된 신호
const { fs, path, DATA, progress } = require('./common');
const { auc, prep, z, fitLR, score } = require('./ml');
const lines = fs.readFileSync(path.join(DATA, 'events.csv'), 'utf8').trim().split('\n');
const F = lines[0].split(',').slice(5), fi = n => F.indexOf(n);
const L = lines.slice(1).map(l => { const p = l.split(','); return p[2] === '' ? null :
  { ym: +p[1], label: +p[2], hold: +p[3], ret: p[4] === '' ? null : +p[4], x: p.slice(5).map(v => v === '' ? NaN : +v) }; })
  .filter(Boolean);
const yrs = [...new Set(L.map(r => Math.floor(r.ym / 100)))].sort();
const TEST = yrs.filter(y => y >= Math.max(2012, yrs[0] + 3) && (y - 2012) % 2 === 0);
const OLD25 = ['gap', 'slope1', 'slope3', 'cross24', 'below', 'above24', 'c_ma12', 'ma10_ma24', 'vol', 'vol3', 'body', 'upwick',
  'lowwick', 'range', 'ret1', 'ret3', 'ret12', 'high24', 'dd36', 'volat12', 'idx_above', 'idx_slope', 'idx_ret12', 'us', 'etf'].map(fi).filter(j => j >= 0);
const PRICE = F.map((_, j) => j).filter(j => !F[j].startsWith('m_'));
const MAC = F.map((_, j) => j).filter(j => F[j].startsWith('m_'));
const out = [], log = s => out.push(s);

// 행 → 입력값 (파생: 곱·제곱)
function feats(r, P, extra) {
  const v = z(r, P);
  if (extra) extra.forEach(e => v.push(e.sq ? v[e.a] * v[e.a] : v[e.a] * v[e.b]));
  return v;
}
// ── 로지스틱 회귀 실험
function runLR(cols, o = {}) {
  const sc = [], lab = [], keep = [];
  for (const Y of TEST) {
    let tr = L.filter(r => r.ym + 101 <= Y * 100 + 1);
    if (o.window) tr = tr.filter(r => r.ym >= (Y - o.window) * 100);
    if (o.noEtf) tr = tr.filter(r => !r.x[fi('etf')]);
    let te = L.filter(r => Math.floor(r.ym / 100) === Y);
    const groups = o.split ? [0, 1] : [null];
    for (const g of groups) {
      const trg = g === null ? tr : tr.filter(r => r.x[fi('us')] === g), teg = g === null ? te : te.filter(r => r.x[fi('us')] === g);
      if (trg.length < 300 || !teg.length) continue;
      const P = prep(trg, cols), ex = o.extra ? o.extra(P) : null;
      const w = fitLR(trg.map(r => feats(r, P, ex)), trg.map(r => r.label), o.lam || 30);
      teg.forEach(r => { sc.push(score(w, feats(r, P, ex))); lab.push(r.label); keep.push(r); });
    }
  }
  return { a: auc(sc, lab), sc, lab, rows: keep };
}
// ── 그레이디언트 부스팅(나무) 실험: 32칸 히스토그램, 로그 손실
function runGB(cols, o) {
  const sc = [], lab = [], keep = [];
  for (const Y of TEST) {
    const tr = L.filter(r => r.ym + 101 <= Y * 100 + 1), te = L.filter(r => Math.floor(r.ym / 100) === Y);
    if (tr.length < 300 || !te.length) continue;
    const m = fitGB(tr, cols, o);
    te.forEach(r => { sc.push(m(r)); lab.push(r.label); keep.push(r); });
  }
  return { a: auc(sc, lab), sc, lab, rows: keep };
}
function fitGB(tr, cols, { rounds = 200, depth = 3, lr = 0.08, minLeaf = 200 }) {
  const NB = 32, n = tr.length;
  const cuts = cols.map(j => { const v = tr.map(r => r.x[j]).filter(Number.isFinite).sort((a, b) => a - b);
    return Array.from({ length: NB - 1 }, (_, k) => v[Math.floor(v.length * (k + 1) / NB)]); });
  const bin = (v, c) => { if (!Number.isFinite(v)) return NB; let lo = 0, hi = c.length; while (lo < hi) { const md = (lo + hi) >> 1; if (v > c[md]) lo = md + 1; else hi = md; } return lo; };
  const X = tr.map(r => cols.map((j, k) => bin(r.x[j], cuts[k])));
  const y = tr.map(r => r.label), base = Math.log(y.reduce((a, b) => a + b, 0) / (n - y.reduce((a, b) => a + b, 0)));
  const f = new Float64Array(n).fill(base), trees = [];
  for (let t = 0; t < rounds; t++) {
    const g = new Float64Array(n), h = new Float64Array(n);
    for (let i = 0; i < n; i++) { const p = 1 / (1 + Math.exp(-f[i])); g[i] = p - y[i]; h[i] = p * (1 - p); }
    const node = Int32Array.from({ length: n }, () => 0), tree = [];
    let leaves = [0];
    for (let d = 0; d < depth; d++) {
      const next = [];
      for (const nd of leaves) {
        const idx = []; for (let i = 0; i < n; i++) if (node[i] === nd) idx.push(i);
        let best = null; const G = idx.reduce((s, i) => s + g[i], 0), H = idx.reduce((s, i) => s + h[i], 0);
        for (let k = 0; k < cols.length; k++) {
          const hg = new Float64Array(NB + 1), hh = new Float64Array(NB + 1), hc = new Int32Array(NB + 1);
          for (const i of idx) { const b = X[i][k]; hg[b] += g[i]; hh[b] += h[i]; hc[b]++; }
          let gl = 0, hl = 0, cl = 0;
          for (let b = 0; b < NB - 1; b++) {
            gl += hg[b]; hl += hh[b]; cl += hc[b];
            const cr = idx.length - cl; if (cl < minLeaf || cr < minLeaf) continue;
            const gain = gl * gl / (hl + 1) + (G - gl) ** 2 / (H - hl + 1) - G * G / (H + 1);
            if (!best || gain > best.gain) best = { gain, k, b };
          }
        }
        if (!best || best.gain <= 0) { tree[nd] = { leaf: true, v: -lr * G / (H + 1) }; continue; }
        const L2 = nd * 2 + 1, R2 = nd * 2 + 2;
        tree[nd] = { k: best.k, b: best.b };
        for (const i of idx) node[i] = (X[i][best.k] <= best.b) ? L2 : R2;   // 빈 값(NB)은 오른쪽
        next.push(L2, R2);
      }
      leaves = next;
    }
    for (const nd of leaves) {
      let G = 0, H = 0; for (let i = 0; i < n; i++) if (node[i] === nd) { G += g[i]; H += h[i]; }
      tree[nd] = { leaf: true, v: -lr * G / (H + 1) };
    }
    for (let i = 0; i < n; i++) f[i] += tree[node[i]].v;
    trees.push(tree);
  }
  return r => { const xb = cols.map((j, k) => bin(r.x[j], cuts[k])); let s = base;
    for (const tr of trees) { let nd = 0; while (!tr[nd].leaf) nd = xb[tr[nd].k] <= tr[nd].b ? nd * 2 + 1 : nd * 2 + 2; s += tr[nd].v; }
    return s; };
}

// ── 실험 목록
const E = [];
const add = (name, fn) => E.push({ name, fn });
add('기준: 기존 가격 25개', () => runLR(OLD25));
add('가격 35개(새 10개 포함)', () => runLR(PRICE));
add('가격35 + 거시 전부', () => runLR(PRICE.concat(MAC)));
MAC.forEach(j => add('가격35 + ' + F[j], () => runLR(PRICE.concat([j]))));
PRICE.forEach(j => add('가격35 − ' + F[j] + ' (빼기)', () => runLR(PRICE.filter(k => k !== j))));
add('한국·미국 따로', () => runLR(PRICE, { split: true }));
add('ETF 빼고 학습', () => runLR(PRICE, { noEtf: true }));
add('최근 5년만 학습', () => runLR(PRICE, { window: 5 }));
add('최근 8년만 학습', () => runLR(PRICE, { window: 8 }));
add('벌점 1', () => runLR(PRICE, { lam: 1 }));
add('벌점 300', () => runLR(PRICE, { lam: 300 }));
add('벌점 3000', () => runLR(PRICE, { lam: 3000 }));
add('제곱 항 추가(상위 8개)', () => runLR(PRICE, { extra: P => P.slice(0, 0).concat(TOP8()).map(a => ({ a, sq: 1 })) }));
add('곱 항 추가(상위 6개 쌍 15개)', () => runLR(PRICE, { extra: () => { const t = TOP8().slice(0, 6), e = []; t.forEach((a, i) => t.slice(i + 1).forEach(b => e.push({ a, b }))); return e; } }));
add('나무 깊이2 200회', () => runGB(PRICE, { depth: 2, rounds: 200 }));
add('나무 깊이3 200회', () => runGB(PRICE, { depth: 3, rounds: 200 }));
add('나무 깊이4 300회', () => runGB(PRICE, { depth: 4, rounds: 300, lr: 0.05 }));
add('나무 깊이3 + 거시', () => runGB(PRICE.concat(MAC), { depth: 3, rounds: 200 }));
// 상위 8개 = 하나씩 AUC 기준(가격 중), PRICE 안에서의 위치
let _top = null;
function TOP8() {
  if (_top) return _top;
  const u = PRICE.map((j, k) => { const rr = L.filter(r => Number.isFinite(r.x[j])); return { k, d: Math.abs(auc(rr.map(r => r.x[j]), rr.map(r => r.label)) - 0.5) }; });
  return (_top = u.sort((a, b) => b.d - a.d).slice(0, 8).map(u => u.k));
}

// ── 실행
const res = [];
E.forEach((e, i) => { progress(`실험 ${i + 1}/${E.length}`, i / E.length); const r = e.fn(); res.push({ name: e.name, ...r }); });
progress('실험', 1); process.stdout.write('\n');
const base = res[0].a, pct = x => (x * 100).toFixed(1) + '%';
log(`# 여러 실험 비교 (${new Date().toISOString().slice(0, 10)}) — 시험 연도 ${TEST.join(',')}, 같은 데이터`);
log(`AUC 높을수록 좋음. 기준(기존 25개) ${base.toFixed(4)}`);
log(`\n## 순위`);
[...res].sort((a, b) => b.a - a.a).forEach((r, k) => log(`${String(k + 1).padStart(2)}. ${r.a.toFixed(4)} (${r.a - base >= 0 ? '+' : ''}${(r.a - base).toFixed(4)})  ${r.name}`));
const best = [...res].sort((a, b) => b.a - a.a)[0];
log(`\n## 1등 "${best.name}" 점수 구간별 (시험 구간)`);
log(`구간   건수   12개월유지   평균보유(개월)`);
const ord = best.sc.map((s, i) => i).sort((a, b) => best.sc[b] - best.sc[a]);
for (let q = 0; q < 5; q++) {
  const ids = ord.slice(Math.floor(ord.length * q / 5), Math.floor(ord.length * (q + 1) / 5));
  log(`${q + 1}구간  ${String(ids.length).padStart(5)}   ${pct(ids.filter(i => best.lab[i]).length / ids.length).padStart(8)}   ${(ids.reduce((t, i) => t + Math.min(best.rows[i].hold, 60), 0) / ids.length).toFixed(1).padStart(8)}`);
}
fs.writeFileSync(path.join(DATA, 'explore.txt'), out.join('\n') + '\n');
