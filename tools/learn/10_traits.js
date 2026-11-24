// 이긴 종목 vs 진 종목의 공통점·차이점 (구매 당시 지표만 사용) → data/traits.txt
//   지표 = 가격 지표 + (data/sec가 있으면) 미국 재무 지표(fund.js: 신호 달 말까지 공시된 값만 → 미래 정보 없음)
//   비교 세 가지: ① 모든 신호를 "첫날 진입 + 지금 판매 규칙(tp2x 트레일·금리 유예 2달)"으로 팔았다면의 결과 중 그달 안 순위 상위 20% vs 하위 20%
//                 ② 큰 이익(12개월 안 2배 이상) vs 큰 손실(−30% 이하)  ③ 일지에서 실제로 산 거래의 수익 상위 vs 하위(구매 시점 지표)
//   각 지표의 AUC = 이긴 쪽 값이 진 쪽보다 클 확률(0.5 = 차이 없음, 0.5에서 멀수록 잘 가름), 그달 안 순위로 바꿔서 시기 효과를 뺌. 앞쪽(~2019)·뒤쪽(2020~)을 따로 봄.
const { fs, path, DATA } = require('./common');
const { load } = require('./data');
const SL = require('./strat');
const Fu = require('./fund');
const { F, L } = load();
const now = new Date(), CUR = now.getFullYear() * 100 + now.getMonth() + 1, END = SL.mi(CUR) - 1;
const iUS = F.indexOf('us');
const hasSec = fs.existsSync(path.join(DATA, 'sec'));
const out = [], log = s => { out.push(s); console.log(s); };
const NAMES = F.filter(f => !f.startsWith('m_') && !f.startsWith('idx_')).concat(hasSec ? Fu.NAMES.map(n => 'f_' + n) : []);
const pick = (r, fund) => { const v = {}; F.forEach((f, j) => { v[f] = r.x[j]; }); if (fund) Fu.NAMES.forEach(n => { v['f_' + n] = fund[n]; }); return v; };
// 값 → 그달 안 백분위(같은 달 값이 3개 미만이면 0.5)
function monthRank(rows, name) {
  const by = new Map(); rows.forEach((r, i) => { if (Number.isFinite(r.v[name])) { const a = by.get(r.ym) || []; a.push(i); by.set(r.ym, a); } });
  const rk = new Array(rows.length).fill(NaN);
  by.forEach(ix => { if (ix.length < 3) { ix.forEach(i => { rk[i] = 0.5; }); return; } const s = ix.slice().sort((a, b) => rows[a].v[name] - rows[b].v[name]); for (let k = 0; k < s.length;) { let e = k; while (e + 1 < s.length && rows[s[e + 1]].v[name] === rows[s[k]].v[name]) e++; const r = ((k + e) / 2 + 0.5) / s.length; for (let q = k; q <= e; q++) rk[s[q]] = r; k = e + 1; } });   // 같은 값은 평균 순위(0/1 지표가 줄 세우기 순서에 휘둘리지 않게)
  return rk;
}
function auc(x, g) {                                   // g=1 그룹의 x가 g=0 그룹보다 클 확률
  const a = [], b = []; x.forEach((v, i) => { if (!Number.isFinite(v)) return; (g[i] === 1 ? a : b).push(v); });
  if (a.length < 15 || b.length < 15) return NaN;
  const all = a.map(v => [v, 1]).concat(b.map(v => [v, 0])).sort((p, q) => p[0] - q[0]);
  let rs = 0; for (let i = 0; i < all.length;) { let e = i; while (e + 1 < all.length && all[e + 1][0] === all[i][0]) e++; const r = (i + e) / 2 + 1; for (let k = i; k <= e; k++) if (all[k][1] === 1) rs += r; i = e + 1; }
  return (rs - a.length * (a.length + 1) / 2) / (a.length * b.length);
}
const med = a => { const b = a.filter(Number.isFinite).sort((p, q) => p - q); return b.length ? b[Math.floor(b.length / 2)] : NaN; };
const f3 = v => Number.isFinite(v) ? v.toFixed(3) : '  -  ';
function compare(title, rows, win, lose) {
  const sel = rows.map((r, i) => ({ r, i })).filter(o => win[o.i] || lose[o.i]);
  const R = sel.map(o => o.r), G = sel.map(o => win[o.i] ? 1 : 0);
  log(`\n## ${title}  (이긴 ${G.filter(v => v === 1).length}건 / 진 ${G.filter(v => v === 0).length}건)`);
  const tab = [];
  NAMES.forEach(nm => {
    const isF = nm.startsWith('f_');
    const rk = monthRank(R, nm), vals = R.map(r => r.v[nm]);
    const e = R.map(r => r.ym < 202001), early = (arr) => arr.filter((_, i) => e[i]), late = (arr) => arr.filter((_, i) => !e[i]);
    const a = auc(rk, G), ae = auc(early(rk), early(G)), al = auc(late(rk), late(G));
    const cov = vals.filter(Number.isFinite).length / vals.length;
    tab.push({ nm, a, ae, al, mw: med(vals.filter((_, i) => G[i] === 1)), ml: med(vals.filter((_, i) => G[i] === 0)), cov, isF });
  });
  const show = t => log(`${t.nm.padEnd(16)} AUC ${f3(t.a)}  앞쪽 ${f3(t.ae)}  뒤쪽 ${f3(t.al)}   이긴 쪽 중앙값 ${f3(t.mw).padStart(8)}  진 쪽 ${f3(t.ml).padStart(8)}   값 있는 비율 ${(t.cov * 100).toFixed(0)}%`);
  log('가장 잘 가르는 지표 12개 (0.5에서 먼 순)'); tab.filter(t => Number.isFinite(t.a)).sort((p, q) => Math.abs(q.a - 0.5) - Math.abs(p.a - 0.5)).slice(0, 12).forEach(show);
  if (hasSec) { log('재무 지표 전부 (값이 있는 미국 신호끼리만 비교됨)'); tab.filter(t => t.isF).forEach(show); }
}
// ① ② 모든 신호
const rowsA = [], lab = L.map(r => SL.label(r.y, r.ym, { entry: 'fd', tp: 2, grace: 2, rate: true }, END));
L.forEach((r, i) => { const l = lab[i]; if (!l) return; const t = l.exoff !== null ? l.t : l.mk[3]; if (t == null || !Number.isFinite(t)) return; const us = r.x[iUS] === 1; rowsA.push({ ym: r.ym, t, v: pick(r, hasSec && us ? Fu.featuresAt(r.y, r.ym) : null), us }); });
const mrank = (() => { const by = new Map(); rowsA.forEach((o, i) => { const a = by.get(o.ym) || []; a.push(i); by.set(o.ym, a); }); const rk = new Array(rowsA.length).fill(0.5); by.forEach(ix => { const s = ix.slice().sort((a, b) => rowsA[a].t - rowsA[b].t); s.forEach((i, k) => { rk[i] = (k + 0.5) / s.length; }); }); return rk; })();
log(`# 이긴 종목 vs 진 종목의 공통점 (${new Date().toISOString().slice(0, 10)}, 재무 지표 ${hasSec ? '있음(미국만)' : '없음'})`);
log('결과 = 첫날 진입 + tp2x 트레일·금리 유예 2달 규칙으로 팔았다면의 log 수익(못 팔았으면 12개월 시점). 지표는 구매 당시 값.');
compare('① 그달 안에서 결과 상위 20% vs 하위 20%', rowsA, rowsA.map((o, i) => mrank[i] >= 0.8), rowsA.map((o, i) => mrank[i] <= 0.2));
compare('② 큰 이익(2배 이상) vs 큰 손실(−30% 이하)', rowsA, rowsA.map(o => o.t >= Math.log(2)), rowsA.map(o => o.t <= Math.log(0.7)));
// ③ 일지에서 실제로 산 거래
try {
  const T = JSON.parse(fs.readFileSync(path.join(DATA, 'trades.json'))).trades.filter(t => t.ret != null && t.feats);
  const rowsT = T.map(t => { const v = {}; t.feats.forEach(([k, x]) => { v[k] = x; }); const us = !/\.(KS|KQ)$/.test(t.y); if (hasSec && us) { const o = Fu.featuresAt(t.y, t.buyYm); if (o) Fu.NAMES.forEach(n => { v['f_' + n] = o[n]; }); } return { ym: +t.buyYm, t: t.ret, v }; });
  const s = rowsT.map(o => o.t).sort((a, b) => a - b), hi = s[Math.floor(s.length * 0.8)], lo = s[Math.floor(s.length * 0.2)];
  compare(`③ 일지에서 실제로 산 거래: 수익 상위 20% vs 하위 20% (${T.length}건)`, rowsT, rowsT.map(o => o.t >= hi), rowsT.map(o => o.t <= lo));
} catch (e) { log('\n③ 일지 거래(trades.json)를 읽지 못해 건너뜀'); }
log('\n※ AUC가 0.5에서 멀어도 겹치는 부분이 커서 이것만으로 이길 종목을 고를 수는 없음. 앞쪽·뒤쪽이 같은 방향인지, 값 있는 비율이 충분한지 함께 볼 것.');
fs.writeFileSync(path.join(DATA, 'traits.txt'), out.join('\n') + '\n');
