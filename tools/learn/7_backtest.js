// 7단계: 월 100만원 적립 투자 시뮬레이션 → data/backtest.txt
// 매달 말 입금 → 그달 매수 신호 중 고른 종목에 균등 매수 → 월말 종가가 10이평 아래면 매도 → 현금은 다음 달 재투자
// 연도별 수익률 = 그해 마지막 거래일(12월 월봉 종가) 기준 시간가중(입금액 영향 제외), 누적 = 곱
const { fs, path, DATA, RAW, progress } = require('./common');
const { prep, z, fitRidge, score } = require('./ml');
const { load, trainSet, trainSetL, modelDefs } = require('./data');
const GBM = require('./gbm');
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
// 월별 첫 거래일 종가 (2c_firstday.js가 받음): data/first/<종목>.json = [[ym, 시가, 종가], ...]
const FDC = new Map();
function fdPx(y, k) {
  let m = FDC.get(y);
  if (!m) { m = new Map(); try { JSON.parse(fs.readFileSync(path.join(DATA, 'first', y.replace(/[^A-Za-z0-9.\-]/g, '_') + '.json'))).forEach(b => { if (b[2] > 0) m.set(mi(b[0]), b[2]); }); } catch (e) {} FDC.set(y, m); }
  return m.get(k);
}
const US = fi('us'), TURN = fi('turn'), ETF = fi('etf');
const ma10 = (o, k) => { let s = 0; for (let j = k; j > k - 10; j--) { const p = o.m.get(j); if (p === undefined) return null; s += p; } return s / 10; };
// 거시 지표 (ff_chg12 등) — ymOf(k) → ym 형태로 lookup
let MACRO = {}; try { MACRO = JSON.parse(fs.readFileSync(path.join(DATA, 'macro.json'))); } catch (e) {}
const ffChg12 = k => { const m = MACRO[ymOf(k)]; return m && m.ff_chg12 != null ? m.ff_chg12 : null; };
const krChg12 = k => { const m = MACRO[ymOf(k)]; return m && m.kr_rate_chg12 != null && m.kr_rate_chg12 !== '' ? m.kr_rate_chg12 : null; };   // 한국 금리 12개월 변화(2b_macro.js, 없으면 null)

