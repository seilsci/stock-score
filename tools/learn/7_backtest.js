// 7단계: 월 100만원 적립 투자 시뮬레이션 → data/backtest.txt
// 매달 말 입금 → 그달 매수 신호 중 고른 종목에 균등 매수 → 월말 종가가 10이평 아래면 매도 → 현금은 다음 달 재투자
// 연도별 수익률 = 그해 마지막 거래일(12월 월봉 종가) 기준 시간가중(입금액 영향 제외), 누적 = 곱
const { fs, path, DATA, RAW, progress } = require('./common');
const { prep, z, fitRidge, score } = require('./ml');
const { load, trainSet, modelDefs } = require('./data');
const { F, L: ALL } = load(), fi = n => F.indexOf(n);
const { MODELS: ALLM } = modelDefs(F);
const MODELS = ALLM.filter(M => 'ABEF'.includes(M.n[0]));
const DEP = +process.env.DEPOSIT || 1000000;
const COST = process.env.COST !== undefined ? +process.env.COST : 0.003;     // 한 번 사고팔 때마다(편도) 수수료·세금·슬리피지
const START_Y = +process.env.BT_START || 2012;                                // 첫 보고 연도(첫 입금은 그 전해 12월 말)
const SEEDS = +process.env.SEEDS || 30;
const clipT = t => Math.max(-2, Math.min(3, t));
const mi = ym => Math.floor(ym / 100) * 12 + ym % 100, ymOf = k => Math.floor((k - 1) / 12) * 100 + (k - 1) % 12 + 1;
const now = new Date(), CUR = now.getFullYear() * 100 + now.getMonth() + 1;
const START = mi((START_Y - 1) * 100 + 12), END = mi(CUR) - 1;
const yOfK = k => Math.floor((k - 1) / 12);

// ── 가격(월말 종가)·환율
const PXC = new Map();
const rawFile = y => path.join(RAW, y.replace(/[^A-Za-z0-9.\-]/g, '_') + '.json');
function px(y) {
  let o = PXC.get(y); if (o) return o;
  o = { m: new Map(), lastK: 0, lastC: 0 };
  try { JSON.parse(fs.readFileSync(rawFile(y))).forEach(b => { if (b[4] > 0) { const k = mi(b[0]); o.m.set(k, b[4]); if (k >= o.lastK) { o.lastK = k; o.lastC = b[4]; } } }); } catch (e) {}
  PXC.set(y, o); return o;
}
let FX = {}; try { FX = JSON.parse(fs.readFileSync(path.join(DATA, 'fx.json'))); } catch (e) {}
const hasFx = Object.keys(FX).length > 0, fxC = new Map();
function fx(k) {
  if (!hasFx) return 1; if (fxC.has(k)) return fxC.get(k);
  let v = 1; for (let j = k; j > k - 8; j--) if (FX[ymOf(j)]) { v = FX[ymOf(j)]; break; }
  fxC.set(k, v); return v;
}
const US = fi('us'), TURN = fi('turn');

// ── 시험 연도마다 "그때까지 알던 것"으로 학습 → 그해 모든 신호에 점수 (미래 정보 없음)
const scored = MODELS.map(() => new Map());                 // 모델 → Map(ym → [{r, s}] 점수 높은 순)
const byYm = new Map();
ALL.forEach(r => { const a = byYm.get(r.ym) || []; a.push({ r, s: 0 }); byYm.set(r.ym, a); });
const years = []; for (let Y = START_Y - 1; Y <= Math.floor(CUR / 100); Y++) years.push(Y);
years.forEach((Y, yi) => {
  progress('백테스트 점수', yi / years.length);
  const tr0 = trainSet(ALL, Y), te = ALL.filter(r => Math.floor(r.ym / 100) === Y);
  if (tr0.length < 500 || !te.length) return;
  const mm = new Map(); tr0.forEach(r => { const a = mm.get(r.ym) || []; a.push(clipT(r.t)); mm.set(r.ym, a); });
  MODELS.forEach((M, k) => {
    const tr = M.demean ? tr0.map(r => { const a = mm.get(r.ym); return { x: r.x, t: a.length >= 5 ? clipT(r.t) - a.reduce((s, v) => s + v, 0) / a.length : null }; }).filter(r => r.t !== null)
                        : tr0.map(r => ({ x: r.x, t: clipT(r.t) }));
    const P = prep(tr, M.cols), w = fitRidge(tr.map(r => z(r, P)), tr.map(r => r.t), M.lam);
    te.forEach(r => { const a = scored[k].get(r.ym) || []; a.push({ r, s: score(w, z(r, P)) }); scored[k].set(r.ym, a); });
  });
});
scored.forEach(m => m.forEach(a => a.sort((x, y) => y.s - x.s)));

