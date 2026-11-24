// 매매일지 장부: trades.json(거래·보유 스냅샷)으로 달마다 입금·매수·매도·세금·월말 현금·보유 평가금을 복원 → ledger.json
//   시뮬레이션 순서(7_backtest.js simulate): 매도 → (12월) 미국 양도세 → 입금 → 매수(종목당 = 그달 현금 ÷ 4)
//   검증: 매수 금액 ×4 = 그달 매수 직전 현금이어야 하므로, 복원한 현금과 맞는지 달마다 비교(어긋남은 meta.maxDrift에 기록)
//   환율: data/fx.json(PC, FRED)이 있으면 그걸, 없으면 야후 KRW=X 월봉 종가
//   단독 실행:  node tools/learn/9_ledger.js     (7_backtest.js 끝에서도 자동 실행)
const { fs, path, DATA, getJSON, yahooMonthly } = require('./common');
const j = JSON.parse(fs.readFileSync(path.join(DATA, 'trades.json')));
const C = JSON.parse(fs.readFileSync(path.join(__dirname, 'costs.json')));
const usFee = C.us.commission + C.us.fx_spread, N = 4, dep = j.meta.dep || 1000000;
const isUS = y => !/\.(KS|KQ)$/.test(y);
const krTax = Y => { const t = C.kr.sell_tax; let v = 0; Object.keys(t).map(Number).sort().forEach(y => { if (y <= Y) v = t[y]; }); return v; };   // 7_backtest.js와 같은 규칙
const isEtf = t => { const f = (t.feats || []).find(x => x[0] === 'etf'); return !!(f && f[1] === 1); };
const yms = Object.keys(j.snapshots).sort();

