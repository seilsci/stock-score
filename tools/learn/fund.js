// 재무 지표(미국, SEC 공시) — 신호 시점에 "이미 공시된 값만" 써서 미래 정보가 섞이지 않게 계산
//   규칙
//   1) 신호 달 ym의 마지막 날까지 공시(filed)된 값만 사용. 신호 달 말 종가 이후의 공시는 안 봄.
//   2) 같은 기간(시작~끝)의 값이 정정 공시로 여러 번 있으면, 그 시점에 공시돼 있던 것 중 가장 늦게 공시된 값(당시 알던 값)을 씀. 나중에 고쳐진 값은 안 씀.
//   3) 연간 값은 기간 길이 340~380일인 것, 잔액(현금·자산·부채)은 시작일이 없는 값.
//   4) 가장 최근 연간 실적이 18개월보다 오래됐으면(공시 끊긴 종목) 없는 것으로 봄.
//   지표(이름 앞 f_는 data.js에서 가격 지표 묶음에서 제외): oi_pos 영업이익 흑자 · oi_margin 영업이익/매출 · oi_growth 영업이익 증가율 ·
//   ni_pos 순이익 흑자 · cash_ratio 현금/자산 · debt_ratio 부채/자산 · payout 배당/순이익 · pays_div 배당 지급 · fund_age 마지막 연간 실적이 끝난 지 몇 달
const { fs, path, DATA } = require('./common');
const NAMES = ['oi_pos', 'oi_margin', 'oi_growth', 'ni_pos', 'cash_ratio', 'debt_ratio', 'payout', 'pays_div', 'fund_age'];
const CACHE = new Map();
const key = y => y.replace(/[^A-Za-z0-9.\-]/g, '_') + '.json';
function loadCo(y, dir) {
  const k = (dir || DATA) + '|' + y; if (CACHE.has(k)) return CACHE.get(k);
  let o = null; try { const j = JSON.parse(fs.readFileSync(path.join(dir || path.join(DATA, 'sec'), key(y)))); o = j && j.f ? j.f : null; } catch (e) {}
  CACHE.set(k, o); return o;
}
const dayMs = 86400000, D = s => Date.parse(s + 'T00:00:00Z');
const lastDay = ym => { const y = Math.floor(ym / 100), m = ym % 100; return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
// 한 항목(우선순위 있는 여러 태그)의 값들 중 cutoff까지 공시된 것만, 같은 기간은 그때 알던 최신 공시로 → [{start,end,val,filed}]
function asKnown(item, cutoff, annualOnly) {
  for (const tag of Object.keys(item || {})) {
    const by = new Map();
    for (const [end, val, start, filed] of item[tag] || []) {
      if (filed > cutoff) continue;                                         // 아직 공시 전 → 못 봄
      if (annualOnly) { if (!start) continue; const d = (D(end) - D(start)) / dayMs; if (d < 340 || d > 380) continue; }
      else if (start) continue;
      const k = (start || '') + '|' + end, p = by.get(k);
      if (!p || filed > p.filed) by.set(k, { start, end, val, filed });
    }
    const arr = [...by.values()].sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
    if (arr.length) return arr;
  }
  return [];
}
function featuresAt(y, ym, dir) {
  const co = loadCo(y, dir); if (!co) return null;
  const cutoff = lastDay(ym);
  const oi = asKnown(co.OI, cutoff, true); if (!oi.length) return null;
  const A = oi[oi.length - 1];
  const age = (D(cutoff) - D(A.end)) / dayMs / 30.44;
  if (age > 18) return null;
  const same = (arr, end) => arr.find(x => Math.abs(D(x.end) - D(end)) <= 20 * dayMs);
  const rev = asKnown(co.REV, cutoff, true), ni = asKnown(co.NI, cutoff, true), div = asKnown(co.DIV, cutoff, true);
  const prev = oi.find(x => Math.abs(D(x.end) - (D(A.end) - 365.25 * dayMs)) <= 25 * dayMs);
  const R = same(rev, A.end), N = same(ni, A.end), V = same(div, A.end);
  const bal = k => { const a = asKnown(co[k], cutoff, false); return a.length ? a[a.length - 1] : null; };
  const as = bal('ASSETS'), ca = bal('CASH'), li = bal('LIAB');
  const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const o = {};
  o.oi_pos = A.val > 0 ? 1 : 0;
  o.oi_margin = R && R.val > 0 ? clip(A.val / R.val, -2, 1) : NaN;
  o.oi_growth = prev && prev.val !== 0 ? clip((A.val - prev.val) / Math.abs(prev.val), -3, 3) : NaN;
  o.ni_pos = N ? (N.val > 0 ? 1 : 0) : NaN;
  o.cash_ratio = as && ca && as.val > 0 ? clip(ca.val / as.val, 0, 1) : NaN;
  o.debt_ratio = as && li && as.val > 0 ? clip(li.val / as.val, 0, 3) : NaN;
  const dv = V ? Math.abs(V.val) : 0;
  o.pays_div = dv > 0 ? 1 : 0;
  o.payout = N ? (N.val > 0 ? clip(dv / N.val, 0, 2) : (dv > 0 ? 2 : 0)) : NaN;
  o.fund_age = age;
  return o;
}
module.exports = { NAMES, featuresAt, lastDay };