// ── 시뮬레이션
function simulate(pickFn, N) {
  let cash = 0, holds = [], prevAfter = 0, deposits = 0; const rets = [];
  for (let k = START; k <= END; k++) {
    const keep = [];
    for (const h of holds) {
      const p = h.px.m.get(k); if (p !== undefined) h.last = p;
      if (h.sellK !== null && h.sellK <= k) cash += h.sh * h.last * (h.us ? fx(k) : 1) * (1 - COST); else keep.push(h);
    }
    holds = keep;
    cash += DEP; deposits++;
    const picks = pickFn(ymOf(k));
    if (picks.length) {
      const per = cash / (N || picks.length);
      for (const { r } of picks) {
        const o = px(r.y), p = o.m.get(k); if (p === undefined) continue;
        const us = r.x[US] === 1, a = Math.min(per, cash);
        holds.push({ px: o, us, last: p, sh: a * (1 - COST) / (p * (us ? fx(k) : 1)), sellK: r.exoff === null ? null : mi(r.ym) + r.exoff });
        cash -= a;
      }
    }
    let after = cash; for (const h of holds) after += h.sh * h.last * (h.us ? fx(k) : 1);
    if (prevAfter > 0) rets.push({ k, r: (after - DEP) / prevAfter - 1 });
    prevAfter = after;
  }
  // 현재(진행 중인 달): 보유 종목을 가장 최근 종가로 평가
  let nowV = cash; const fxNow = hasFx ? fx(mi(CUR)) : 1;
  for (const h of holds) nowV += h.sh * (h.px.lastK >= END ? h.px.lastC : h.last) * (h.us ? fxNow : 1);
  rets.push({ k: mi(CUR), r: nowV / prevAfter - 1, partial: true });
  return { rets, deposits, val: nowV };
}
function irr(deposits, val) {                       // 월 입금 기준 연환산 내부수익률
  const f = r => { let t = 0; for (let j = 0; j < deposits; j++) t += DEP * Math.pow(1 + r, deposits - j); return t - val; };
  let lo = -0.5, hi = 1; for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (f(m) > 0) hi = m; else lo = m; }
  return Math.pow(1 + lo, 12) - 1;
}
function summ(sim) {
  const yearly = {}, months = sim.rets.length - 1 + Math.min(1, now.getDate() / 30);
  let idx = 1, peak = 1, mdd = 0;
  sim.rets.forEach(({ k, r }) => { const Y = ymOf(k) / 100 | 0; yearly[Y] = (yearly[Y] || 1) * (1 + r); idx *= 1 + r; peak = Math.max(peak, idx); mdd = Math.min(mdd, idx / peak - 1); });
  Object.keys(yearly).forEach(Y => yearly[Y] -= 1);
  return { yearly, cum: idx - 1, cagr: Math.pow(idx, 12 / months) - 1, mdd, val: sim.val, dep: sim.deposits * DEP, irr: irr(sim.deposits, sim.val) };
}
function avgSumm(list) {
  const o = { yearly: {} }; ['cum', 'cagr', 'mdd', 'val', 'dep', 'irr'].forEach(k => o[k] = list.reduce((s, x) => s + x[k], 0) / list.length);
  Object.keys(list[0].yearly).forEach(Y => o.yearly[Y] = list.reduce((s, x) => s + x.yearly[Y], 0) / list.length);
  return o;
}
function rng(seed) { let s = seed * 2654435761 % 4294967296 || 1; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
// 지수에 같은 방식으로 적립
function simIndex(tk, usd) {
  const o = px(tk); if (!o.m.size) return null;
  const rets = []; let units = 0, deposits = 0;
  for (let k = START; k <= END; k++) {
    const p = o.m.get(k), p0 = o.m.get(k - 1); if (p === undefined) continue;
    const f = usd ? fx(k) : 1; units += DEP / (p * f); deposits++;
    if (k > START && p0 !== undefined) rets.push({ k, r: (p * f) / (p0 * (usd ? fx(k - 1) : 1)) - 1 });
  }
  const pNow = o.lastC, fN = usd && hasFx ? fx(mi(CUR)) : 1, last = o.m.get(END) * (usd ? fx(END) : 1);
  rets.push({ k: mi(CUR), r: (pNow * fN) / last - 1, partial: true });
  return { rets, deposits, val: units * pNow * fN };
}

// ── 전략 실행
const R = [];
const add = (n, sim) => R.push({ n, s: summ(sim) });
const total = 2 + MODELS.length * 3 + 2;
let step = 0;
progress('백테스트', step++ / total);
add('전부 균등', simulate(ym => byYm.get(ym) || [], null));
progress('백테스트', step++ / total);
add('거래대금 큰 순 10', simulate(ym => [...(byYm.get(ym) || [])].sort((a, b) => b.r.x[TURN] - a.r.x[TURN]).slice(0, 10), 10));
const rs = []; for (let sd = 1; sd <= SEEDS; sd++) { const rnd = rng(sd); rs.push(summ(simulate(ym => { const a = [...(byYm.get(ym) || [])]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, 10); }, 10))); }
R.push({ n: `무작위 10 (평균 ${SEEDS}회)`, s: avgSumm(rs) });
MODELS.forEach((M, k) => [5, 10, 20].forEach(N => { progress('백테스트', step++ / total); add(`${M.n[0]} 상위 ${N}`, simulate(ym => (scored[k].get(ym) || []).slice(0, N), N)); }));
const ks = simIndex('^KS11', false), sp = simIndex('^GSPC', true);
if (ks) add('코스피(지수)', ks); if (sp) add('S&P500(원화)', sp);
progress('백테스트', 1); process.stdout.write('\n');