// ── 시험 연도마다 "그때까지 알던 것"으로 학습 → 그해 모든 신호에 점수 (미래 정보 없음)
const scored = MODELS.map(() => new Map());                 // 모델 → Map(ym → [{r, s}] 점수 높은 순)
const byYm = new Map();
ALL.forEach(r => { const a = byYm.get(r.ym) || []; a.push({ r, s: 0 }); byYm.set(r.ym, a); });
const KA0 = MODELS.findIndex(M => M.n[0] === 'A'), KF0 = MODELS.findIndex(M => M.n[0] === 'F');
const scoredMk = {};                                          // 'A한국'·'F미국' 등: 한 시장 안에서만 학습하고 그 시장 신호에만 점수(점수 살리기 실험)
['A', 'F'].forEach(m => ['한국', '미국'].forEach(mk => { scoredMk[m + mk] = new Map(); }));
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
  // 시장별 모델: 그 시장 신호만으로 학습(시간 순서는 같음: 그해 1월 1일까지 알던 정답만)
  [KA0, KF0].forEach(k => [['한국', false], ['미국', true]].forEach(([mkName, isUS]) => {
    const M = MODELS[k], inM = r => (r.x[US] === 1) === isUS;
    const trm = tr0.filter(inM), tem = te.filter(inM); if (trm.length < 300 || !tem.length) return;
    const mm2 = new Map(); trm.forEach(r => { const a = mm2.get(r.ym) || []; a.push(clipT(r.t)); mm2.set(r.ym, a); });
    const tr = M.demean ? trm.map(r => { const a = mm2.get(r.ym); return { x: r.x, t: a.length >= 5 ? clipT(r.t) - a.reduce((s, v) => s + v, 0) / a.length : null }; }).filter(r => r.t !== null)
                        : trm.map(r => ({ x: r.x, t: clipT(r.t) }));
    const P = prep(tr, M.cols), w = fitRidge(tr.map(r => z(r, P)), tr.map(r => r.t), M.lam), key = M.n[0] + mkName;
    tem.forEach(r => { const a = scoredMk[key].get(r.ym) || []; a.push({ r, s: score(w, z(r, P)) }); scoredMk[key].set(r.ym, a); });
  }));
});
Object.values(scoredMk).forEach(m => m.forEach(a => a.sort((x, y) => y.s - x.s)));
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
  const led = opt.log ? new Map() : null;                 // ym → 그달 입금·매도·세금·매수·못 산 종목·월말 현금(매매일지 장부)
  let cur = null;                                         // 지금 처리 중인 달의 장부
  const usFee = C.us.commission + C.us.fx_spread, val = (h, k) => h.sh * h.last * (h.us ? fx(k) : 1);
  const sellCash = (h, k, reason) => {                   // 한 종목을 팔아 현금으로: 수수료·거래세·(미국) 손익 기록
    const v = val(h, k);
    let got, taxR = 0;
    if (h.us) { const pr = v * (1 - usFee), Y = yOfK(k); usGain[Y] = (usGain[Y] || 0) + pr - h.basis; got = pr; }
    else { taxR = (h.etf && C.kr.etf_exempt ? 0 : krTax(C, yOfK(k))); got = v * (1 - C.kr.commission - taxR); }
    if (cur) cur.sells.push({ y: h.y, buyYm: h.buyYm, us: h.us, sh: h.sh, px: h.last, fx: h.us ? fx(k) : null, gross: v,
      feeRate: h.us ? usFee : C.kr.commission, fee: v * (h.us ? usFee : C.kr.commission), taxRate: taxR, tax: v * taxR,
      amt: got, basis: h.basis, ret: got / h.basis - 1, reason: reason || 'ma10' });
    if (trades && h.buyYm) trades.push({ y: h.y, buyYm: h.buyYm, sellYm: ymOf(k), buyPx: h.buyPx, sellPx: h.last,
      ret: got / h.basis - 1, score: h.buyScore, feats: h.buyFeats, reason: reason || 'ma10' });
    return got;
  };
  const usTax = Y => C.us.cg_tax_rate * Math.max(0, (usGain[Y] || 0) - C.us.cg_exemption_krw);
  const doBuys = (sigK, k, priceAt) => {      // sigK: 신호가 난 달, k: 체결하는 달, priceAt: 체결가(월말 종가 또는 다음 달 첫날 종가)
    const picks = pickFn(ymOf(sigK));
    // opt.fill: 점수 순위대로 후보(opt.cand)를 보며 1주도 못 사는 종목은 건너뛰고 다음 순위를 산다. 종목 수가 N에 못 미치면 있는 종목끼리 현금을 나눔
    const fill = !!(opt.fill && opt.cand), list = fill ? opt.cand(ymOf(sigK)) : picks;
    if (list.length) {
      const per0 = cash / (N || picks.length);
      let slots = N || picks.length;
      for (let li = 0; li < list.length; li++) {
        if (fill && slots <= 0) break;
        const { r } = list[li];
        const per = fill ? cash / Math.min(slots, list.length - li) : per0;      // fill: 남은 현금 ÷ (남은 자리, 남은 후보 중 작은 쪽)
        const o = px(r.y), p = priceAt(o, r); if (p === undefined || !(p > 0)) { if (opt.firstDay) fdMiss++; continue; }
        const us = r.x[US] === 1, fee = us ? usFee : C.kr.commission;
        const pKrw = p * (us ? fx(k) : 1);                // 원화 환산 주가
        // 주식 단위 제한(opt.lotSize): 미국은 소수점 허용, 한국은 1주 단위
        let sh, a;
        if (opt.lotSize && (!us || opt.lotAll)) {           // lotAll: 미국도 정수 주만(실제 주문 가능한 수량)
          const lots = Math.floor(Math.min(per, cash) * (1 - fee) / pKrw);  // 살 수 있는 주 수
          if (lots < 1) { if (cur) { cur.skipped.push({ y: r.y, us, px: p, pKrw, per: Math.min(per, cash) }); cur.order.push(r.y); } continue; }   // 1주도 못 사면 건너뜀(fill이면 다음 순위로, 아니면 현금으로 남음)
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
        const bScore = (scored[kA].get(ymOf(sigK)) || []).find(e => e.r.y === r.y)?.s ?? 0;
        holds.push({ px: o, y: r.y, us, etf: r.x[ETF] === 1, last: p, basis: a, sh, sellK: r.exoff === null ? null : mi(r.ym) + r.exoff,
          buyYm: ymOf(k), buyPx: p, buyScore: bScore,
          buyFeats: r.x });
        if (cur) { cur.buys.push({ y: r.y, us, sh, px: p, fx: us ? fx(k) : null, amt: a, gross: a * (1 - fee), fee: a * fee, feeRate: fee, score: bScore }); cur.order.push(r.y); }
        cash -= a; slots--;
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
  };
  let pend = null, fdMiss = 0;
  for (let k = START; k <= END; k++) {
    cur = led ? { k, dep, sells: [], buys: [], skipped: [], order: [], tax: 0 } : null;
    if (opt.firstDay && k > START) doBuys(k - 1, k, (o, r) => fdPx(r.y, k));   // 지난달 신호 → 이번 달 첫날 종가에 체결(입금·세금 처리 뒤 남은 현금)
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
            const ff = opt.graceRate ? ((opt.rateKR && !h.us) ? krChg12(k) : ffChg12(k)) : null;   // rateKR: 한국 종목은 한국 금리로 판단(미국 종목은 미국 금리)
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
    cash += dep; deposits++;                            // 입금을 먼저 받는다: 12월에는 이 돈으로 양도세를 먼저 내고 남은 돈으로 산다
    if ((k - 1) % 12 === 11) {                          // 12월 말: 그해 미국 주식 실현 손익에 양도세(기본공제 후)를 냄
      const Y = yOfK(k), tax = usTax(Y); usGain[Y] = 0;
      if (cur) cur.tax = tax;
      if (tax > 0) {
        if (cash >= tax) cash -= tax;
        else { let hv = 0; for (const h of holds) hv += val(h, k); const f = hv > 0 ? Math.min(1, (tax - cash) / hv) : 0; for (const h of holds) h.sh *= 1 - f; cash = 0; }
      }
    }
    // (입금은 위에서 이미 받음)
    if (!opt.firstDay) doBuys(k, k, (o) => o.m.get(k));
    else pend = k;
    let after = cash; for (const h of holds) after += val(h, k);
    if (prevAfter > 0) rets.push({ k, r: (after - dep) / prevAfter - 1 });
    prevAfter = after;
    if (led) led.set(ymOf(k), Object.assign(cur, { cash, holdVal: after - cash, fx: fx(k) }));
    // 보유 스냅샷 (opt.log)
    if (snapshots) snapshots.set(ymOf(k), holds.map(h => ({ y: h.y, buyYm: h.buyYm, buyPx: h.buyPx, curPx: h.last, basis: h.basis, sh: h.sh, score: h.buyScore, feats: h.buyFeats })));
  }
  if (opt.firstDay && pend !== null) doBuys(pend, mi(CUR), (o, r) => fdPx(r.y, mi(CUR)));   // 마지막 신호의 체결(이번 달 첫날)
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
  return { rets, deposits, depAmt: dep, val: nowV, liq, trades, snapshots, ledger: led, fdMiss };
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
// 실제 주문 가능한 수량(한국·미국 모두 정수 주, 못 산 몫은 현금): 매매일지와 같은 설정, 월 입금액별
for (const dep of LOT_DEPOSITS) {
  const lk = ym => (scored[kA].get(ym) || []).slice(0, 4);
  R.push({ n: `A4 tp2x금리유예2달 정수주문(한·미)${dep / 10000}만`, s: summ(simulate(lk, 4, C1, { tpTrail: 2, grace: 2, graceRate: true, lotSize: true, lotAll: true, fill: true, cand: ym => scored[kA].get(ym) || [] }, dep)) });
}

// ── 점수가 기여했나? 같은 판매 규칙(tp2x 트레일 + 금리 유예 2달)·정수 주문·월 100만원에서 "무엇을 사느냐"만 바꿔 비교
//    점수 상위 4 / 중간 4 / 하위 4 / 무작위 4(여러 번 평균) / 거래대금 큰 4. 상위 4가 하위·무작위보다 확실히 좋아야 점수가 일한 것
const CMP_OPT = { tpTrail: 2, grace: 2, graceRate: true, lotSize: true, lotAll: true, fill: true };
const cmpAll = ym => scored[kA].get(ym) || [];
const cmpTopL = cmpAll;                                                              // 점수 높은 순
const cmpBottomL = ym => [...cmpAll(ym)].reverse();                                  // 점수 낮은 순
const cmpMiddleL = ym => { const a = cmpAll(ym), m = (a.length - 1) / 2; return a.map((x, i) => [x, Math.abs(i - m)]).sort((p, q) => p[1] - q[1]).map(p => p[0]); };   // 가운데부터 바깥으로
const cmpTurnL = ym => [...(byYm.get(ym) || [])].sort((a, b) => b.r.x[TURN] - a.r.x[TURN]);                                                                      // 거래대금 큰 순
const cmpRandL = rnd => ym => { const a = [...(byYm.get(ym) || [])]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };   // 무작위 순서
const CAP_KRW = new Map();                                                           // 종목의 "현재" 시총(원화 환산, 대략): 과거 시점 시총이 없어 현재 값으로 순서만 정함 → 미래 정보가 섞여 유리하게 나올 수 있음
try { JSON.parse(fs.readFileSync(path.join(DATA, 'lists.json'))).forEach(x => CAP_KRW.set(x.y, x.mk === 'US' ? x.cap / 1e5 * 1300 : x.cap)); } catch (e) {}
const cmpCapL = ym => [...(byYm.get(ym) || [])].sort((a, b) => (CAP_KRW.get(b.r.y) || 0) - (CAP_KRW.get(a.r.y) || 0));
const cmpCap = ym => cmpCapL(ym).slice(0, 4);
const cmpTop = ym => cmpTopL(ym).slice(0, 4), cmpBottom = ym => cmpBottomL(ym).slice(0, 4), cmpMiddle = ym => cmpMiddleL(ym).slice(0, 4), cmpTurn = ym => cmpTurnL(ym).slice(0, 4);
const cmpRand = rnd => ym => cmpRandL(rnd)(ym).slice(0, 4);
const CMP_NAMES = [];
const cmpRun = (name, fn) => { progress('점수효과', CMP_NAMES.length / 6); CMP_NAMES.push(name); R.push({ n: name, s: fn() }); };
cmpRun('점수효과 · 점수 상위 4', () => summ(simulate(cmpTop, 4, C1, { ...CMP_OPT, cand: cmpTopL })));
cmpRun('점수효과 · 점수 중간 4', () => summ(simulate(cmpMiddle, 4, C1, { ...CMP_OPT, cand: cmpMiddleL })));
cmpRun('점수효과 · 점수 하위 4', () => summ(simulate(cmpBottom, 4, C1, { ...CMP_OPT, cand: cmpBottomL })));
const CMP_SEEDS = Math.max(SEEDS, +process.env.CMP_SEEDS || 100);                       // 분포를 보려고 무작위는 100번(기본)
let CMP_RAND_CAGR = [];
cmpRun(`점수효과 · 무작위 4 (평균 ${CMP_SEEDS}회)`, () => { const l = []; for (let sd = 1; sd <= CMP_SEEDS; sd++) l.push(summ(simulate(cmpRand(rng(sd)), 4, C1, { ...CMP_OPT, cand: cmpRandL(rng(sd)) }))); CMP_RAND_CAGR = l.map(x => x.cagr); return avgSumm(l); });
cmpRun('점수효과 · 거래대금 큰 4', () => summ(simulate(cmpTurn, 4, C1, { ...CMP_OPT, cand: cmpTurnL })));
cmpRun('점수효과 · 시총 큰 4 (현재 시총 기준)', () => summ(simulate(cmpCap, 4, C1, { ...CMP_OPT, cand: cmpCapL })));
progress('점수효과', 1); process.stdout.write('\n');

// ── 점수 효과 보강 ①: 한국·미국 따로 (각 시장 안에서 점수 상위 4 / 하위 4 / 무작위 4)
const MK_RES = [];
for (const [mkName, us] of [['한국', false], ['미국', true]]) {
  progress('점수효과(시장별)', MK_RES.length / 2);
  const inMk = e => (e.r.x[US] === 1) === us;
  const flt = ym => cmpAll(ym).filter(inMk), fltRev = ym => [...flt(ym)].reverse();
  const fltRand = rnd => ym => { const a = (byYm.get(ym) || []).filter(inMk).slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const top = summ(simulate(ym => flt(ym).slice(0, 4), 4, C1, { ...CMP_OPT, cand: flt }));
  const bot = summ(simulate(ym => fltRev(ym).slice(0, 4), 4, C1, { ...CMP_OPT, cand: fltRev }));
  const capF = ym => cmpCapL(ym).filter(inMk);
  const capR = summ(simulate(ym => capF(ym).slice(0, 4), 4, C1, { ...CMP_OPT, cand: capF }));
  const rr = []; for (let sd = 1; sd <= CMP_SEEDS; sd++) rr.push(summ(simulate(ym => fltRand(rng(sd))(ym).slice(0, 4), 4, C1, { ...CMP_OPT, cand: fltRand(rng(sd)) })).cagr);
  MK_RES.push({ mk: mkName, top, bot, cap: capR, rand: rr.sort((a, b) => a - b) });
}
progress('점수효과(시장별)', 1); process.stdout.write('\n');

// ── 점수 효과 보강 ②: 앞쪽 연도로 설정을 고르고 뒤쪽 연도로 검증
//    설정 = 점수 상위 N(2~10) × 판매 규칙 4가지(28가지). 앞쪽 연도의 연평균이 가장 좋은 설정을 고른 뒤, 뒤쪽 연도에서 같은 설정으로 무작위 N개를 산 경우와 비교
const GRID_N = [2, 3, 4, 5, 6, 8, 10];
const GRID_EXIT = [['이탈 즉시 판매', {}], ['2배 익절 트레일', { tpTrail: 2 }], ['2배 익절+금리유예2달', { tpTrail: 2, grace: 2, graceRate: true }], ['3배 익절+금리유예2달', { tpTrail: 3, grace: 2, graceRate: true }]];
const YEARS_ALL = Object.keys(R[0].s.yearly).map(Number).sort((a, b) => a - b);
const cagrOver = (yearly, years) => Math.pow(years.reduce((p, y) => p * (1 + (yearly[y] ?? 0)), 1), 1 / Math.max(1, years.length)) - 1;
const GRID = [];
GRID_EXIT.forEach(([en, eo]) => GRID_N.forEach(N => {
  progress('앞뒤검증', GRID.length / (GRID_EXIT.length * GRID_N.length));
  const sm = summ(simulate(ym => cmpAll(ym).slice(0, N), N, C1, { ...eo, lotSize: true, lotAll: true, fill: true, cand: cmpAll }));
  GRID.push({ name: `${en} · 상위 ${N}`, N, eo, en, yearly: sm.yearly });
}));
const SPLITS = [2019, 2022].map(lastEarly => {
  const early = YEARS_ALL.filter(y => y <= lastEarly), late = YEARS_ALL.filter(y => y > lastEarly);
  const rows = GRID.map(g => ({ g, e: cagrOver(g.yearly, early), l: cagrOver(g.yearly, late) }));
  const best = rows.reduce((a, b) => (b.e > a.e ? b : a));
  const lateRank = 1 + rows.filter(r => r.l > best.l).length;                       // 뒤쪽 연도에서 28가지 중 몇 등인지
  const rl = []; for (let sd = 1; sd <= 30; sd++) { const sm = summ(simulate(ym => cmpRandL(rng(sd))(ym).slice(0, best.g.N), best.g.N, C1, { ...best.g.eo, lotSize: true, lotAll: true, fill: true, cand: cmpRandL(rng(sd)) })); rl.push(cagrOver(sm.yearly, late)); }
  rl.sort((a, b) => a - b);
  return { lastEarly, early, late, rows, best, lateRank, rl };
});
progress('앞뒤검증', 1); process.stdout.write('\n');

// ── 점수 효과 보강 ③: 시장별로 점수 살리기 — 모델 A/F × (한국·미국 합쳐 학습 / 시장별 따로 학습)
const MK_VAR = [];
for (const [mkName, isUS] of [['한국', false], ['미국', true]]) {
  const inMk = e => (e.r.x[US] === 1) === isUS;
  const variants = [
    ['A 합쳐 학습 (현재)', ym => (scored[KA0].get(ym) || []).filter(inMk)],
    ['F 합쳐 학습 (그달 평균 뺀 수익)', ym => (scored[KF0].get(ym) || []).filter(inMk)],
    [`A ${mkName}만 학습`, ym => scoredMk['A' + mkName].get(ym) || []],
    [`F ${mkName}만 학습 (그달 평균 뺀 수익)`, ym => scoredMk['F' + mkName].get(ym) || []]
  ];
  variants.forEach(([vn, candFn]) => {
    progress('시장별모델', MK_VAR.length / 8);
    MK_VAR.push({ mk: mkName, name: vn, s: summ(simulate(ym => candFn(ym).slice(0, 4), 4, C1, { ...CMP_OPT, cand: candFn })) });
  });
}
progress('시장별모델', 1); process.stdout.write('\n');

// ── 점수 효과 보강 ④: 금리 판단 변형 — 한국 종목에 한국 금리를 쓰면?
//    (현재) 모든 종목에 미국 금리 / (변형) 한국 종목은 한국 금리, 미국 종목은 미국 금리 / (참고) 금리 판단 없이 유예 2달만
const RATE_VAR = [];
{
  const inKR = e => e.r.x[US] !== 1, krTopL = ym => cmpAll(ym).filter(inKR);
  const runs = [
    ['전체 · 현재 (모두 미국 금리)', cmpTop, cmpAll, { ...CMP_OPT }],
    ['전체 · 한국 종목은 한국 금리', cmpTop, cmpAll, { ...CMP_OPT, rateKR: true }],
    ['전체 · 금리 판단 없음 (유예 2달만)', cmpTop, cmpAll, { ...CMP_OPT, graceRate: false }],
    ['한국만 · 현재 (미국 금리)', ym => krTopL(ym).slice(0, 4), krTopL, { ...CMP_OPT }],
    ['한국만 · 한국 금리', ym => krTopL(ym).slice(0, 4), krTopL, { ...CMP_OPT, rateKR: true }],
    ['한국만 · 금리 판단 없음 (유예 2달만)', ym => krTopL(ym).slice(0, 4), krTopL, { ...CMP_OPT, graceRate: false }]
  ];
  runs.forEach(([name, pick, cand, opt], i) => { progress('금리변형', i / runs.length); RATE_VAR.push({ name, s: summ(simulate(pick, 4, C1, { ...opt, cand })) }); });
}
// 금리가 "오르는 중"으로 판단된 달 비율(시뮬레이션 기간)
const rateShare = (fn) => { let n = 0, up = 0; for (let k = START; k <= END; k++) { const v = fn(k); if (v != null) { n++; if (v > 0) up++; } } return n ? up / n : NaN; };
const RATE_SHARE = { us: rateShare(ffChg12), kr: rateShare(krChg12) };
progress('금리변형', 1); process.stdout.write('\n');

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
    cash += DEP; deposits++;   // 입금을 먼저 받는다(12월 세금을 이 돈으로 먼저 냄)
    if ((k-1)%12===11){const Y=yOfK(k),tax=usTax(Y);usGain[Y]=0;if(tax>0){if(cash>=tax)cash-=tax;else{let hv=0;for(const h of holds)hv+=val(h,k);const f=hv>0?Math.min(1,(tax-cash)/hv):0;for(const h of holds)h.sh*=1-f;cash=0;}}}
    // (입금은 위에서 이미 받음)
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
// ── 점수가 기여했나? 비교 표 (같은 판매 규칙·정수 주문·월 100만원)
{
  log(''); log('## 점수가 기여했나? 사는 종목만 바꿔 비교 (같은 판매 규칙 tp2x트레일+금리유예2달, 정수 주문, 월 100만원, 비용·세금 반영)');
  log('전략                              연평균   누적        최대낙폭   청산시 세후   IRR    이긴 해(코스피보다)');
  const cmpRows = CMP_NAMES.map(n => R.find(r => r.n === n)).filter(Boolean);
  cmpRows.forEach(r => log(`${r.n.padEnd(34)} ${pc(r.s.cagr).padStart(7)} ${pc(r.s.cum).padStart(10)} ${pc(r.s.mdd).padStart(9)} ${won(r.s.liq).padStart(12)} ${pc(r.s.irr).padStart(7)}   ${ksY ? Ys.filter(Y => r.s.yearly[Y] > (ksY[Y] ?? 0)).length + '/' + Ys.length : ''}`));
  const g = n => (cmpRows.find(r => r.n.includes(n)) || { s: { cagr: NaN } }).s.cagr;
  log(`→ 점수 상위 4 − 무작위 4 = ${((g('상위') - g('무작위')) * 100).toFixed(1)}%p/년,  상위 4 − 하위 4 = ${((g('상위') - g('하위')) * 100).toFixed(1)}%p/년  (0 근처이거나 음수면 점수가 수익에 기여하지 못한 것)`);
  log('   ※ 시총 큰 4는 "현재" 시총 순서입니다(과거 시점 시총 데이터가 없음). 지금은 커졌지만 당시엔 작았던 종목이 앞순위에 들어가 미래 정보가 섞이므로 실제보다 유리하게 나올 수 있습니다.');
  if (CMP_RAND_CAGR.length) {                                                        // 무작위 4 분포: 상위 4가 운이 아닌지
    const a = [...CMP_RAND_CAGR].sort((x, y) => x - y), q = p => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))];
    const top = g('상위'), beat = a.filter(x => x >= top).length;
    log(`무작위 4를 ${a.length}번 돌린 연평균 분포: 최소 ${pc(a[0])} · 하위 10% ${pc(q(0.1))} · 중앙값 ${pc(q(0.5))} · 상위 10% ${pc(q(0.9))} · 최대 ${pc(a[a.length - 1])}`);
    log(`→ 점수 상위 4(${pc(top)})보다 높았던 무작위는 ${beat}/${a.length}번. 무작위 중 이 정도가 나올 확률 ≈ ${((beat + 1) / (a.length + 1) * 100).toFixed(1)}% (작을수록 운일 가능성이 낮음)`);
    log('   ※ 점수 상위 4는 설정(N·판매 규칙)을 같은 데이터로 골랐기 때문에, 이 확률은 실제보다 유리하게 나올 수 있음');
  }
}
// ── 체결 가정 비교: 월말 종가에 사기(지금) vs 다음 달 첫 거래일 종가에 사기 (판매는 둘 다 월말 종가). 첫날 가격이 없는 종목은 못 산 것으로 처리
const FD = { rows: [], miss: 0, paired: [] };
{
  const FD_SEEDS = +process.env.FD_SEEDS || 50;
  const cfg = [['전체', cmpAll], ['한국', ym => cmpAll(ym).filter(e => e.r.x[US] === 0)], ['미국', ym => cmpAll(ym).filter(e => e.r.x[US] === 1)]];
  cfg.forEach(([nm, cand], i) => {
    progress('체결가정', i / 4);
    const a = summ(simulate(ym => cand(ym).slice(0, 4), 4, C1, { ...CMP_OPT, cand }));
    const sf = simulate(ym => cand(ym).slice(0, 4), 4, C1, { ...CMP_OPT, cand, firstDay: true }); FD.miss += sf.fdMiss;
    FD.rows.push({ nm: nm + ' 점수 상위 4', a, b: summ(sf) });
  });
  progress('체결가정', 3 / 4);
  const dl = [], me = [], fdl = [];
  for (let sd = 1; sd <= FD_SEEDS; sd++) {
    const fl = ym => { const a = [...(byYm.get(ym) || [])], r = rng(sd * 7 + (ym % 997)); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    const m1 = summ(simulate(ym => fl(ym).slice(0, 4), 4, C1, { ...CMP_OPT, cand: fl }));
    const m2 = summ(simulate(ym => fl(ym).slice(0, 4), 4, C1, { ...CMP_OPT, cand: fl, firstDay: true }));
    me.push(m1.cagr); fdl.push(m2.cagr); dl.push(m2.cagr - m1.cagr);
  }
  FD.paired = { me: me.sort((x, y) => x - y), fd: fdl.sort((x, y) => x - y), d: dl.sort((x, y) => x - y) };
  progress('체결가정', 1); process.stdout.write('\n');
}
// ── 3단계: 정답을 실제 판매 규칙으로 바꿔 점수 모델을 다시 학습하는 실험 (STAGE3=0이면 건너뜀)
//   모든 변형은 같은 방식으로 검증: 시험 연도 Y의 점수는 Y-1년 말까지 "알 수 있던" 정답으로만 학습(data.js trainSetL), 같은 종목 범위·같은 판매 규칙·같은 정수 주문으로 점수 상위 4를 월 100만원씩 산다.
//   비교 기준 = 'orig'(지금 사이트 모델: 정답 = 처음 10이평 이탈까지의 수익). 변형 하나씩만 바꿔서 어느 변경이 효과인지 보이게 함.
const S3 = { rows: [], ref: null, check: null };
if (process.env.STAGE3 !== '0') {
  const SL = require('./strat'), DEFS = modelDefs(F), PRICE = DEFS.PRICE, MACc = DEFS.MAC, MKTc = DEFS.MKT, STOCKc = DEFS.STOCK;
  const ffc = fi('m_ff_chg12');
  const LAB = {                                                     // 정답 만드는 방식(진입 · 판매 규칙)
    me:        { entry: 'me', tp: 2, grace: 2, rate: true },        // 월말 종가 진입 + 지금 판매 규칙
    fd:        { entry: 'fd', tp: 2, grace: 2, rate: true },        // 다음 달 첫날 종가 진입 + 지금 판매 규칙
    fd_norate: { entry: 'fd', tp: 2, grace: 2, rate: false },       // 금리 판단 없이
    fd_notp:   { entry: 'fd', tp: 0, grace: 2, rate: true },        // 익절 트레일 없이
    fd_g1:     { entry: 'fd', tp: 2, grace: 0, rate: false },       // 유예 없이(처음 이탈 즉시)
    fd_g3:     { entry: 'fd', tp: 2, grace: 3, rate: true }         // 유예 3달
  };
  const ORIG = ALL.map(r => ({ t: r.t, exoff: r.exoff, mk: r.mk, p0: null }));
  const labCache = new Map(); labCache.set('orig', ORIG);
  const labsOf = n => { if (!labCache.has(n)) labCache.set(n, ALL.map(r => SL.label(r.y, r.ym, LAB[n], END))); return labCache.get(n); };
  const quant = (a, p) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(p * (b.length - 1)))] : 0; };
  const monthGroups = tr => { const g = new Map(); tr.forEach(r => { const a = g.get(r.ym) || []; a.push(r); g.set(r.ym, a); }); return g; };
  const TF = {                                                      // 정답 변환
    raw: tr => tr.map(r => ({ x: r.x, t: clipT(r.t) })),
    tight: tr => tr.map(r => ({ x: r.x, t: Math.max(-1, Math.min(1.5, r.t)) })),
    demean: tr => { const g = monthGroups(tr), o = []; g.forEach(a => { if (a.length < 5) return; const m = a.reduce((s, r) => s + clipT(r.t), 0) / a.length; a.forEach(r => o.push({ x: r.x, t: clipT(r.t) - m })); }); return o; },
    rank: tr => { const g = monthGroups(tr), o = []; g.forEach(a => { if (a.length < 5) return; const b = [...a].sort((p, q) => p.t - q.t); b.forEach((r, i) => o.push({ x: r.x, t: 2 * ((i + 0.5) / b.length - 0.5) })); }); return o; },
    bin2: tr => tr.map(r => ({ x: r.x, t: r.t >= Math.log(2) ? 1 : 0 })),       // 2배 이상 났나(큰 이익 확률)
    binpos: tr => tr.map(r => ({ x: r.x, t: r.t > 0 ? 1 : 0 }))                 // 이익이 났나
  };
  const inMkF = (isUS, r) => (r.x[US] === 1) === isUS;
  function walk(spec) {                                             // 시험 연도별 학습 → Map(ym → [{r, s}] 점수 높은 순)
    const labs = labsOf(spec.lab), out = new Map(), M = spec.mk === undefined ? null : spec.mk === 'US';
    years.forEach(Y => {
      let tr0 = trainSetL(ALL, labs, Y, spec.minAge || 12);
      if (M !== null) tr0 = tr0.filter(r => inMkF(M, r));
      const te = ALL.filter(r => Math.floor(r.ym / 100) === Y && (M === null || inMkF(M, r)));
      if (tr0.length < (M === null ? 500 : 300) || !te.length) return;
      const tr = TF[spec.tf || 'raw'](tr0); if (tr.length < 200) return;
      const P = prep(tr, spec.cols), w = fitRidge(tr.map(r => z(r, P)), tr.map(r => r.t), spec.lam || 1000);
      te.forEach(r => { const a = out.get(r.ym) || []; a.push({ r, s: score(w, z(r, P)) }); out.set(r.ym, a); });
    });
    out.forEach(a => a.sort((x, y) => y.s - x.s)); return out;
  }
  // 경사 부스팅 트리(gbm.js, 순수 JS). 지표 = 가격 지표에서 지수 3개(idx_*)를 뺀 것(사이트에서 0으로 두는 항목이라 모델이 쓰면 안 됨)
  const NOIDX = PRICE.filter(j => !F[j].startsWith('idx_'));
  function walkG(spec) {
    const labs = labsOf(spec.lab), out = new Map();
    years.forEach(Y => {
      const tr0 = trainSetL(ALL, labs, Y, spec.minAge || 12), te = ALL.filter(r => Math.floor(r.ym / 100) === Y);
      if (tr0.length < 500 || !te.length) return;
      const tr = TF[spec.tf || 'raw'](tr0); if (tr.length < 200) return;
      const ms = []; for (let sd = 1; sd <= (spec.seeds || 1); sd++) ms.push(GBM.fit(tr.map(r => r.x), tr.map(r => r.t), spec.cols || NOIDX, { ...(spec.opt || {}), seed: sd }));
      te.forEach(r => { let v = 0; ms.forEach(m => { v += GBM.predict(m, r.x); }); const a = out.get(r.ym) || []; a.push({ r, s: v / ms.length }); out.set(r.ym, a); });
    });
    out.forEach(a => a.sort((x, y) => y.s - x.s)); return out;
  }
  const pctRank = (a) => { const n = a.length, o = new Map(); a.forEach((e, i) => o.set(e.r, (n - i - 0.5) / n)); return o; };   // 점수 높은 순 배열 → 순위 백분위(높을수록 좋음)
  function mergeByRank(maps, weights) {                              // 여러 점수를 월별 순위 백분위로 합침(시장별 모델·모델 섞기)
    const out = new Map(), yms = new Set(); maps.forEach(m => m.forEach((_, ym) => yms.add(ym)));
    yms.forEach(ym => { const acc = new Map(); maps.forEach((m, mi_) => { const a = m.get(ym) || [], pr = pctRank(a); a.forEach(e => acc.set(e.r, (acc.get(e.r) || 0) + (weights ? weights[mi_] : 1) * pr.get(e.r))); }); out.set(ym, [...acc].map(([r, s]) => ({ r, s })).sort((x, y) => y.s - x.s)); });
    return out;
  }
  function splitMarkets(spec) {                                      // 한국·미국을 따로 학습한 점수를 월·시장 안 순위 백분위로 합침
    const kr = walk({ ...spec, mk: 'KR' }), us = walk({ ...spec, mk: 'US' }), out = new Map();
    const yms = new Set([...kr.keys(), ...us.keys()]);
    yms.forEach(ym => { const a = [...(kr.get(ym) ? pctOf(kr.get(ym)) : []), ...(us.get(ym) ? pctOf(us.get(ym)) : [])]; out.set(ym, a.sort((x, y) => y.s - x.s)); });
    return out;
    function pctOf(a) { const pr = pctRank(a); return a.map(e => ({ r: e.r, s: pr.get(e.r) })); }
  }
  function timingSkip(labName, q) {                                  // 시장 상황 모델: 달 평균 수익이 낮게 예측되는 달(훈련 달 예측의 하위 q)에는 사지 않음
    const labs = labsOf(labName), cols = MKTc.concat(MACc), skip = new Set();
    years.forEach(Y => {
      const tr0 = trainSetL(ALL, labs, Y), te = ALL.filter(r => Math.floor(r.ym / 100) === Y);
      if (tr0.length < 500 || !te.length) return;
      const tr = TF.raw(tr0), P = prep(tr, cols), w = fitRidge(tr.map(r => z(r, P)), tr.map(r => r.t), 3000);
      const mp = rs => { const g = new Map(); rs.forEach(r => { const a = g.get(r.ym) || []; a.push(score(w, z(r, P))); g.set(r.ym, a); }); const o = new Map(); g.forEach((a, ym) => o.set(ym, a.reduce((s, v) => s + v, 0) / a.length)); return o; };
      const trm = mp(tr0.map(r => ({ ym: r.ym, x: r.x }))), thr = quant([...trm.values()], q);
      mp(te).forEach((v, ym) => { if (v < thr) skip.add(ym); });
    });
    return skip;
  }
  // 평가: 점수 상위 4 (전체·한국만·미국만) + 월별 순위상관(IC) — 모든 변형을 같은 잣대(첫날 진입 + 지금 규칙의 실제 결과)로 잼
  const TGT = labsOf('fd'), idxOf = new Map(ALL.map((r, i) => [r, i]));
  const tgtOf = r => { const l = TGT[idxOf.get(r)]; if (!l) return null; if (l.exoff !== null) return l.t; return l.mk[3]; };   // 판 수익, 아니면 12개월 시점 수익
  const rk = a => { const o = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]), r = new Array(a.length); for (let i = 0; i < o.length;) { let e = i; while (e + 1 < o.length && o[e + 1][0] === o[i][0]) e++; for (let k = i; k <= e; k++) r[o[k][1]] = (i + e) / 2; i = e + 1; } return r; };
  const corr = (a, b) => { const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n; let c = 0, va = 0, vb = 0; for (let i = 0; i < n; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; } return va && vb ? c / Math.sqrt(va * vb) : null; };
  function icOf(map) {                                               // 월별 (점수, 실제 결과) 순위상관의 평균 — 앞쪽(~2019)·뒤쪽(2020~)
    const e = [], l = [], ex = { e: [], l: [] };
    map.forEach((a, ym) => {
      const rows = a.map(x => [x.s, tgtOf(x.r)]).filter(p => p[1] !== null && p[1] !== undefined); if (rows.length < 8) return;
      const c = corr(rk(rows.map(p => p[0])), rk(rows.map(p => p[1]))); if (c === null) return;
      const top = rows.slice(0, 4).reduce((s, p) => s + p[1], 0) / Math.min(4, rows.length), m = rows.reduce((s, p) => s + p[1], 0) / rows.length;
      (ym < 202001 ? e : l).push(c); (ym < 202001 ? ex.e : ex.l).push(top - m);
    });
    const mean = v => v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
    return { e: mean(e), l: mean(l), xe: mean(ex.e), xl: mean(ex.l), ne: e.length, nl: l.length };
  }
  const early = YEARS_ALL.filter(y => y <= 2019), late = YEARS_ALL.filter(y => y > 2019);
  function evalMap(map, skip) {
    const get = ym => (skip && skip.has(ym)) ? [] : (map.get(ym) || []);
    const run = (cand, entry) => summ(simulate(ym => cand(ym).slice(0, 4), 4, C1, { ...CMP_OPT, cand, firstDay: entry === 'fd' }));
    const kr = ym => get(ym).filter(e => e.r.x[US] === 0), us = ym => get(ym).filter(e => e.r.x[US] === 1);
    const a = run(get, 'fd');
    return { fd: a, me: run(get, 'me'), kr: run(kr, 'fd'), us: run(us, 'fd'), ic: icOf(map), early: cagrOver(a.yearly, early), late: cagrOver(a.yearly, late) };
  }
  const A = { n: 'A', cols: PRICE }, base = (extra) => ({ cols: PRICE, lam: 1000, tf: 'raw', ...extra });
  const SPECS = [   // [그룹, 이름, 점수 만드는 방법]
    ['0 기준', 'orig · 지금 사이트 모델 (정답 = 첫 10이평 이탈까지)', () => walk(base({ lab: 'orig' }))],
    ['1 정답을 실제 규칙 수익으로', 'me · 월말 진입 + 지금 판매 규칙', () => walk(base({ lab: 'me' }))],
    ['1 정답을 실제 규칙 수익으로', 'fd · 첫날 진입 + 지금 판매 규칙', () => walk(base({ lab: 'fd' }))],
    ['1 정답을 실제 규칙 수익으로', 'fd_norate · 금리 판단 없이', () => walk(base({ lab: 'fd_norate' }))],
    ['1 정답을 실제 규칙 수익으로', 'fd_notp · 익절 트레일 없이', () => walk(base({ lab: 'fd_notp' }))],
    ['1 정답을 실제 규칙 수익으로', 'fd_g1 · 유예 없이', () => walk(base({ lab: 'fd_g1' }))],
    ['1 정답을 실제 규칙 수익으로', 'fd_g3 · 유예 3달', () => walk(base({ lab: 'fd_g3' }))],
    ['2 정답 변환 (fd)', 'fd + 그달 평균 빼기', () => walk(base({ lab: 'fd', tf: 'demean' }))],
    ['2 정답 변환 (fd)', 'fd + 그달 순위(백분위)', () => walk(base({ lab: 'fd', tf: 'rank' }))],
    ['2 정답 변환 (fd)', 'fd + 2배 이상 났나(0/1)', () => walk(base({ lab: 'fd', tf: 'bin2' }))],
    ['2 정답 변환 (fd)', 'fd + 이익 났나(0/1)', () => walk(base({ lab: 'fd', tf: 'binpos' }))],
    ['2 정답 변환 (fd)', 'fd + 극값 자르기(-1~1.5)', () => walk(base({ lab: 'fd', tf: 'tight' }))],
    ['2 정답 변환 (기존 정답)', 'orig + 그달 순위(백분위)', () => walk(base({ lab: 'orig', tf: 'rank' }))],
    ['3 지표 구성 (fd)', 'fd + 기준금리 변화', () => walk(base({ lab: 'fd', cols: PRICE.concat([ffc]) }))],
    ['3 지표 구성 (fd)', 'fd + 거시 전부', () => walk(base({ lab: 'fd', cols: PRICE.concat(MACc) }))],
    ['3 지표 구성 (fd)', 'fd + 종목 지표만(그달 평균 뺀 정답)', () => walk(base({ lab: 'fd', cols: STOCKc, tf: 'demean' }))],
    ['4 규제 세기 λ (fd)', 'fd λ=100', () => walk(base({ lab: 'fd', lam: 100 }))],
    ['4 규제 세기 λ (fd)', 'fd λ=300', () => walk(base({ lab: 'fd', lam: 300 }))],
    ['4 규제 세기 λ (fd)', 'fd λ=3000', () => walk(base({ lab: 'fd', lam: 3000 }))],
    ['4 규제 세기 λ (fd)', 'fd λ=10000', () => walk(base({ lab: 'fd', lam: 10000 }))],
    ['5 못 판 신호 쓰는 기준', 'fd · 6개월 지난 보유분도 학습', () => walk(base({ lab: 'fd', minAge: 6 }))],
    ['5 못 판 신호 쓰는 기준', 'fd · 24개월 지난 보유분만 학습', () => walk(base({ lab: 'fd', minAge: 24 }))],
    ['6 시장별로 따로 학습', 'fd 한국·미국 따로 (월·시장 안 순위로 합침)', () => splitMarkets(base({ lab: 'fd' }))],
    ['6 시장별로 따로 학습', 'fd + 그달 평균 빼기, 한국·미국 따로', () => splitMarkets(base({ lab: 'fd', tf: 'demean' }))],
    ['7 모델 섞기', 'orig + fd 순위 평균', () => mergeByRank([walk(base({ lab: 'orig' })), walk(base({ lab: 'fd' }))])],
    ['7 모델 섞기', 'fd raw + demean + rank 순위 평균', () => mergeByRank([walk(base({ lab: 'fd' })), walk(base({ lab: 'fd', tf: 'demean' })), walk(base({ lab: 'fd', tf: 'rank' }))])],
    ['A 트리 모델 (gbm.js, 지수 지표 뺌)', 'gbm · fd 정답 (깊이3·300그루)', () => walkG({ lab: 'fd' })],
    ['A 트리 모델 (gbm.js, 지수 지표 뺌)', 'gbm · fd 정답, 씨앗 3개 평균', () => walkG({ lab: 'fd', seeds: 3 })],
    ['A 트리 모델 (gbm.js, 지수 지표 뺌)', 'gbm · 기존 정답(첫 10이평 이탈까지)', () => walkG({ lab: 'orig' })],
    ['A 트리 모델 (gbm.js, 지수 지표 뺌)', 'gbm · fd 정답 + 그달 평균 빼기', () => walkG({ lab: 'fd', tf: 'demean' })],
    ['A 트리 모델 (gbm.js, 지수 지표 뺌)', 'gbm · fd 정답, 깊이4·600그루', () => walkG({ lab: 'fd', opt: { depth: 4, rounds: 600 } })],
    ['A 트리 모델 (gbm.js, 지수 지표 뺌)', 'gbm · fd 정답, 깊이2·400그루', () => walkG({ lab: 'fd', opt: { depth: 2, rounds: 400 } })],
    ['A 트리 모델 (gbm.js, 지수 지표 뺌)', 'gbm · 월말 진입 정답(me)', () => walkG({ lab: 'me' })],
    ['8 시장 상황으로 쉬기 (fd)', 'fd · 시장상황 모델 하위 20% 달은 쉼', () => ({ map: walk(base({ lab: 'fd' })), skip: timingSkip('fd', 0.2) })],
    ['8 시장 상황으로 쉬기 (fd)', 'fd · 시장상황 모델 하위 35% 달은 쉼', () => ({ map: walk(base({ lab: 'fd' })), skip: timingSkip('fd', 0.35) })]
  ];
  // 외부 모델 점수(파이썬 LightGBM 등이 만든 data/ext_scores.csv: events.csv와 같은 순서, 열 p_* = 해마다 그 전까지 알던 것으로 학습한 점수). 같은 시뮬레이션·같은 평가로 비교
  const extFile = process.env.EXT_SCORES || path.join(DATA, 'ext_scores.csv');
  if (fs.existsSync(extFile)) {
    const lines = fs.readFileSync(extFile, 'utf8').trim().split('\n'), head = lines[0].split(','), rowsE = lines.slice(1).map(l => l.split(','));
    const iym = head.indexOf('ym');
    if (rowsE.length === ALL.length && rowsE.every((p, i) => +p[iym] === ALL[i].ym)) {
      head.forEach((h, c) => {
        if (!h.startsWith('p_')) return;
        const m = new Map();
        rowsE.forEach((p, i) => { const v = p[c]; if (v === '' || v === undefined) return; const a = m.get(ALL[i].ym) || []; a.push({ r: ALL[i], s: +v }); m.set(ALL[i].ym, a); });
        m.forEach(a => a.sort((x, y) => y.s - x.s));
        SPECS.push(['9 외부 모델 (파이썬 LightGBM)', h.slice(2), () => m]);
      });
    } else console.log('\next_scores.csv가 events.csv와 안 맞아 건너뜀');
  }
  SPECS.forEach(([g, name, mk], i) => {
    progress('3단계 실험', i / SPECS.length);
    const res = mk(), map = res instanceof Map ? res : res.map, skip = res instanceof Map ? null : res.skip;
    S3.rows.push({ g, name, ...evalMap(map, skip) });
    if (i === 0) {                                                  // 검산: 기준 변형이 기존 A 점수(scored[kA])와 같아야 함(같은 정답·같은 학습 → 모순 확인)
      let mx = 0, n = 0, miss = 0; scored[kA].forEach((a, ym) => { const b = map.get(ym) || []; const m2 = new Map(b.map(e => [e.r, e.s])); a.forEach(e => { const v = m2.get(e.r); if (v === undefined) miss++; else if (!(Number.isNaN(v) && Number.isNaN(e.s))) mx = Math.max(mx, Math.abs(v - e.s)); n++; }); });
      S3.check = { max: mx, n, miss };
    }
  });
  progress('3단계 실험', 1); process.stdout.write('\n');
  const rr = FD.paired.fd; S3.ref = { med: quant(rr, 0.5), p90: quant(rr, 0.9) };
}
// ── 점수 효과 보강 보고
// ── 3단계 보고
if (S3.rows.length) {
  const o0 = S3.rows[0], pc1 = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%', f2 = x => Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(3) : '   -  ';
  log(''); log('## 3단계: 정답·학습 방식을 바꾼 점수 모델 비교 (점수 상위 4, 첫날 체결, 판매 규칙 tp2x트레일+금리유예2달, 정수 주문, 월 100만원, 비용·세금 반영)');
  log(`검산: 기준 변형(orig)이 기존 A 모델 점수와 최대 ${S3.check ? S3.check.max.toExponential(1) : '?'} 차이 (${S3.check ? S3.check.n : 0}건 중 빠진 것 ${S3.check ? S3.check.miss : '?'}건) — 둘 다 0이어야 같은 학습·같은 정답`);
  log(`참고: 무작위 4 (첫날 체결, 50번) 중앙값 ${pc1(S3.ref.med)} · 상위 10% ${pc1(S3.ref.p90)}`);
  log('IC = 월별로 (점수, 실제 결과) 순위상관의 평균, 초과 = 점수 상위 4의 실제 결과 − 그달 평균(log 수익, 건당). 실제 결과 = 첫날 진입 + 지금 판매 규칙으로 판 수익(못 팔았으면 12개월 시점).');
  log('변형                                                 전체     앞쪽    뒤쪽    한국    미국   월말체결  IC앞    IC뒤    초과앞  초과뒤   채택후보');
  let g0 = '';
  S3.rows.forEach(r => {
    if (r.g !== g0) { log(`[${r.g}]`); g0 = r.g; }
    const cand = r !== o0 && r.early >= o0.early && r.late >= o0.late && r.late > S3.ref.med && r.ic.e > 0 && r.ic.l > 0 && r.kr.cagr > 0 && r.us.cagr > 0;
    log(`  ${r.name.padEnd(48)} ${pc1(r.fd.cagr).padStart(7)} ${pc1(r.early).padStart(7)} ${pc1(r.late).padStart(7)} ${pc1(r.kr.cagr).padStart(7)} ${pc1(r.us.cagr).padStart(7)} ${pc1(r.me.cagr).padStart(7)}  ${f2(r.ic.e)} ${f2(r.ic.l)}  ${f2(r.ic.xe)} ${f2(r.ic.xl)}   ${cand ? '★' : ''}`);
  });
  log('★ = 기준(orig)보다 앞쪽·뒤쪽 모두 낫고, 뒤쪽이 무작위 중앙값을 넘고, IC가 앞·뒤 모두 양수이며, 한국·미국 모두 플러스인 변형.');
  log('※ 이 표의 변형은 같은 데이터에서 30가지 가까이 비교한 것이라 최고값은 과장됨. ★ 중에서도 (1) 앞쪽·뒤쪽에서 같이 좋고 (2) IC·초과가 같은 방향이며 (3) 한 변경이 이유로 설명되는 것만 채택할 것.');
  log('※ 채택하면 4_train.js(사이트 weights.json)도 같은 정답·변환으로 바꿔야 점수 칩·나무가 일치함. 지금 사이트 점수는 기준(orig) 그대로.');
}
// ── 체결 가정 비교 보고
{
  log(''); log('## 체결 가정 비교: 월말 종가에 사기(현재) vs 다음 달 첫 거래일 종가에 사기 (판매는 모두 월말 종가, 같은 규칙·정수 주문·월 100만원)');
  log('구분                       월말 체결     첫날 체결     차이(%p/년)   첫날 체결 최대낙폭');
  FD.rows.forEach(r => log(`${r.nm.padEnd(22)} ${pc(r.a.cagr).padStart(9)}   ${pc(r.b.cagr).padStart(9)}   ${((r.b.cagr - r.a.cagr) * 100).toFixed(1).padStart(8)}      ${pc(r.b.mdd).padStart(9)}`));
  const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))], P = FD.paired;
  log(`무작위 4 (${P.d.length}번): 월말 체결 중앙값 ${pc(q(P.me, 0.5))} → 첫날 체결 중앙값 ${pc(q(P.fd, 0.5))}, 같은 종목 짝의 차이 중앙값 ${(q(P.d, 0.5) * 100).toFixed(1)}%p (하위10% ${(q(P.d, 0.1) * 100).toFixed(1)} ~ 상위10% ${(q(P.d, 0.9) * 100).toFixed(1)})`);
  log(`첫날 가격이 없어 못 산 건수 ${FD.miss}회`);
  const up = FD.rows[0], top0 = up.b.cagr, beat = P.fd.filter(x => x >= top0).length;
  log(`→ 첫날 체결에서 점수 상위 4(${top0 >= 0 ? '+' : ''}${(top0 * 100).toFixed(1)}%)보다 높았던 무작위는 ${beat}/${P.fd.length}번.`);
}
{
  log(''); log('## 점수 효과 보강 ① 한국·미국 따로 (각 시장 안에서만 고름, 같은 판매 규칙·정수 주문·월 100만원)');
  log('시장   점수 상위 4    점수 하위 4    시총 큰 4(현재 시총)   무작위 4(중앙값 · 하위10% ~ 상위10%)           상위 4보다 높은 무작위');
  MK_RES.forEach(r => {
    const a = r.rand, q = p => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))], beat = a.filter(x => x >= r.top.cagr).length;
    log(`${r.mk.padEnd(4)}  ${pc(r.top.cagr).padStart(9)}    ${pc(r.bot.cagr).padStart(9)}    ${pc(r.cap.cagr).padStart(12)}      ${pc(q(0.5)).padStart(8)} · ${pc(q(0.1))} ~ ${pc(q(0.9))}   ${beat}/${a.length}번 (${((beat + 1) / (a.length + 1) * 100).toFixed(1)}%)`);
  });
  log('→ 한쪽 시장에서만 점수가 일하고 다른 쪽은 무작위와 비슷하면, 전체 결과는 한 시장 덕일 수 있음');

  log(''); log('## 점수 효과 보강 ② 앞쪽 연도로 설정을 고르고 뒤쪽 연도로 검증 (설정 28가지 = 점수 상위 N 2~10 × 판매 규칙 4가지)');
  SPLITS.forEach(sp => {
    const a = sp.rl, q = p => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))], beat = a.filter(x => x >= sp.best.l).length;
    log(`- 앞쪽 ${sp.early[0]}~${sp.early[sp.early.length - 1]} / 뒤쪽 ${sp.late[0]}~${sp.late[sp.late.length - 1]}`);
    log(`  앞쪽 연평균 최고 설정: ${sp.best.g.name}  (앞쪽 ${pc(sp.best.e)} → 뒤쪽 ${pc(sp.best.l)})`);
    log(`  이 설정을 뒤쪽에서 28가지 중 ${sp.lateRank}등. 같은 설정으로 무작위 ${sp.best.g.N}개를 산 경우(30번): 중앙값 ${pc(q(0.5))} · 하위10% ${pc(q(0.1))} ~ 상위10% ${pc(q(0.9))}, 그보다 높은 무작위 ${beat}/${a.length}번`);
    log(`  → 뒤쪽 연도에서 점수로 고른 설정이 무작위보다 ${sp.best.l - q(0.5) >= 0 ? '+' : ''}${((sp.best.l - q(0.5)) * 100).toFixed(1)}%p/년 ${sp.best.l > q(0.9) ? '(무작위 상위 10%보다도 좋음: 앞쪽에서 고른 설정이 뒤쪽에서도 통함)' : sp.best.l > q(0.5) ? '(무작위보다 낫지만 크게는 아님)' : '(무작위와 비슷하거나 나쁨: 설정을 같은 데이터로 골라 생긴 과장일 수 있음)'}`);
  });
  const sp0 = SPLITS[0];
  log(''); log(`설정 28가지의 앞쪽(${sp0.early[0]}~${sp0.early[sp0.early.length - 1]}) 대 뒤쪽(${sp0.late[0]}~${sp0.late[sp0.late.length - 1]}) 연평균 (뒤쪽 높은 순)`);
  [...sp0.rows].sort((x, y) => y.l - x.l).forEach(r => log(`  ${r.g.name.padEnd(34)} 앞쪽 ${pc(r.e).padStart(8)}   뒤쪽 ${pc(r.l).padStart(8)}`));
}
// ── 점수 효과 보강 ③ 보고
{
  const early = YEARS_ALL.filter(y => y <= 2019), late = YEARS_ALL.filter(y => y > 2019);
  log(''); log('## 점수 효과 보강 ③ 시장별로 점수 살리기 (각 시장 안에서 점수 상위 4, 같은 판매 규칙·정수 주문·월 100만원)');
  log('모델 변형                               전체     앞쪽(2012~2019)  뒤쪽(2020~)   이긴 해(코스피보다)');
  ['한국', '미국'].forEach(mk => {
    const rd = (MK_RES.find(r => r.mk === mk) || { rand: [0] }).rand, q = p => rd[Math.min(rd.length - 1, Math.floor(p * (rd.length - 1)))];
    log(`[${mk}]  (참고: 무작위 4 중앙값 ${pc(q(0.5))}, 상위 10% ${pc(q(0.9))})`);
    MK_VAR.filter(v => v.mk === mk).forEach(v => log(`  ${v.name.padEnd(36)} ${pc(v.s.cagr).padStart(8)}   ${pc(cagrOver(v.s.yearly, early)).padStart(10)}      ${pc(cagrOver(v.s.yearly, late)).padStart(9)}      ${ksY ? YEARS_ALL.filter(Y => v.s.yearly[Y] > (ksY[Y] ?? 0)).length + '/' + YEARS_ALL.length : ''}`));
  });
  log('→ 미국에서 현재(A 합쳐 학습)보다 무작위 상위 10%를 확실히 넘는 변형이 있으면 그 모델로 미국 점수를 바꾸는 것을 검토. 앞쪽·뒤쪽 모두에서 좋아야 믿을 만함');
}
// ── 점수 효과 보강 ④ 보고
{
  const early = YEARS_ALL.filter(y => y <= 2019), late = YEARS_ALL.filter(y => y > 2019);
  log(''); log('## 점수 효과 보강 ④ 금리 판단 변형: 한국 종목에 한국 금리(은행간 3개월 금리, FRED)를 쓰면? (점수 상위 4, 같은 판매 규칙·정수 주문·월 100만원)');
  log(`금리가 "1년 전보다 오른 달" 비율: 미국 ${(RATE_SHARE.us * 100).toFixed(0)}% · 한국 ${(RATE_SHARE.kr * 100).toFixed(0)}%`);
  log('변형                                     전체     앞쪽(2012~2019)  뒤쪽(2020~)   최대낙폭   이긴 해(코스피보다)');
  RATE_VAR.forEach(v => log(`  ${v.name.padEnd(36)} ${pc(v.s.cagr).padStart(8)}   ${pc(cagrOver(v.s.yearly, early)).padStart(10)}      ${pc(cagrOver(v.s.yearly, late)).padStart(9)}   ${pc(v.s.mdd).padStart(8)}   ${ksY ? YEARS_ALL.filter(Y => v.s.yearly[Y] > (ksY[Y] ?? 0)).length + '/' + YEARS_ALL.length : ''}`));
  log('→ 한국 금리 변형이 현재보다 앞쪽·뒤쪽 모두 좋고 낙폭도 작으면 한국 종목에는 한국 금리를 쓰는 것을 검토(시트 rateUp도 한국·미국 따로 내려야 함). 비슷하면 단순한 현재 방식 유지');
}
fs.writeFileSync(path.join(DATA, 'backtest.txt'), out.join('\n') + '\n');

