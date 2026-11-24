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
const C1 = JSON.parse(fs.readFileSync(path.join(__dirname, 'costs.json'), 'utf8'));          // 실제 비용·세금
const C0 = { kr: { commission: 0, sell_tax: {}, etf_exempt: true }, us: { commission: 0, fx_spread: 0, cg_tax_rate: 0, cg_exemption_krw: 0 } };   // 비용 없음(비교용)
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
const US = fi('us'), TURN = fi('turn'), ETF = fi('etf');
const ma10 = (o, k) => { let s = 0; for (let j = k; j > k - 10; j--) { const p = o.m.get(j); if (p === undefined) return null; s += p; } return s / 10; };

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

const kA = MODELS.findIndex(M => M.n[0] === 'A');
// 유동성 필터: 각 달 신호 중 turn 하위 pct 비율 제외 후 점수 상위 N
const pickLiqA = (pct, N) => ym => {
  const all = byYm.get(ym) || [];
  if (!all.length) return [];
  const turns = all.map(x => x.r.x[TURN]).sort((a, b) => a - b);
  const thr = turns[Math.floor(turns.length * pct) - 1] ?? -Infinity;
  return (scored[kA].get(ym) || []).filter(x => x.r.x[TURN] > thr).slice(0, N);
};
// 한국·미국 따로
const pickKrA = N => ym => (scored[kA].get(ym) || []).filter(x => x.r.x[US] === 0).slice(0, N);
const pickUsA = N => ym => (scored[kA].get(ym) || []).filter(x => x.r.x[US] === 1).slice(0, N);

