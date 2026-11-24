// 6단계: 모델을 "시장 타이밍"과 "종목 고르기"로 나눠 점검 + 해마다 따로 → data/check.txt
// 사이트의 목록은 한 시점의 매수 신호들을 점수로 줄 세우는 것 → 같은 달 안에서 잘 고르는지가 핵심.
// 거시 지표는 그달 모든 종목이 같은 값이라 달 안의 순서는 못 바꿈(시장 분위기만 말해 줌).
const { fs, path, DATA, progress } = require('./common');
const { prep, z, fitRidge, score, spearman } = require('./ml');
const { load, trainSet } = require('./data');
const { F, L: ALL } = load(), fi = n => F.indexOf(n);
const L = ALL.filter(r => r.t !== null);
const clipT = t => Math.max(-2, Math.min(3, t));
const yrs = [...new Set(L.map(r => Math.floor(r.ym / 100)))].sort();
const TEST = yrs.filter(y => y >= yrs[0] + 3);
const all = F.map((_, j) => j), MAC = all.filter(j => F[j].startsWith('m_'));
const MKT = all.filter(j => F[j].startsWith('idx_') || F[j] === 'us');
const PRICE = all.filter(j => !F[j].startsWith('m_')), STOCK = PRICE.filter(j => !MKT.includes(j));
const out = [], log = s => out.push(s);
const g = x => Math.exp(x) - 1, pc = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
const mean = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);

// 모델: 이름, 사용 지표, 벌점, 목표를 달 평균에서 뺄지(종목 고르기만 학습)
const MODELS = [
  { n: 'A 가격만(35)', cols: PRICE, lam: 1000 },
  { n: 'B 가격+거시 전부', cols: PRICE.concat(MAC), lam: 1000 },
  { n: 'C 가격+기준금리변화', cols: PRICE.concat([fi('m_ff_chg12')]), lam: 1000 },
  { n: 'D 시장 요소만(지수·거시)', cols: MKT.concat(MAC), lam: 1000 },
  { n: 'E 종목 요소만(달 평균 뺀 수익)', cols: STOCK, lam: 1000, demean: true },
  { n: 'F 가격35(달 평균 뺀 수익)', cols: PRICE, lam: 1000, demean: true }
];
const pred = MODELS.map(() => []);                 // [{ym, Y, s, t}]
TEST.forEach((Y, yi) => {
  progress('점검', yi / TEST.length);
  const tr0 = trainSet(ALL, Y), te = L.filter(r => Math.floor(r.ym / 100) === Y);
  if (tr0.length < 500 || !te.length) return;
  const mm = new Map(); tr0.forEach(r => { const a = mm.get(r.ym) || []; a.push(clipT(r.t)); mm.set(r.ym, a); });
  MODELS.forEach((M, k) => {
    const tr = M.demean ? tr0.map(r => { const a = mm.get(r.ym); return { x: r.x, t: a.length >= 5 ? clipT(r.t) - mean(a) : null }; }).filter(r => r.t !== null)
                        : tr0.map(r => ({ x: r.x, t: clipT(r.t) }));
    const P = prep(tr, M.cols), w = fitRidge(tr.map(r => z(r, P)), tr.map(r => r.t), M.lam);
    te.forEach(r => pred[k].push({ ym: r.ym, Y, s: score(w, z(r, P)), t: r.t }));
  });
});
progress('점검', 1); process.stdout.write('\n');