// ── 매매일지(trades.json): A4 tp2x트레일+금리유예2달, 월 100만원
progress('매매일지', 0);
const journalSim = simulate(A4pk, 4, C1, { tpTrail: 2, grace: 2, graceRate: true, lotSize: true, lotAll: true, fill: true, cand: ym => scored[kA].get(ym) || [], log: true });   // 실제 주문 가능한 정수 주(한국·미국), 못 사면 다음 점수 순위를 사고, 추천이 모자라면 있는 만큼 나눔
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
  snapshots: journalSim.snapshots ? Object.fromEntries([...journalSim.snapshots].map(([ym, h]) => [ym, h.map(x => ({ y: x.y, name: nameMap.get(x.y)?.name || x.y, code: nameMap.get(x.y)?.code || '', buyYm: x.buyYm, buyPx: x.buyPx, curPx: x.curPx, sh: x.sh ? +x.sh.toFixed(4) : null, basis: x.basis ? Math.round(x.basis) : null, ret: x.curPx ? +((x.curPx / x.buyPx - 1)).toFixed(4) : 0, score: +x.score.toFixed(4) }))])) : {}
};
// 아직 보유 중이라 거래 기록(trades)에 없는 매수의 지표: 점수 산출 기준 화면용
const doneKey = new Set(journal.trades.map(t => t.y + '|' + t.buyYm)), openMap = new Map();
for (const h of (journalSim.snapshots || new Map()).values()) for (const x of h) {
  const key = x.y + '|' + x.buyYm;
  if (!doneKey.has(key) && !openMap.has(key) && x.feats) openMap.set(key, { y: x.y, buyYm: x.buyYm, feats: F.map((f, i) => [f, +((x.feats[i] || 0)).toFixed(4)]) });
}
journal.open = [...openMap.values()];
fs.writeFileSync(path.join(DATA, 'trades.json'), JSON.stringify(journal));
progress('매매일지', 1); process.stdout.write('\n');
// 매매일지 장부(ledger.json): 시뮬레이션이 달마다 직접 기록한 입금·매도·세금·매수·못 산 종목·월말 현금 (복원이 아니라 실제 값)
{
  const nm = y => nameMap.get(y)?.name || y, r0 = x => Math.round(x);
  const months = {};
  const CAND_N = 12;
  const candsOf = (ymKey, k) => (scored[kA].get(ymKey) || []).slice(0, CAND_N).map(e => { const o = px(e.r.y), p = o.m.get(k); return p === undefined ? null : { y: e.r.y, name: nm(e.r.y), us: e.r.x[US] === 1, etf: e.r.x[ETF] === 1, px: p, score: +e.s.toFixed(4) }; }).filter(Boolean);
  for (const [ym, m] of (journalSim.ledger || new Map())) {
    months[ym] = {
      dep: m.dep, tax: r0(m.tax), cash: r0(m.cash), holdVal: r0(m.holdVal), fx: +m.fx.toFixed(2),
      rateUp: (ffChg12(m.k) ?? 0) > 0,                    // 그달 기준금리 상승 중(판매 유예를 건너뛰는 조건): 시작 시점을 바꿔 다시 계산할 때 판매 시점을 구하는 데 씀
      cands: candsOf(ym, m.k),                            // 그달 점수 상위 후보 12개: 못 사면 다음 순위로 채우는 계산(시작 시점 바꾸기)에 씀
      buys: m.buys.map(x => ({ y: x.y, name: nm(x.y), us: x.us, sh: x.sh, px: x.px, amt: r0(x.amt), gross: r0(x.gross), fee: r0(x.fee), feeRate: x.feeRate,
        fxUsed: x.fx == null ? null : +x.fx.toFixed(2), score: +x.score.toFixed(4) })),
      sells: m.sells.map(x => ({ y: x.y, name: nm(x.y), us: x.us, sh: x.sh, px: x.px, amt: r0(x.amt), basis: r0(x.basis), gross: r0(x.gross), fee: r0(x.fee),
        feeRate: x.feeRate, tax: r0(x.tax), taxRate: x.taxRate, fxUsed: x.fx == null ? null : +x.fx.toFixed(2), ret: +x.ret.toFixed(4), reason: x.reason, buyYm: x.buyYm })),
      skipped: m.skipped.map(x => ({ y: x.y, name: nm(x.y), us: x.us, px: x.px, one: r0(x.pKrw), per: r0(x.per) })),
      order: m.order || []
    };
  }
  fs.writeFileSync(path.join(DATA, 'ledger.json'), JSON.stringify({ meta: { dep: DEP, made: new Date().toISOString(), orders: '정수 주(한국·미국), 못 사면 다음 점수 순위, 추천이 모자라면 있는 만큼 나눔' }, months }));
  require('./8_bars.js');                                  // 매매일지 차트용 월봉(bars.json): 거래한 종목 + 장부의 후보 종목
}                                      // 매매일지 차트용 월봉(bars.json)