// ── 시뮬레이션
function krTax(C, Y) { const t = C.kr.sell_tax; let v = 0; Object.keys(t).map(Number).sort().forEach(y => { if (y <= Y) v = t[y]; }); return v; }
function simulate(pickFn, N, C, opt = {}) {
  // opt.tp: 익절 배수 (종가 ≥ 매수가 × tp 이면 다음달 매도). opt.tpSame: true면 당월 즉시 매도.
  let cash = 0, holds = [], prevAfter = 0, deposits = 0; const rets = [], usGain = {};
  const usFee = C.us.commission + C.us.fx_spread, val = (h, k) => h.sh * h.last * (h.us ? fx(k) : 1);
  const sellCash = (h, k) => {                         // 한 종목을 팔아 현금으로: 수수료·거래세·(미국) 손익 기록
    const v = val(h, k);
    if (h.us) { const pr = v * (1 - usFee), Y = yOfK(k); usGain[Y] = (usGain[Y] || 0) + pr - h.basis; return pr; }
    return v * (1 - C.kr.commission - (h.etf && C.kr.etf_exempt ? 0 : krTax(C, yOfK(k))));
  };
  const usTax = Y => C.us.cg_tax_rate * Math.max(0, (usGain[Y] || 0) - C.us.cg_exemption_krw);
  for (let k = START; k <= END; k++) {
    const keep = [];
    for (const h of holds) {
      const p = h.px.m.get(k); if (p !== undefined) h.last = p;
      if (!opt.grace && h.sellK !== null && h.sellK <= k) { cash += sellCash(h, k); continue; }
      if (opt.tp) {                                       // 익절: 종가 ≥ tp × 월10이평이면 매도
        if (h.tpSellK != null) {                          // 이미 트리거됨 → 예정 달에 매도
          if (h.tpSellK <= k) { cash += sellCash(h, k); continue; }
        } else {
          const ma = ma10(h.px, k);
          if (ma && h.last >= opt.tp * ma) {
            if (opt.tpSame) { cash += sellCash(h, k); continue; }
            h.tpSellK = k + 1;                            // 다음 달 종가에 매도
          }
        }
      }
      if (opt.tpTrail) {                                  // 트레일링 익절: tp배 위에 있으면 보유, 처음 아래로 떨어지면 매도
        const ma = ma10(h.px, k);
        if (ma) {
          if (h.last >= opt.tpTrail * ma) h.tpTrig = true;
          else if (h.tpTrig) { cash += sellCash(h, k); continue; }
        }
      }
      // 매도 유예: 10이평 아래로 내려와도 바로 팔지 않고 N달 연속 아래일 때만 매도
      if (opt.grace) {                                    // grace 모드: sellK 무시하고 연속 이탈 카운트로 매도
        const ma = ma10(h.px, k);
        if (ma) {
          if (h.last < ma) { h.graceCnt = (h.graceCnt || 0) + 1; if (h.graceCnt >= opt.grace) { cash += sellCash(h, k); continue; } }
          else h.graceCnt = 0;
        }
      }
      keep.push(h);
    }
    holds = keep;
    if ((k - 1) % 12 === 11) {                          // 12월 말: 그해 미국 주식 실현 손익에 양도세(기본공제 후)를 냄
      const Y = yOfK(k), tax = usTax(Y); usGain[Y] = 0;
      if (tax > 0) {
        if (cash >= tax) cash -= tax;
        else { let hv = 0; for (const h of holds) hv += val(h, k); const f = hv > 0 ? Math.min(1, (tax - cash) / hv) : 0; for (const h of holds) h.sh *= 1 - f; cash = 0; }
      }
    }
    cash += DEP; deposits++;
    const picks = pickFn(ymOf(k));
    if (picks.length) {
      const per = cash / (N || picks.length);
      for (const { r } of picks) {
        const o = px(r.y), p = o.m.get(k); if (p === undefined) continue;
        const us = r.x[US] === 1, a = Math.min(per, cash), fee = us ? usFee : C.kr.commission;
        holds.push({ px: o, us, etf: r.x[ETF] === 1, last: p, basis: a, sh: a * (1 - fee) / (p * (us ? fx(k) : 1)), sellK: r.exoff === null ? null : mi(r.ym) + r.exoff });
        cash -= a;
      }
    } else if (holds.length && cash > 0) {
      // 매수 신호 없을 때: 보유 종목에 균등 추가 매수 (reinvest 변형용 — simulate 호출 시 reinvest:true 옵션)
      if (opt.reinvest) {
        const per = cash / holds.length;
        for (const h of holds) {
          const p = h.px.m.get(k); if (!p) continue;
          const a = Math.min(per, cash), fee = h.us ? usFee : C.kr.commission;
          h.sh += a * (1 - fee) / (p * (h.us ? fx(k) : 1)); h.basis += a; cash -= a;
        }
      }
    }
    let after = cash; for (const h of holds) after += val(h, k);
    if (prevAfter > 0) rets.push({ k, r: (after - DEP) / prevAfter - 1 });
    prevAfter = after;
  }
  // 현재(진행 중인 달): 가장 최근 종가로 평가. 올해 이미 실현한 미국 손익의 세금은 미리 뺌
  const kNow = mi(CUR), curY = Math.floor(CUR / 100);
  holds.forEach(h => { h.last = h.px.lastK >= END ? h.px.lastC : h.last; });
  let hv = 0; for (const h of holds) hv += val(h, kNow);
  const nowV = cash + hv - usTax(curY);
  // 전부 팔았다고 가정한 세후 금액(수수료·거래세·미국 양도세 반영)
  let liq = cash, gl = usGain[curY] || 0;
  for (const h of holds) {
    const v = val(h, kNow);
    if (h.us) { const pr = v * (1 - usFee); liq += pr; gl += pr - h.basis; }
    else liq += v * (1 - C.kr.commission - (h.etf && C.kr.etf_exempt ? 0 : krTax(C, curY)));
  }
  liq -= C.us.cg_tax_rate * Math.max(0, gl - C.us.cg_exemption_krw);
  rets.push({ k: kNow, r: nowV / prevAfter - 1, partial: true });
  return { rets, deposits, val: nowV, liq };
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
  return { yearly, cum: idx - 1, cagr: Math.pow(idx, 12 / months) - 1, mdd, val: sim.val, liq: sim.liq, dep: sim.deposits * DEP, irr: irr(sim.deposits, sim.liq) };
}
function avgSumm(list) {
  const o = { yearly: {} }; ['cum', 'cagr', 'mdd', 'val', 'liq', 'dep', 'irr'].forEach(k => o[k] = list.reduce((s, x) => s + x[k], 0) / list.length);
  Object.keys(list[0].yearly).forEach(Y => o.yearly[Y] = list.reduce((s, x) => s + x.yearly[Y], 0) / list.length);
  return o;
}
function rng(seed) { let s = seed * 2654435761 % 4294967296 || 1; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
// 지수에 같은 방식으로 적립(한국 지수는 국내 ETF처럼 거래세 없음, S&P500은 미국 ETF처럼 수수료·환전·양도세)
function simIndex(tk, usd, C) {
  const o = px(tk); if (!o.m.size) return null;
  const usFee = C.us.commission + C.us.fx_spread, fee = usd ? usFee : C.kr.commission;
  const rets = []; let units = 0, deposits = 0;
  for (let k = START; k <= END; k++) {
    const p = o.m.get(k), p0 = o.m.get(k - 1); if (p === undefined) continue;
    const f = usd ? fx(k) : 1; units += DEP * (1 - fee) / (p * f); deposits++;
    if (k > START && p0 !== undefined) rets.push({ k, r: (p * f) / (p0 * (usd ? fx(k - 1) : 1)) - 1 });
  }
  const pNow = o.lastC, fN = usd && hasFx ? fx(mi(CUR)) : 1, last = o.m.get(END) * (usd ? fx(END) : 1);
  rets.push({ k: mi(CUR), r: (pNow * fN) / last - 1, partial: true });
  const v = units * pNow * fN, pr = v * (1 - fee);
  const liq = usd ? pr - C.us.cg_tax_rate * Math.max(0, pr - deposits * DEP - C.us.cg_exemption_krw) : pr;
  return { rets, deposits, val: v, liq };
}

// ── 전략 실행 (실제 비용·세금 = C1, 비교용 비용 없음 = C0)
const R = [], R0 = {};
const pickAll = ym => byYm.get(ym) || [];
const pickTurn = ym => [...pickAll(ym)].sort((a, b) => b.r.x[TURN] - a.r.x[TURN]).slice(0, 10);
const randPick = rnd => ym => { const a = [...pickAll(ym)]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, 10); };
const runRand = C => { const l = []; for (let sd = 1; sd <= SEEDS; sd++) l.push(summ(simulate(randPick(rng(sd)), 10, C))); return avgSumm(l); };
const total = 3 + MODELS.length * 3 + 2 + 4 + 2; let step = 0;
const tick = () => progress('백테스트', step++ / total);
tick(); R.push({ n: '전부 균등', s: summ(simulate(pickAll, null, C1)) }); R0['전부 균등'] = summ(simulate(pickAll, null, C0));
tick(); R.push({ n: '거래대금 큰 순 10', s: summ(simulate(pickTurn, 10, C1)) });
tick(); R.push({ n: `무작위 10 (평균 ${SEEDS}회)`, s: runRand(C1) }); R0[`무작위 10 (평균 ${SEEDS}회)`] = runRand(C0);
MODELS.forEach((M, k) => [5, 10, 20].forEach(N => {
  tick(); const pk = ym => (scored[k].get(ym) || []).slice(0, N), n = `${M.n[0]} 상위 ${N}`;
  R.push({ n, s: summ(simulate(pk, N, C1)) }); if (N === 10) R0[n] = summ(simulate(pk, N, C0));
}));
const ksS = simIndex('^KS11', false, C1), spS = simIndex('^GSPC', true, C1);
if (ksS) R.push({ n: '코스피(지수)', s: summ(ksS) }); if (spS) R.push({ n: 'S&P500(원화)', s: summ(spS) });
tick(); R.push({ n: 'A10 유동성상위50%', s: summ(simulate(pickLiqA(0.5, 10), 10, C1)) });
tick(); R.push({ n: 'A10 유동성상위25%', s: summ(simulate(pickLiqA(0.75, 10), 10, C1)) });
tick(); R.push({ n: 'A10 한국만', s: summ(simulate(pickKrA(10), 10, C1)) });
tick(); R.push({ n: 'A10 미국만', s: summ(simulate(pickUsA(10), 10, C1)) });
tick(); R.push({ n: 'A10 신호없을때보유재투자', s: summ(simulate(ym => (scored[kA].get(ym) || []).slice(0, 10), 10, C1, { reinvest: true })) });
tick(); R.push({ n: '전부 보유재투자', s: summ(simulate(pickAll, null, C1, { reinvest: true })) });