(async () => {
  // 월말 환율(원/달러)
  let fx = {}, fxSrc = 'fx.json';
  try { fx = JSON.parse(fs.readFileSync(path.join(DATA, 'fx.json'))); } catch (e) {}
  if (!Object.keys(fx).length) {
    fxSrc = 'yahoo KRW=X';
    const P2 = Math.floor(Date.now() / 1000) + 86400;
    const m = yahooMonthly(await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/KRW%3DX?period1=1293840000&period2=${P2}&interval=1mo`)) || [];
    m.forEach(b => { if (b[4] > 500 && b[4] < 2500) fx[b[0]] = b[4]; });     // 야후에 0.11원 같은 잘못된 값이 섞여 있어 걸러냄(빠진 달은 직전 달 값 사용)
  }
  const fxAt = ym => { let q = +ym; for (let k = 0; k < 8; k++) { if (fx[q]) return fx[q]; q = q % 100 === 1 ? q - 89 : q - 1; } return 1; };
  const prevYm = ym => { ym = +ym; return ym % 100 === 1 ? ym - 89 : ym - 1; };

  // 종목·매수월별 수량·금액: 매수한 달 스냅샷에서, 매도 수량은 매도 직전 달 스냅샷에서
  const snapOf = (ym, y, buyYm) => (j.snapshots[ym] || []).find(x => x.y === y && x.buyYm === buyYm);
  const buys = {}, sells = {};
  yms.forEach(ym => { buys[ym] = []; sells[ym] = []; });
  for (const t of j.trades) {
    const b = snapOf(t.buyYm, t.y, t.buyYm); if (!b) continue;
    const us = isUS(t.y);
    const lastSnap = snapOf(prevYm(t.sellYm), t.y, t.buyYm) || b;
    const got = b.basis * (1 + t.ret), feeRate = us ? usFee : C.kr.commission;
    // 매수: 쓴 돈(amt) = 주식값(gross) + 수수료(fee).  주식값 = 수량 × 가격 (× 환율)
    const bFee = b.basis * feeRate, bGross = b.basis - bFee;
    // 매도: 받은 돈(amt) = 주식값(gross) - 수수료 - 거래세(한국 일반주식만). 주식값 = amt / (1 - 수수료율 - 세율)
    const taxRate = us ? 0 : ((isEtf(t) && C.kr.etf_exempt) ? 0 : krTax(Math.floor(t.sellYm / 100)));
    const sGross = got / (1 - feeRate - taxRate);
    if (buys[t.buyYm]) buys[t.buyYm].push({ y: t.y, name: t.name, us, sh: b.sh, px: t.buyPx, amt: b.basis, score: t.score,
      gross: bGross, fee: bFee, feeRate, fxUsed: us ? bGross / (b.sh * t.buyPx) : null });
    if (sells[t.sellYm]) sells[t.sellYm].push({ y: t.y, name: t.name, us, sh: lastSnap.sh, px: t.sellPx, amt: got, basis: b.basis, ret: t.ret, reason: t.reason, buyYm: t.buyYm,
      gross: sGross, fee: sGross * feeRate, feeRate, tax: sGross * taxRate, taxRate, fxUsed: us ? sGross / (lastSnap.sh * t.sellPx) : null });
  }
  // 현재 보유 중(거래 기록 없음)인 매수도 매수 내역에 넣음
  const done = new Set(j.trades.map(t => t.y + '|' + t.buyYm));
  for (const ym of yms) for (const x of j.snapshots[ym]) {
    if (x.buyYm === +ym && !done.has(x.y + '|' + x.buyYm)) {
      const us = isUS(x.y), feeRate = us ? usFee : C.kr.commission, fee = x.basis * feeRate, gross = x.basis - fee;
      buys[ym].push({ y: x.y, name: x.name, us, sh: x.sh, px: x.buyPx, amt: x.basis, score: x.score, gross, fee, feeRate, fxUsed: us ? gross / (x.sh * x.buyPx) : null });
    }
  }

  const months = {}; let cash = 0, maxDrift = 0, negative = 0; const usGain = {};
  for (const ym of yms) {
    const Y = Math.floor(+ym / 100), m = +ym % 100;
    let sellAmt = 0;
    sells[ym].forEach(s => { sellAmt += s.amt; if (s.us) usGain[Y] = (usGain[Y] || 0) + s.amt - s.basis; });
    cash += sellAmt;
    let tax = 0;
    if (m === 12) { tax = C.us.cg_tax_rate * Math.max(0, (usGain[Y] || 0) - C.us.cg_exemption_krw); cash -= tax; }
    cash += dep;
    const b = buys[ym];
    const buyAmt = b.reduce((t, x) => t + x.amt, 0);
    if (b.length) {                                         // 매수 금액 ×4 = 직전 현금: 어긋남 확인 후 정확한 값으로 맞춤
      const exact = b[0].amt * N;
      maxDrift = Math.max(maxDrift, Math.abs(exact - cash));
      cash = exact;
    }
    cash -= buyAmt;
    if (cash < -1) negative++;
    // 월말 보유 평가금(미국은 월말 환율 적용)
    let hv = 0;
    const holds = (j.snapshots[ym] || []).map(x => {
      const us = isUS(x.y), val = x.sh * x.curPx * (us ? fxAt(ym) : 1);
      hv += val; return { y: x.y, name: x.name, us, sh: x.sh, px: x.curPx, val, basis: x.basis, buyYm: x.buyYm, buyPx: x.buyPx };
    });
    months[ym] = {
      dep, tax: Math.round(tax), cash: Math.round(cash), holdVal: Math.round(hv), fx: +fxAt(ym).toFixed(2),
      buys: b.map(x => ({ ...x, sh: +x.sh.toFixed(4), amt: Math.round(x.amt), score: +x.score.toFixed(4),
        gross: Math.round(x.gross), fee: Math.round(x.fee), fxUsed: x.fxUsed == null ? null : +x.fxUsed.toFixed(2) })),
      sells: sells[ym].map(x => ({ ...x, sh: +x.sh.toFixed(4), amt: Math.round(x.amt), basis: Math.round(x.basis),
        gross: Math.round(x.gross), fee: Math.round(x.fee), tax: Math.round(x.tax), fxUsed: x.fxUsed == null ? null : +x.fxUsed.toFixed(2) }))
    };
    for (const h of holds) { /* 평가금은 화면에서 snapshots + fx로 계산하므로 여기엔 합계만 */ }
  }
  const out = { meta: { dep, fxSrc, maxDrift: Math.round(maxDrift), negative, made: new Date().toISOString() }, months };
  fs.writeFileSync(path.join(DATA, 'ledger.json'), JSON.stringify(out));
  console.log(`\n장부: ${yms.length}개월, 환율 ${fxSrc}, 현금 복원 최대 어긋남 ${Math.round(maxDrift).toLocaleString()}원, 현금 음수 ${negative}회 → ${path.join(DATA, 'ledger.json')}`);
})();
