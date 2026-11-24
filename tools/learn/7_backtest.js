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
const avg = (a, s, e) => { let t = 0; for (let k = s; k <= e; k++) t += a[k]; return t / (e - s + 1); };
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
// 거시 지표 (ff_chg12 등) — ymOf(k) → ym 형태로 lookup
let MACRO = {}; try { MACRO = JSON.parse(fs.readFileSync(path.join(DATA, 'macro.json'))); } catch (e) {}
const ffChg12 = k => { const m = MACRO[ymOf(k)]; return m && m.ff_chg12 != null ? m.ff_chg12 : null; };

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

// ── 매도 유예 모델: 매도 신호(종가<10이평) 달의 가격 지표 → 3개월 뒤 수익 예측 → 높으면 유예
// 매도 신호 이벤트를 원시 월봉에서 직접 생성 (종가·이평만으로 계산 가능한 가격 지표 사용)
const sellEvents = [];
const listAll = JSON.parse(fs.readFileSync(path.join(DATA, 'lists.json')));
for (const s of listAll) {
  const o = px(s.y); if (o.m.size < 25) continue;
  const ks = [...o.m.keys()].sort((a, b) => a - b), cs = ks.map(k => o.m.get(k)), n = cs.length;
  const ma = cs.map((_, i) => i >= 9 ? avg(cs, i - 9, i) : null);
  const above = cs.map((c, i) => ma[i] == null ? null : c > ma[i]);
  const ma12 = cs.map((_, i) => i >= 11 ? avg(cs, i - 11, i) : null);
  const ma24 = cs.map((_, i) => i >= 23 ? avg(cs, i - 23, i) : null);
  for (let i = 25; i < n; i++) {
    const ym = ymOf(ks[i]);
    if (ym < 200812) continue;
    if (above[i - 1] !== true || above[i] !== false) continue;      // 매도 신호: 10이평 아래로 전환
    if (i + 3 >= n) continue;                                       // 3개월 뒤 수익 필요
    const fwd = Math.log(cs[i + 3] / cs[i]);                        // 유예했을 때 3개월 뒤 수익
    let below = 0; for (let k = i - 1; k >= 0 && above[k] === false; k--) below++;
    let up = 0; for (let k = i - 5; k <= i; k++) if (k > 0 && cs[k] > cs[k - 1]) up++;
    const lr = []; for (let k = i - 11; k <= i; k++) lr.push(Math.log(cs[k] / cs[k - 1]));
    const m = avg(lr, 0, 11), volat = Math.sqrt(lr.reduce((t, x) => t + (x - m) ** 2, 0) / 12);
    const hi36 = Math.max(...cs.slice(Math.max(0, i - 36), i));
    sellEvents.push({ ym, y: s.y, t: fwd, x: [
      cs[i] / ma[i] - 1, ma[i] / ma[i - 1] - 1, ma[i] / ma[i - 3] - 1, ma[i] / ma[i - 6] - 1,
      cs[i] / cs[i - 1] - 1, cs[i] / cs[i - 3] - 1, cs[i] / cs[Math.max(0, i - 12)] - 1,
      cs[i] / hi36 - 1, ma12[i] ? cs[i] / ma12[i] - 1 : 0, ma24[i] ? ma[i] / ma24[i] - 1 : 0,
      volat, below, up
    ]});
  }
}
// 시간 순서 검증: 각 연도마다 그 전까지만 학습 → 그해 매도 신호에 유예 점수
const sellYrs = [...new Set(sellEvents.map(r => Math.floor(r.ym / 100)))].sort();
const sellScored = new Map();  // key "ym_y" → 유예 점수(높을수록 유예 가치 ↑)
const SF_IDX = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
for (const Y of sellYrs) {
  if (Y < sellYrs[0] + 3) continue;
  const tr = sellEvents.filter(r => Math.floor(r.ym / 100) < Y);
  const te = sellEvents.filter(r => Math.floor(r.ym / 100) === Y);
  if (tr.length < 300 || !te.length) continue;
  const P = prep(tr, SF_IDX), w = fitRidge(tr.map(r => z(r, P)), tr.map(r => clipT(r.t)), 1000);
  te.forEach(r => sellScored.set(r.ym + '_' + r.y, score(w, z(r, P))));
}
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
function simulate(pickFn, N, C, opt = {}, dep = DEP) {
  // opt.tp: 익절 배수 (종가 ≥ 매수가 × tp 이면 다음달 매도). opt.tpSame: true면 당월 즉시 매도.
  let cash = 0, holds = [], prevAfter = 0, deposits = 0; const rets = [], usGain = {};
  const trades = opt.log ? [] : null;                     // 거래 기록 (opt.log=true일 때만)
  const snapshots = opt.log ? new Map() : null;           // ym → 보유 종목 스냅샷
  const usFee = C.us.commission + C.us.fx_spread, val = (h, k) => h.sh * h.last * (h.us ? fx(k) : 1);
  const sellCash = (h, k, reason) => {                   // 한 종목을 팔아 현금으로: 수수료·거래세·(미국) 손익 기록
    const v = val(h, k);
    let got;
    if (h.us) { const pr = v * (1 - usFee), Y = yOfK(k); usGain[Y] = (usGain[Y] || 0) + pr - h.basis; got = pr; }
    else got = v * (1 - C.kr.commission - (h.etf && C.kr.etf_exempt ? 0 : krTax(C, yOfK(k))));
    if (trades && h.buyYm) trades.push({ y: h.y, buyYm: h.buyYm, sellYm: ymOf(k), buyPx: h.buyPx, sellPx: h.last,
      ret: got / h.basis - 1, score: h.buyScore, feats: h.buyFeats, reason: reason || 'ma10' });
    return got;
  };
  const usTax = Y => C.us.cg_tax_rate * Math.max(0, (usGain[Y] || 0) - C.us.cg_exemption_krw);
  for (let k = START; k <= END; k++) {
    const keep = [];
    for (const h of holds) {
      const p = h.px.m.get(k); if (p !== undefined) h.last = p;
      if (!opt.grace && h.sellK !== null && h.sellK <= k) { cash += sellCash(h, k, 'ma10'); continue; }
      // 손절: 종가가 매수가 대비 opt.sl 비율 이하로 하락 시 즉시 매도
      if (opt.sl && h.buyPx) {
        const pKrw = h.last * (h.us ? fx(k) : 1), buyKrw = h.buyPx * (h.us ? fx(mi(h.buyYm)) : 1);
        if (pKrw <= buyKrw * (1 - opt.sl)) { cash += sellCash(h, k, 'sl'); continue; }
      }
      if (opt.tp) {                                       // 익절: 종가 ≥ tp × 월10이평이면 매도
        if (h.tpSellK != null) {                          // 이미 트리거됨 → 예정 달에 매도
          if (h.tpSellK <= k) { cash += sellCash(h, k, 'tp'); continue; }
        } else {
          const ma = ma10(h.px, k);
          if (ma && h.last >= opt.tp * ma) {
            if (opt.tpSame) { cash += sellCash(h, k, 'tp'); continue; }
            h.tpSellK = k + 1;                            // 다음 달 종가에 매도
          }
        }
      }
      if (opt.tpTrail) {                                  // 트레일링 익절: tp배 위에 있으면 보유, 처음 아래로 떨어지면 매도
        const ma = ma10(h.px, k);
        if (ma) {
          if (h.last >= opt.tpTrail * ma) h.tpTrig = true;
          else if (h.tpTrig) { cash += sellCash(h, k, 'tpTrail'); continue; }
        }
      }
      // 매도 유예: 10이평 아래로 내려와도 바로 팔지 않고 N달 연속 아래일 때만 매도
      if (opt.grace) {                                    // grace 모드: sellK 무시하고 연속 이탈 카운트로 매도
        const ma = ma10(h.px, k);
        if (ma) {
          if (h.last < ma) {
            // opt.graceRate: 금리 조건부 유예 — 금리 인상 중(ff_chg12>0)이면 유예 없이 바로 매도
            const ff = opt.graceRate ? ffChg12(k) : null;
            const graceN = (ff != null && ff > 0) ? 1 : opt.grace;  // 금리 인상 중→ 1달(=즉시), 아니면 N달
            h.graceCnt = (h.graceCnt || 0) + 1;
            if (h.graceCnt >= graceN) { cash += sellCash(h, k, ff != null && ff > 0 ? 'ma10-금리인상' : 'ma10-유예만료'); continue; }
          } else h.graceCnt = 0;
        }
      }
      // ML 조건부 유예: 매도 신호 달에 sellScored 점수 ≥ 임계값이면 최대 opt.graceML달 유예
      if (opt.graceML != null) {
        const ma = ma10(h.px, k);
        if (ma && h.last < ma) {                          // 10이평 아래 → 매도 후보
          if (h.mlGrace == null) {                        // 처음 이탈
            const sc = sellScored.get(ymOf(k) + '_' + h.y);
            h.mlGrace = (sc != null && sc > 0) ? 1 : 0;  // 점수 양수면 유예
          } else if (h.mlGrace > 0 && h.mlGrace < opt.graceML) {
            h.mlGrace++;                                  // 계속 유예
          } else {
            cash += sellCash(h, k); continue;             // 유예 소진 → 매도
          }
        } else { h.mlGrace = null; }                      // 이평 위로 복귀 → 카운터 초기화
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
    cash += dep; deposits++;
    const picks = pickFn(ymOf(k));
    if (picks.length) {
      const per = cash / (N || picks.length);
      for (const { r } of picks) {
        const o = px(r.y), p = o.m.get(k); if (p === undefined) continue;
        const us = r.x[US] === 1, fee = us ? usFee : C.kr.commission;
        const pKrw = p * (us ? fx(k) : 1);                // 원화 환산 주가
        // 주식 단위 제한(opt.lotSize): 미국은 소수점 허용, 한국은 1주 단위
        let sh, a;
        if (opt.lotSize && !us) {
          const lots = Math.floor(Math.min(per, cash) * (1 - fee) / pKrw);  // 살 수 있는 주 수
          if (lots < 1) continue;                           // 1주도 못 사면 패스
          sh = lots; a = lots * pKrw / (1 - fee);          // 실제 쓴 돈
          a = Math.min(a, cash);
        } else {
          a = Math.min(per, cash);
        // 슬리피지: 거래대금 대비 주문 비율에 따라 체결가 불리 (opt.slip = 충격계수)
        // 충격비용 = slip × (주문금액 / 거래대금). 거래대금은 turn 역산: turn=log10(avgVol*price+1)
        if (opt.slip && r.x[TURN] > 0) {
          const dailyVal = (Math.pow(10, r.x[TURN]) - 1) * 20; // 월 → 일 거래대금 근사(20거래일)
          if (dailyVal > 0) {
            const impact = Math.min(0.05, opt.slip * a / dailyVal); // 최대 5%
            sh = a * (1 - fee - impact) / pKrw;
          } else { sh = a * (1 - fee) / pKrw; }
        } else { sh = a * (1 - fee) / pKrw; }
        }
        holds.push({ px: o, y: r.y, us, etf: r.x[ETF] === 1, last: p, basis: a, sh, sellK: r.exoff === null ? null : mi(r.ym) + r.exoff,
          buyYm: ymOf(k), buyPx: p, buyScore: (scored[kA].get(ymOf(k)) || []).find(e => e.r.y === r.y)?.s ?? 0,
          buyFeats: r.x });
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
    if (prevAfter > 0) rets.push({ k, r: (after - dep) / prevAfter - 1 });
    prevAfter = after;
    // 보유 스냅샷 (opt.log)
    if (snapshots) snapshots.set(ymOf(k), holds.map(h => ({ y: h.y, buyYm: h.buyYm, buyPx: h.buyPx, curPx: h.last, basis: h.basis, sh: h.sh, score: h.buyScore })));
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
  return { rets, deposits, depAmt: dep, val: nowV, liq, trades, snapshots };
}
function irr(deposits, val, dep = DEP) {                       // 월 입금 기준 연환산 내부수익률
  const f = r => { let t = 0; for (let j = 0; j < deposits; j++) t += dep * Math.pow(1 + r, deposits - j); return t - val; };
  let lo = -0.5, hi = 1; for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (f(m) > 0) hi = m; else lo = m; }
  return Math.pow(1 + lo, 12) - 1;
}
function summ(sim) {
  const yearly = {}, months = sim.rets.length - 1 + Math.min(1, now.getDate() / 30);
  let idx = 1, peak = 1, mdd = 0;
  sim.rets.forEach(({ k, r }) => { const Y = ymOf(k) / 100 | 0; yearly[Y] = (yearly[Y] || 1) * (1 + r); idx *= 1 + r; peak = Math.max(peak, idx); mdd = Math.min(mdd, idx / peak - 1); });
  Object.keys(yearly).forEach(Y => yearly[Y] -= 1);
  return { yearly, cum: idx - 1, cagr: Math.pow(idx, 12 / months) - 1, mdd, val: sim.val, liq: sim.liq, dep: sim.deposits * sim.depAmt, irr: irr(sim.deposits, sim.liq, sim.depAmt) };
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
// 금리 조건부 유예: 금리 인상 중이면 즉시 매도, 아니면 N달 유예
for (const g of [2, 3]) {
  progress('매도유예 실험', graceStep++ / (graceTotal + 4));
  R.push({ n: `A4 금리유예${g}달`, s: summ(simulate(A4pk, 4, C1, { grace: g, graceRate: true })) });
  progress('매도유예 실험', graceStep++ / (graceTotal + 4));
  R.push({ n: `A4 tp2x트레일+금리유예${g}달`, s: summ(simulate(A4pk, 4, C1, { tpTrail: 2, grace: g, graceRate: true })) });
}
// ML 조건부 유예 실험: A4·A4 tp2x트레일 × 유예1달/2달
const ML_GRACE_VALS = [1, 2];
const mlGraceTotal = ML_GRACE_VALS.length * 2;
let mlGraceStep = 0;
for (const g of ML_GRACE_VALS) {
  progress('ML유예 실험', mlGraceStep++ / mlGraceTotal);
  R.push({ n: `A4 ML유예${g}달`, s: summ(simulate(A4pk, 4, C1, { graceML: g })) });
  progress('ML유예 실험', mlGraceStep++ / mlGraceTotal);
  R.push({ n: `A4 tp2x트레일+ML유예${g}달`, s: summ(simulate(A4pk, 4, C1, { tpTrail: 2, graceML: g })) });
}
progress('ML유예 실험', 1); process.stdout.write('\n');
progress('매도유예 실험', 1); process.stdout.write('\n');
progress('익절 실험', 1); process.stdout.write('\n');

// ── 주식 단위 제한 실험: 한국 1주 단위, 미국 소수점 허용
// 월 투자금별(100·300·500·1000만원) × 주요 전략 3개
const LOT_DEPOSITS = [1000000, 3000000, 5000000, 10000000];
const lotTotal = LOT_DEPOSITS.length * 3;
let lotStep = 0;
for (const dep of LOT_DEPOSITS) {
  const C1lot = C1;
  const lk = ym => (scored[kA].get(ym) || []).slice(0, 4);
  const dLabel = dep / 10000 + '만';
  progress('단위제한', lotStep++ / lotTotal);
  R.push({ n: `A4 단위제한${dLabel}`, s: summ(simulate(lk, 4, C1lot, { lotSize: true }, dep)) });
  progress('단위제한', lotStep++ / lotTotal);
  R.push({ n: `A4 tp2x트레일 단위제한${dLabel}`, s: summ(simulate(lk, 4, C1lot, { tpTrail: 2, lotSize: true }, dep)) });
  progress('단위제한', lotStep++ / lotTotal);
  R.push({ n: `A4 tp2x금리유예2달 단위제한${dLabel}`, s: summ(simulate(lk, 4, C1lot, { tpTrail: 2, grace: 2, graceRate: true, lotSize: true }, dep)) });
}
progress('단위제한', 1); process.stdout.write('\n');

// ── 1. 손절 실험: A4 tp2x트레일 × sl(10%·15%·20%·25% 하락 시 손절)
const SL_VALS = [0.10, 0.15, 0.20, 0.25];
const slTotal = SL_VALS.length * 2;
let slStep = 0;
for (const sl of SL_VALS) {
  progress('손절 실험', slStep++ / slTotal);
  R.push({ n: `A4 tp2x트레일+손절${Math.round(sl*100)}%`, s: summ(simulate(A4pk, 4, C1, { tpTrail: 2, sl })) });
  progress('손절 실험', slStep++ / slTotal);
  R.push({ n: `A4 tp2x금리유예2달+손절${Math.round(sl*100)}%`, s: summ(simulate(A4pk, 4, C1, { tpTrail: 2, grace: 2, graceRate: true, sl })) });
}
progress('손절 실험', 1); process.stdout.write('\n');

// ── 2. 슬리피지 실험: A4 tp2x트레일 × slip 계수(0.5·1·2·5)
// slip=1: 주문금액이 일 거래대금의 100%면 충격비용 1%(선형). 현실: 0.5~2 사이
const SLIP_VALS = [0.5, 1, 2, 5];
const slipTotal = SLIP_VALS.length * 2;
let slipStep = 0;
for (const slip of SLIP_VALS) {
  progress('슬리피지 실험', slipStep++ / slipTotal);
  R.push({ n: `A4 tp2x트레일+slip${slip}`, s: summ(simulate(A4pk, 4, C1, { tpTrail: 2, slip })) });
  progress('슬리피지 실험', slipStep++ / slipTotal);
  R.push({ n: `A4 tp2x금리유예2달+slip${slip}`, s: summ(simulate(A4pk, 4, C1, { tpTrail: 2, grace: 2, graceRate: true, slip })) });
}
progress('슬리피지 실험', 1); process.stdout.write('\n');

// ── 3. 샘플 외 검증: 2011~2020 학습, 2021~2026 시험
// BT_START=2021로 설정하고 채점·시뮬 재실행
const OOS_START = 202101, OOS_START_Y = 2021;
const OOS_START_K = mi(OOS_START);
// 2021 이후만 시뮬 (scored는 그대로지만 2021 이전 채점에 미래가 안 섞임: 이미 시간 순서 검증)
function simulateOOS(pickFn, N, C, opt = {}) {
  let cash = 0, holds = [], prevAfter = 0, deposits = 0; const rets = [], usGain = {};
  const usFee = C.us.commission + C.us.fx_spread, val = (h, k) => h.sh * h.last * (h.us ? fx(k) : 1);
  const sellCashO = (h, k) => { const v = val(h,k); if(h.us){const pr=v*(1-usFee),Y=yOfK(k);usGain[Y]=(usGain[Y]||0)+pr-h.basis;return pr;} return v*(1-C.kr.commission-(h.etf&&C.kr.etf_exempt?0:krTax(C,yOfK(k)))); };
  const usTax = Y => C.us.cg_tax_rate * Math.max(0, (usGain[Y]||0) - C.us.cg_exemption_krw);
  for (let k = OOS_START_K; k <= END; k++) {
    const keep = [];
    for (const h of holds) {
      const p = h.px.m.get(k); if (p !== undefined) h.last = p;
      if (!opt.grace && h.sellK !== null && h.sellK <= k) { cash += sellCashO(h,k); continue; }
      if (opt.tpTrail) { const ma=ma10(h.px,k); if(ma){if(h.last>=opt.tpTrail*ma)h.tpTrig=true;else if(h.tpTrig){cash+=sellCashO(h,k);continue;}}}
      if (opt.grace) { const ma=ma10(h.px,k); if(ma){if(h.last<ma){const ff=opt.graceRate?ffChg12(k):null;const gN=(ff!=null&&ff>0)?1:opt.grace;h.graceCnt=(h.graceCnt||0)+1;if(h.graceCnt>=gN){cash+=sellCashO(h,k);continue;}}else h.graceCnt=0;}}
      keep.push(h);
    }
    holds = keep;
    if ((k-1)%12===11){const Y=yOfK(k),tax=usTax(Y);usGain[Y]=0;if(tax>0){if(cash>=tax)cash-=tax;else{let hv=0;for(const h of holds)hv+=val(h,k);const f=hv>0?Math.min(1,(tax-cash)/hv):0;for(const h of holds)h.sh*=1-f;cash=0;}}}
    cash += DEP; deposits++;
    const picks = pickFn(ymOf(k));
    if (picks.length) {
      const per = cash / (N || picks.length);
      for (const { r } of picks) {
        const o=px(r.y),p=o.m.get(k);if(p===undefined)continue;
        const us=r.x[US]===1,fee=us?usFee:C.kr.commission,pKrw=p*(us?fx(k):1);
        const a=Math.min(per,cash),sh=a*(1-fee)/pKrw;
        holds.push({px:o,y:r.y,us,etf:r.x[ETF]===1,last:p,basis:a,sh,buyPx:p,buyYm:ymOf(k),sellK:r.exoff===null?null:mi(r.ym)+r.exoff});
        cash-=a;
      }
    }
    let after=cash;for(const h of holds)after+=val(h,k);
    if(prevAfter>0)rets.push({k,r:(after-DEP)/prevAfter-1});
    prevAfter=after;
  }
  const kNow=mi(CUR),curY=Math.floor(CUR/100);
  holds.forEach(h=>{h.last=h.px.lastK>=END?h.px.lastC:h.last;});
  let hv=0;for(const h of holds)hv+=val(h,kNow);
  const nowV=cash+hv-usTax(curY);
  let liq=cash,gl=usGain[curY]||0;
  for(const h of holds){const v=val(h,kNow);if(h.us){const pr=v*(1-usFee);liq+=pr;gl+=pr-h.basis;}else liq+=v*(1-C.kr.commission-(h.etf&&C.kr.etf_exempt?0:krTax(C,curY)));}
  liq-=C.us.cg_tax_rate*Math.max(0,gl-C.us.cg_exemption_krw);
  rets.push({k:kNow,r:nowV/prevAfter-1,partial:true});
  return {rets,deposits,depAmt:DEP,val:nowV,liq};
}
const oosStrategies = [
  { n: 'OOS A4 원본', opt: {} },
  { n: 'OOS A4 tp2x트레일', opt: { tpTrail: 2 } },
  { n: 'OOS A4 tp2x금리유예2달', opt: { tpTrail: 2, grace: 2, graceRate: true } },
  { n: 'OOS A10 tp2x트레일', opt: { tpTrail: 2 } },
];
const oosTotal = oosStrategies.length;
let oosStep = 0;
for (const st of oosStrategies) {
  progress('샘플외검증', oosStep++ / oosTotal);
  const isA10 = st.n.includes('A10');
  const pk = isA10 ? ym=>(scored[kA].get(ym)||[]).slice(0,10) : A4pk;
  const N = isA10 ? 10 : 4;
  R.push({ n: st.n, s: summ(simulateOOS(pk, N, C1, st.opt)) });
}
progress('샘플외검증', 1); process.stdout.write('\n');
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

// ── 매매일지(trades.json): A4 tp2x트레일+금리유예2달, 월 100만원
progress('매매일지', 0);
const journalSim = simulate(A4pk, 4, C1, { tpTrail: 2, grace: 2, graceRate: true, log: true });
const listData = JSON.parse(fs.readFileSync(path.join(DATA, 'lists.json')));
const nameMap = new Map(listData.map(s => [s.y, { name: s.name, market: s.mk, code: s.code }]));
const journal = {
  meta: { strategy: 'A4 tp2x트레일+금리유예2달', dep: 1000000, made: new Date().toISOString() },
  features: F,
  trades: (journalSim.trades || []).map(t => ({
    y: t.y, name: nameMap.get(t.y)?.name || t.y, market: nameMap.get(t.y)?.market || '',
    code: nameMap.get(t.y)?.code || '',
    buyYm: t.buyYm, sellYm: t.sellYm, buyPx: t.buyPx, sellPx: t.sellPx,
    ret: +t.ret.toFixed(4), score: +t.score.toFixed(4), reason: t.reason,
    feats: t.feats ? F.map((f, i) => [f, +((t.feats[i] || 0)).toFixed(4)]) : []
  })),
  snapshots: journalSim.snapshots ? Object.fromEntries([...journalSim.snapshots].map(([ym, h]) => [ym, h.map(x => ({ y: x.y, name: nameMap.get(x.y)?.name || x.y, code: nameMap.get(x.y)?.code || '', buyYm: x.buyYm, buyPx: x.buyPx, curPx: x.curPx, ret: x.curPx ? +((x.curPx / x.buyPx - 1)).toFixed(4) : 0, score: +x.score.toFixed(4) }))])) : {}
};
fs.writeFileSync(path.join(DATA, 'trades.json'), JSON.stringify(journal));
progress('매매일지', 1); process.stdout.write('\n');