// ── 익절 실험: A5·A10·B5·B10 × tp(1.5·2·2.5·3·4배) × 당월/다음달
const TP_MODELS = [
  { mk: kA, n: 'A5',  N: 5 },
  { mk: kA, n: 'A10', N: 10 },
  { mk: MODELS.findIndex(M => M.n[0] === 'B'), n: 'B5',  N: 5 },
  { mk: MODELS.findIndex(M => M.n[0] === 'B'), n: 'B10', N: 10 },
];
const TP_VALS = [1.5, 2, 2.5, 3, 4];
// A1~A9 tp2x트레일 추가
const A_N_VALS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const tpTotal = TP_MODELS.length * TP_VALS.length * 3 + A_N_VALS.length;
let tpStep = 0;
for (const tm of TP_MODELS) {
  const pk = ym => (scored[tm.mk].get(ym) || []).slice(0, tm.N);
  for (const tp of TP_VALS) {
    progress('익절 실험', tpStep++ / tpTotal);
    R.push({ n: `${tm.n} tp${tp}x다음달`, s: summ(simulate(pk, tm.N, C1, { tp })) });
    progress('익절 실험', tpStep++ / tpTotal);
    R.push({ n: `${tm.n} tp${tp}x당월`, s: summ(simulate(pk, tm.N, C1, { tp, tpSame: true })) });
    progress('익절 실험', tpStep++ / tpTotal);
    R.push({ n: `${tm.n} tp${tp}x트레일`, s: summ(simulate(pk, tm.N, C1, { tpTrail: tp })) });
  }
}
for (const N of A_N_VALS) {
  progress('익절 실험', tpStep++ / tpTotal);
  const pk = ym => (scored[kA].get(ym) || []).slice(0, N);
  R.push({ n: `A${N} tp2x트레일`, s: summ(simulate(pk, N, C1, { tpTrail: 2 })) });
}
// ── 매도 유예 실험: A4 tp2x트레일 + grace(1~4달 연속 이탈 시 매도)
// grace=1 = 기존(1달만 이탈해도 매도), grace=2~4 = 연속 N달 이탈해야 매도
const A4pk = ym => (scored[kA].get(ym) || []).slice(0, 4);
const GRACE_VALS = [1, 2, 3, 4];
const graceTotal = GRACE_VALS.length * 2; // 유예만·tp2x트레일+유예
let graceStep = 0;
for (const g of GRACE_VALS) {
  progress('매도유예 실험', graceStep++ / graceTotal);
  R.push({ n: `A4 유예${g}달`, s: summ(simulate(A4pk, 4, C1, { grace: g })) });
  progress('매도유예 실험', graceStep++ / graceTotal);
  R.push({ n: `A4 tp2x트레일+유예${g}달`, s: summ(simulate(A4pk, 4, C1, { tpTrail: 2, grace: g })) });
}
progress('매도유예 실험', 1); process.stdout.write('\n');
progress('익절 실험', 1); process.stdout.write('\n');
progress('백테스트', 1); process.stdout.write('\n');