const top = (rows, f = 0.2) => { const o = [...rows].sort((a, b) => b.s - a.s), n = Math.max(1, Math.floor(o.length * f)); return o.slice(0, n); };
function byMonth(rows) { const m = new Map(); rows.forEach(r => { const a = m.get(r.ym) || []; a.push(r); m.set(r.ym, a); }); return m; }
function metrics(rows) {
  const pooled = mean(top(rows).map(r => r.t)), sp = spearman(rows.map(r => r.s), rows.map(r => r.t));
  const mo = [...byMonth(rows).values()].filter(a => a.length >= 40);
  const sel = mo.map(a => mean(top(a).map(r => r.t)) - mean(a.map(r => r.t)));       // 달 안에서 상위20% − 달 평균
  const ic = mo.map(a => spearman(a.map(r => r.s), a.map(r => r.t)));
  const ms = [...byMonth(rows).values()].filter(a => a.length >= 10).map(a => ({ s: mean(a.map(r => r.s)), t: mean(a.map(r => r.t)), n: a.length }));
  const tm = spearman(ms.map(m => m.s), ms.map(m => m.t));
  const o = [...ms].sort((a, b) => b.s - a.s), th = Math.floor(o.length / 3);
  const w = a => { const n = a.reduce((s, m) => s + m.n, 0); return a.reduce((s, m) => s + m.t * m.n, 0) / n; };
  return { pooled, sp, selM: mean(sel), selPos: sel.filter(x => x > 0).length / (sel.length || 1), ic: mean(ic), nm: mo.length, tm, hi: w(o.slice(0, th)), lo: w(o.slice(-th)) };
}
const R = MODELS.map((M, k) => ({ M, m: metrics(pred[k]) }));
const base = mean(pred[0].map(r => r.t));
log(`# 모델 점검 — 시장 타이밍 vs 종목 고르기 (${new Date().toISOString().slice(0, 10)})`);
log(`시험 신호 ${pred[0].length}건, 연도 ${TEST[0]}~${TEST[TEST.length - 1]}, 전부 샀을 때 평균 수익(기하) ${pc(g(base))}`);
log(`※ 학습은 시험 연도 1월 1일에 알 수 있던 정답만 사용(이미 매도했거나 12개월 이상 보유한 것). 이전 보고서는 이 부분이 새는 문제가 있었음.`);
log(`\n## 한눈에`);
log(`모델                          전체 상위20%   같은 달 안 상위20%   달 안 순위상관   (상위20%가 달 평균 이긴 달)`);
R.forEach(({ M, m }) => log(`${M.n.padEnd(28)}  ${pc(g(m.pooled)).padStart(7)}      ${pc(g(m.selM)).padStart(8)}          ${m.ic.toFixed(3).padStart(6)}        ${(m.selPos * 100).toFixed(0)}% (${m.nm}개월)`));
log(`\n- "같은 달 안 상위20%"가 사이트 목록 줄 세우기에 해당. 달 평균보다 얼마나 더 벌었나(+면 잘 고름).`);
log(`- 거시(B·C·D)는 같은 달 안에서는 점수가 모두 같이 움직여 순서를 못 바꿈 → 달 안 성적은 가격 지표가 결정.`);
log(`\n## 시장 타이밍 (달마다 평균 점수가 높았던 달 vs 낮았던 달, 신호 가중 평균 수익)`);
log(`모델                          점수↔달수익 상관   점수 상위 1/3 달   하위 1/3 달`);
R.forEach(({ M, m }) => log(`${M.n.padEnd(28)}  ${m.tm.toFixed(3).padStart(8)}          ${pc(g(m.hi)).padStart(8)}      ${pc(g(m.lo)).padStart(8)}`));
log(`\n## 해마다 (그해 신호만) — 전부 샀을 때 / 모델별 점수 상위 20% 평균 수익`);
log(`연도   건수   전부     ` + MODELS.map(M => M.n.slice(0, 1).padStart(7)).join(''));
TEST.forEach(Y => {
  const rows = pred.map(p => p.filter(r => r.Y === Y)); if (!rows[0].length) return;
  log(`${Y}  ${String(rows[0].length).padStart(5)}  ${pc(g(mean(rows[0].map(r => r.t)))).padStart(7)}  ` + rows.map(rs => pc(g(mean(top(rs).map(r => r.t)))).padStart(7)).join(''));
});
fs.writeFileSync(path.join(DATA, 'check.txt'), out.join('\n') + '\n');