// ── 보고서
const pc = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%', won = x => Math.round(x / 10000).toLocaleString() + '만';
const out = [], log = s => out.push(s);
const nDep = R[0].s.dep / DEP;
log(`# 월 ${DEP / 10000}만원 적립 투자 시뮬레이션 (${new Date().toISOString().slice(0, 10)})`);
log(`- 첫 입금 ${START_Y - 1}-12 말부터 매달 말 입금(총 ${nDep}회, 투입 ${won(R[0].s.dep)}원) → 그달 매수 신호 중 고른 종목에 균등 매수 → 월말 종가가 10이평 아래면 매도 → 현금은 다음 달 재투자`);
log(`- 연도별 수익률 = 그해 마지막 거래일(12월 월봉 종가) 기준 시간가중(입금액 영향 제외). 누적 = 연도별 곱. ${CUR.toString().slice(0, 4)}년은 오늘까지.`);
log(`- 점수는 해마다 "그해 1월 1일까지 알 수 있던 정답"으로만 학습(미래 정보 없음). 비용 편도 ${(COST * 100).toFixed(1)}%, ${hasFx ? '미국 종목은 원화 환산(환율 반영)' : '환율 없음(환율 무시)'}, 배당 제외.`);
log(`- 주의: 지금 상장·시총 상위인 종목만 대상이라(상장폐지·망한 종목 없음, 지금 큰 회사 위주) 실제보다 좋게 나와요. 방법끼리 비교가 더 믿을 만해요.`);
const cols = ['전부 균등', '거래대금 큰 순 10', `무작위 10 (평균 ${SEEDS}회)`, 'A 상위 10', 'B 상위 10', 'E 상위 10', 'F 상위 10', '코스피(지수)', 'S&P500(원화)'].map(n => R.find(r => r.n === n)).filter(Boolean);
const short = { '전부 균등': '전부', '거래대금 큰 순 10': '거래대금10' }; cols.forEach(c => c.h = short[c.n] || (c.n.startsWith('무작위') ? '무작위10' : c.n.startsWith('코스피') ? '코스피' : c.n.startsWith('S&P') ? 'S&P' : c.n.replace(' 상위 ', '')));
log(`\n## 연도별 수익률 (A·B·E·F = 점수 모델, 숫자 = 상위 몇 개 종목에 균등 매수)`);
log('연도   ' + cols.map(c => c.h.padStart(10)).join(''));
const Ys = Object.keys(R[0].s.yearly).map(Number).sort();
Ys.forEach(Y => log(`${Y}${Y === Math.floor(CUR / 100) ? '*' : ' '}  ` + cols.map(c => pc(c.s.yearly[Y] ?? 0).padStart(10)).join('')));
log('누적   ' + cols.map(c => pc(c.s.cum).padStart(10)).join(''));
log('연평균 ' + cols.map(c => pc(c.s.cagr).padStart(10)).join(''));
log('최대낙폭' + cols.map(c => pc(c.s.mdd).padStart(10)).join(''));
log('투입   ' + cols.map(c => won(c.s.dep).padStart(10)).join(''));
log('평가금 ' + cols.map(c => won(c.s.val).padStart(10)).join(''));
log('IRR    ' + cols.map(c => pc(c.s.irr).padStart(10)).join(''));
log(`(* = 올해 오늘까지, 평가금·투입 단위 원, IRR = 월 적립 기준 연환산 수익률)`);
log(`\n## 요약 (모든 전략)`);
log('전략                          누적     연평균   최대낙폭   평가금(투입 ' + won(R[0].s.dep) + ')   IRR   이긴 해(코스피보다)');
const ksY = ks ? summ(ks).yearly : null;
R.forEach(r => log(`${r.n.padEnd(26)} ${pc(r.s.cum).padStart(9)} ${pc(r.s.cagr).padStart(8)} ${pc(r.s.mdd).padStart(9)} ${won(r.s.val).padStart(12)} ${pc(r.s.irr).padStart(8)}   ${ksY ? Ys.filter(Y => r.s.yearly[Y] > (ksY[Y] ?? 0)).length + '/' + Ys.length : ''}`));
fs.writeFileSync(path.join(DATA, 'backtest.txt'), out.join('\n') + '\n');