// ── 보고서
const pc = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%', won = x => Math.round(x / 10000).toLocaleString() + '만';
const out = [], log = s => out.push(s);
const nDep = R[0].s.dep / DEP, k1 = C1.kr, u1 = C1.us;
log(`# 월 ${DEP / 10000}만원 적립 투자 시뮬레이션 (${new Date().toISOString().slice(0, 10)})`);
log(`- 첫 입금 ${START_Y - 1}-12 말부터 매달 말 입금(총 ${nDep}회, 투입 ${won(R[0].s.dep)}원) → 그달 매수 신호 중 고른 종목에 균등 매수 → 월말 종가가 10이평 이하면 매도 → 현금은 다음 달 재투자`);
log(`- 연도별 수익률 = 그해 마지막 거래일(12월 월봉 종가) 기준 시간가중(입금액 영향 제외, 세금·비용은 낸 시점에 반영). 누적 = 연도별 곱. ${String(CUR).slice(0, 4)}년은 오늘까지.`);
log(`- 점수는 해마다 "그해 1월 1일까지 알 수 있던 정답"으로만 학습(미래 정보 없음). 배당 제외.`);
log(`- 비용·세금(costs.json): 한국 수수료 ${(k1.commission * 100).toFixed(3)}%/편도, 거래세(팔 때) ` + Object.entries(k1.sell_tax).map(([y, v]) => `${y}~ ${(v * 100).toFixed(2)}%`).join(', ') + `, ETF·ETN ${k1.etf_exempt ? '면제' : '부과'}`);
log(`  미국 수수료 ${(u1.commission * 100).toFixed(2)}%/편도 + 환전 ${(u1.fx_spread * 100).toFixed(2)}%/편도, 양도세 ${(u1.cg_tax_rate * 100).toFixed(0)}%(그해 실현 순이익에서 ${u1.cg_exemption_krw / 10000}만원 공제, 손실은 같은 해 이익과 상계·이월 없음, 12월 말에 납부한 것으로 계산), ${hasFx ? '환율 반영' : '환율 무시'}`);
log(`- 주의: 지금 상장·시총 상위인 종목만 대상이라(상장폐지·망한 종목 없음) 절대 수치는 과장될 수 있어요.`);
const cols = ['전부 균등', '거래대금 큰 순 10', `무작위 10 (평균 ${SEEDS}회)`, 'A 상위 10', 'B 상위 10', 'E 상위 10', 'F 상위 10', '코스피(지수)', 'S&P500(원화)'].map(n => R.find(r => r.n === n)).filter(Boolean);
const short = { '전부 균등': '전부', '거래대금 큰 순 10': '거래대금10' }; cols.forEach(c => c.h = short[c.n] || (c.n.startsWith('무작위') ? '무작위10' : c.n.startsWith('코스피') ? '코스피' : c.n.startsWith('S&P') ? 'S&P' : c.n.replace(' 상위 ', '')));
log(`\n## 연도별 수익률 (비용·세금 반영 / A·B·E·F = 점수 모델, 숫자 = 상위 몇 개 종목에 균등 매수)`);
log('연도   ' + cols.map(c => c.h.padStart(10)).join(''));
const Ys = Object.keys(R[0].s.yearly).map(Number).sort();
Ys.forEach(Y => log(`${Y}${Y === Math.floor(CUR / 100) ? '*' : ' '}  ` + cols.map(c => pc(c.s.yearly[Y] ?? 0).padStart(10)).join('')));
log('누적   ' + cols.map(c => pc(c.s.cum).padStart(10)).join(''));
log('연평균 ' + cols.map(c => pc(c.s.cagr).padStart(10)).join(''));
log('최대낙폭' + cols.map(c => pc(c.s.mdd).padStart(10)).join(''));
log('투입   ' + cols.map(c => won(c.s.dep).padStart(10)).join(''));
log('평가금 ' + cols.map(c => won(c.s.val).padStart(10)).join(''));
log('청산시 ' + cols.map(c => won(c.s.liq).padStart(10)).join(''));
log('IRR    ' + cols.map(c => pc(c.s.irr).padStart(10)).join(''));
log(`(* = 올해 오늘까지, 단위 원. 평가금 = 보유 그대로, 청산시 = 전부 팔았다고 가정한 세후 금액, IRR = 월 적립·청산시 기준 연환산 수익률)`);

