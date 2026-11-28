// 묶음 48(확인용 분석, 백테스트 아님): data_2003 월봉·장부로 ① 월 적립 IRR(2005~) ② 크게 폭락한 종목(고점 대비 −80%) 534개 같은 규칙 재생 ③ 지금 거래정지인 코스피·코스닥 종목(네이버)이 후보였는지·정지 전에 팔았는지
// 쓰는 법: DATA=data_2003 node ck_old.js   (네이버 접속 필요: 클라우드는 NODE_USE_ENV_PROXY=1)
const fs = require('fs'), path = require('path');
const D = process.env.DATA || path.join(__dirname, 'data_2003');
const R = require(path.join(D, 'rates.json')), bars = require(path.join(D, 'bars.json'));
const prevYm = ym => (ym % 100 === 1 ? ym - 89 : ym - 1);
const rateUp = ym => { let y = ym; for (let i = 0; i < 6; i++) y = prevYm(y); const a = R[ym] && R[ym].dgs10, b = R[y] && R[y].dgs10; return a != null && b != null ? a > b : null; };
function replay(B, kr) {                                             // 지금 규칙을 한 종목에만 적용(점수 순위·수급·비용은 없음): 돌파 후 +10%·5>10>20 → 판매 한국 6이평·미국 10이평, 유예 2달·금리 상승 즉시, 익절 트레일 2배
  const ma = (i, n) => (i < n - 1 ? null : B.slice(i - n + 1, i + 1).reduce((s, b) => s + b.c, 0) / n); let pos = null; const tr = [];
  for (let i = 1; i < B.length - 1; i++) {
    const b = B[i], m10 = ma(i, 10); if (m10 == null) continue;
    if (pos) { if (b.c >= 2 * m10) pos.tp = true; const ex = ma(i, kr ? 6 : 10); let why = null;
      if (pos.tp && b.c < 2 * m10) why = '익절'; else if (ex != null && b.c < ex) { pos.g = (pos.g || 0) + 1; if (rateUp(b.ym) === true) why = '금리'; else if (pos.g >= 2) why = '유예'; } else pos.g = 0;
      if (why) { tr.push({ b: pos.ym, bi: pos.i, s: b.ym, si: i, r: b.c / pos.px - 1, why }); pos = null; } }
    else for (let j = Math.max(1, i - 6); j < i; j++) { const mj = ma(j, 10), mjp = ma(j - 1, 10); if (mj == null || mjp == null) continue;
      if (B[j - 1].c <= mjp && B[j].c > mj) { const o1 = B[j + 1].o, m5 = ma(i, 5), m20 = ma(i, 20); if (b.c >= 1.1 * o1 && m5 && m20 && m5 > m10 && m10 > m20) { pos = { ym: B[i + 1].ym, i: i + 1, px: B[i + 1].o, tp: false, g: 0 }; break; } } }
  }
  if (pos) tr.push({ b: pos.ym, bi: pos.i, s: '보유중', si: B.length - 1, r: B[B.length - 1].c / pos.px - 1, why: 'open' });
  return tr;
}
const toB = raw => { const B = []; for (let i = 0; i < raw.length; i += 6) B.push({ ym: raw[i], o: raw[i + 1] || raw[i + 4], c: raw[i + 4], v: raw[i + 5] }); return B; };
const isKRsym = s => /\.(KS|KQ)$/.test(s);
(async () => {
  // ① IRR
  const L = require(path.join(D, 'ledger.json')), M = L.months, ks = Object.keys(M).sort();
  const irr = to => { const kk = ks.filter(k => k <= to), cf = kk.map(k => -M[k].dep), l = M[kk[kk.length - 1]]; cf[cf.length - 1] += l.cash + l.holdVal;
    const f = r => cf.reduce((s, c, i) => s + c / Math.pow(1 + r, i), 0); let lo = -0.1, hi = 0.1; for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; f(m) > 0 ? lo = m : hi = m; }
    return { to, months: kk.length, invested: kk.length * 1e6, final: Math.round(l.cash + l.holdVal), irr: +((Math.pow(1 + (lo + hi) / 2, 12) - 1) * 100).toFixed(1) }; };
  console.log('## 48 월 적립 IRR(장부 평가금 기준, 월 100만원)'); ['200812', '200912', '201112', '201512', '202012', ks[ks.length - 1]].forEach(t => console.log(JSON.stringify(irr(t))));
  // ② 폭락 종목
  const out = [];
  for (const sym of Object.keys(bars)) { const B = toB(bars[sym]).filter(b => b.c > 0); if (B.length < 60) continue;
    let peak = B[0].c, pi = 0, worst = 0, wp = 0, wt = 0; B.forEach((b, i) => { if (b.c > peak) { peak = b.c; pi = i; } const dd = b.c / peak - 1; if (dd < worst) { worst = dd; wp = pi; wt = i; } });
    if (worst > -0.8) continue; let rev = false; for (let i = wt + 1; i < B.length; i++) if (B[i].c >= 3 * B[wt].c) { rev = true; break; }
    const tr = replay(B, isKRsym(sym)), inWin = tr.filter(t => t.bi <= wt && t.si >= wp), held = tr.some(t => t.bi <= wt && t.si > wt), near = tr.filter(t => t.s !== '보유중' && t.bi <= wt && t.bi >= wt - 12);
    out.push({ sym, kr: isKRsym(sym), rev, dd: worst, inWin: inWin.length, worst: inWin.length ? Math.min(...inWin.map(t => t.r)) : null, held, near });
  }
  const pc0 = (n, d) => (d ? (n / d * 100).toFixed(0) + '%' : '-'), med = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? (s[s.length >> 1] * 100).toFixed(0) + '%' : '-'; };
  console.log('\n## 48 −80% 넘게 폭락한 종목(2000~) 같은 규칙 재생'); console.log(`폭락 종목 ${out.length}(한국 ${out.filter(x => x.kr).length}·미국 ${out.filter(x => !x.kr).length}), 되살아남(바닥의 3배 이상) ${out.filter(x => x.rev).length}, 보유만 했다면 낙폭 중앙값 ${med(out.map(x => x.dd))}`);
  const w = out.filter(x => x.worst != null).map(x => x.worst); console.log(`폭락 구간에 거래가 열린 종목 ${w.length}, 최악 거래 ≤−50% ${w.filter(v => v <= -0.5).length}(${pc0(w.filter(v => v <= -0.5).length, out.length)}) ≤−30% ${w.filter(v => v <= -0.3).length} ≤−20% ${w.filter(v => v <= -0.2).length}, 바닥까지 보유 ${out.filter(x => x.held).length}종목`);
  const nr = out.flatMap(x => x.near.map(t => t.r)); console.log(`바닥 12개월 안에 산 거래 ${nr.length}건(${out.filter(x => x.near.length).length}종목), 수익 중앙값 ${med(nr)}, ≤−50% ${nr.filter(v => v <= -0.5).length}건`);
  // ③ 지금 거래정지 종목(네이버)
  let H = [], tot = 0;
  try { for (const mk of ['KOSPI', 'KOSDAQ']) for (let p = 1; p < 60; p++) { const j = await (await fetch(`https://m.stock.naver.com/api/stocks/marketValue/${mk}?page=${p}&pageSize=100`)).json(); const s = j.stocks || []; if (!s.length) break; tot += s.length;
    s.forEach(x => { if (x.tradeStopType && x.tradeStopType.code !== '1' && x.stockEndType === 'stock') H.push({ mk, code: x.itemCode, name: x.stockName, y: x.itemCode + (mk === 'KOSPI' ? '.KS' : '.KQ') }); }); if (s.length < 100) break; } } catch (e) { console.log('네이버 목록 받기 실패', e.message); }
  const trades = require(path.join(D, 'trades.json')), led = Array.isArray(trades) ? trades : (trades.trades || Object.values(trades)[0]); const sym = x => x.code + (x.market === 'KOSPI' ? '.KS' : x.market === 'KOSDAQ' ? '.KQ' : '');
  const ymEnd = ym => { const y = Math.floor(ym / 100), m = ym % 100; return y * 10000 + m * 100 + new Date(y, m, 0).getDate(); };
  console.log(`\n## 48 지금 거래정지인 코스피·코스닥 주식(네이버 ${tot}종목 중 ${H.length}개) — 우리 자료에 있는 종목만`);
  console.log('종목 | 마지막 거래일 | 규칙 거래 | 정지 전 마지막 거래 | 정지 때 보유 | 일지 구매');
  let heldN = 0, n = 0;
  for (const h of H) { const raw = bars[h.y]; if (!raw) continue; let last = null;
    for (let pg = 1; pg <= 50 && !last; pg++) { const j = await (await fetch(`https://m.stock.naver.com/api/stock/${h.code}/price?pageSize=60&page=${pg}`)).json(); if (!Array.isArray(j) || !j.length) break; const hit = j.find(x => (x.accumulatedTradingVolume || 0) > 0); if (hit) last = hit.localTradedAt; }
    const tr = replay(toB(raw), true), ln = last ? +last.replace(/-/g, '') : null, open = ln ? tr.filter(x => x.b * 100 + 1 <= ln && (x.s === '보유중' || ymEnd(x.s) > ln)) : [], prior = ln ? tr.filter(x => x.s !== '보유중' && ymEnd(x.s) <= ln) : tr, lt = prior[prior.length - 1];
    n++; if (open.length) heldN++;
    console.log(h.name, h.code, last || '-', tr.length, lt ? `${lt.b}→${lt.s} ${(lt.r * 100).toFixed(0)}% ${lt.why}` : '-', open.length ? '⚠보유' : '아님', led.filter(x => sym(x) === h.y).length);
    await new Promise(r => setTimeout(r, 120)); }
  console.log(`정지 때 보유 ${heldN} / ${n}`);
})();