// A1~A9 tp2x트레일 연도별 수익률
const tpCols2 = A_N_VALS.map(N => R.find(r => r.n === `A${N} tp2x트레일`)).filter(Boolean);
tpCols2.forEach(c => c.h = c.n.replace(' tp2x트레일', ''));
log(`\n## A1~A9 tp2x트레일 연도별 수익률`);
log('연도   ' + tpCols2.map(c => c.h.padStart(10)).join(''));
Ys.forEach(Y => log(`${Y}${Y === Math.floor(CUR / 100) ? '*' : ' '}  ` + tpCols2.map(c => pc(c.s.yearly[Y] ?? 0).padStart(10)).join('')));
log('연평균 ' + tpCols2.map(c => pc(c.s.cagr).padStart(10)).join(''));
log('2020제외' + tpCols2.map(c => { const ys = Object.entries(c.s.yearly).filter(([Y]) => +Y !== 2020); const m = ys.length; const cum = ys.reduce((p,[,v])=>p*(1+v),1); return pc(Math.pow(cum,12/m)-1).padStart(10); }).join(''));
log('최대낙폭' + tpCols2.map(c => pc(c.s.mdd).padStart(10)).join(''));
log(`\n## 비용·세금이 깎은 만큼 (연평균 수익률, 같은 전략을 비용 없이 vs 실제 비용으로)`);
log('전략                          비용 없음   실제 비용    차이');
Object.keys(R0).forEach(n => { const a = R0[n].cagr, b = R.find(r => r.n === n).s.cagr; log(`${n.padEnd(26)} ${pc(a).padStart(9)} ${pc(b).padStart(10)} ${((b - a) * 100).toFixed(1).padStart(7)}%p`); });
log(`\n## 요약 (모든 전략, 비용·세금 반영)`);
log('전략                          누적     연평균   최대낙폭   청산시 세후(투입 ' + won(R[0].s.dep) + ')   IRR   이긴 해(코스피보다)');
const ksY = ksS ? summ(ksS).yearly : null;
R.forEach(r => log(`${r.n.padEnd(26)} ${pc(r.s.cum).padStart(9)} ${pc(r.s.cagr).padStart(8)} ${pc(r.s.mdd).padStart(9)} ${won(r.s.liq).padStart(14)} ${pc(r.s.irr).padStart(8)}   ${ksY ? Ys.filter(Y => r.s.yearly[Y] > (ksY[Y] ?? 0)).length + '/' + Ys.length : ''}`));
fs.writeFileSync(path.join(DATA, 'backtest.txt'), out.join('\n') + '\n');
