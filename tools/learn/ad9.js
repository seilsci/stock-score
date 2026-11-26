'use strict';
// ad9.js — 시험 목록 전체(122개 중 지금 자료로 되는 것) 묶음. 7_backtest.js의 STAGE14 안에서 AD9=1~10(쉼표로 여러 개) 또는 all 로 부름.
//   기준(A) = 지금 규칙(확인 매수 + 익절 2배 트레일 + 유예 2달 + 국채10년 금리, 상위 4, 월 100만원, 시총 기준 events.csv).
//   묶음: 1 매수 신호 · 2 순위 · 3 점수 모델 · 4 비중·구성 · 5 매도 · 6 자금·비용·세금 · 7 체결·시점 · 8 종목 범위 · 9 검증 · 10 다른 전략과 비교
//   결과는 7_backtest.js의 "확인 매수 후속 ..." 표로 나오고(전체·앞쪽·뒤쪽·낙폭·절반 되풀이), 9·10과 2의 일부는 따로 "## ..." 보고가 붙음.
//   한 시험이 오류여도 나머지는 계속 돌고 이름 끝에 [오류: ...]가 붙음. 일봉·새 자료가 필요한 것은 여기에 없음(README-PC.md 참고).

function build(c, which) {
  const { V, AD8, pool, simulate, simOpt, summ, C1, DEP, mi, ymOf, px, fx, ma10, maAtN, F, fi, US, TURN, ETF, hash01, rateJ, MACRO, scored, kA, byYm, CO_NAME, chg,
    YEARS_ALL, log, cagrOver, END, rescore, ALL, dailyOf, score, z, prep, fitRidge, MK, divOf, fs, path, DATA, RAW } = c;
  const want = String(which).split(',').map(s => s.trim());
  const on = n => want.includes('all') || want.includes(String(n));
  const pc = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
  const X = {}; ['gap', 'below', 'high24', 'c_ma60', 'upwick', 'prev_fail', 'ret12', 'idx_ret12', 'volat12', 'ret3', 'slope1'].forEach(n => { X[n] = fi(n); });

  // ── 공통 도구
  const isKR = y => /\.(KS|KQ)$/.test(y);
  const turnAt = (o, j) => { const v = o.vol.get(j), p = o.m.get(j); return v > 0 && p > 0 ? v * p : null; };
  const avgTurn = (o, j, n) => { let s = 0, k = 0; for (let i = j - n; i < j; i++) { const t = turnAt(o, i); if (t) { s += t; k++; } } return k >= n / 2 ? s / k : null; };
  const retN = (o, j, n) => { const a = o.m.get(j), b = o.m.get(j - n); return a > 0 && b > 0 ? a / b - 1 : null; };
  const pctl = (a, p) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.max(0, Math.floor(p * b.length)))] : NaN; };
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
  const sdOf = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
  let BENCH = {}; try { BENCH = JSON.parse(fs.readFileSync(path.join(DATA, 'bench.json'), 'utf8')); } catch (e) {}
  const idxAt = (key, k) => (BENCH[key] || {})[ymOf(k)];
  const idxMa = (key, k, n) => { let s = 0; for (let j = k; j > k - n; j--) { const v = idxAt(key, j); if (!v) return null; s += v; } return s / n; };
  const idxBelow = (key, k) => { const a = idxAt(key, k), m = idxMa(key, k, 10); return a && m ? a < m : null; };
  const CAP = new Map(); try { JSON.parse(fs.readFileSync(path.join(DATA, 'lists.json'), 'utf8')).forEach(x => CAP.set(x.y, x.cap)); } catch (e) {}
  const mc = m => { const x = m && MACRO[m]; return x || {}; };
  const num = v => (v === '' || v == null ? null : +v);

  const posts = [];                                                           // 묶음별 따로 붙는 보고(9·10)
  const rule10 = { tp: 2, grace: 2, rate: true, rateFn: chg('dgs10', 6) };
  const mk = (q, rule) => pool({ thr: 0.1, rule: rule || rule10, rateName: (rule && rule.rateName) || '국채10년 6개월', ...q });
  const candOf = m => ym => m.get(ym) || [];
  const mBase = mk({});
  V.push({ sec: '기준', name: 'A 지금(확인 매수·tp2x·유예2·금리·상위 4)', cand: candOf(mBase), rule: rule10 });
  const add = (sec, name, extra) => { V.push({ sec, name, rule: rule10, ...extra }); };
  const addPool = (sec, name, q, extra = {}, rule) => { const m = mk(q, rule); add(sec, name, { cand: candOf(m), ...(rule ? { rule } : {}), ...extra }); return m; };
  const wrap = (m, f) => ym => f(m.get(ym) || [], ym);
  const sortBy = (m, key, dir) => wrap(m, a => {
    const rows = a.map(e => { const v = key(e); return [e, v == null || !Number.isFinite(v) ? (dir > 0 ? -1e18 : 1e18) : v]; });
    rows.sort((x, y) => dir * (y[1] - x[1])); return rows.map(x => x[0]);
  });

  // 월봉에서 가격 지표를 다시 만드는 도구(묶음 18·20 공용): featAt(px, 월, 기본 지표 배열) → 갱신한 지표 배열(못 만들면 null)
  const FI = {}; ['gap', 'slope1', 'slope3', 'cross24', 'below', 'above24', 'c_ma12', 'ma10_ma24', 'vol', 'vol3', 'body', 'upwick', 'lowwick', 'range', 'ret1', 'ret3', 'ret12', 'high24', 'dd36', 'volat12', 'turn', 'up6', 'slope6', 'c_ma60', 'hi12_break', 'vol_max36', 'ma_up6', 'close_pos', 'gap_prev'].forEach(n => { FI[n] = fi(n); });
  const MANs = +process.env.MA_N || 10;
  const featAt = (o, k, x0) => {
    const c = j => o.m.get(k - j), ma = j => maAtN(o, k - j, MANs), ab = j => { const a = c(j), m = ma(j); return a > 0 && m > 0 ? a > m : null; };
    const c0 = c(0), ma0 = ma(0); if (!(c0 > 0) || !(ma0 > 0)) return null;
    const x = x0.slice(), set = (n, v) => { if (v != null && Number.isFinite(v)) x[FI[n]] = v; };
    const avgC = (a, b2) => { let t = 0; for (let j = a; j <= b2; j++) { const v = c(j); if (!(v > 0)) return null; t += v; } return t / (b2 - a + 1); };
    const maxHi = (a, b2) => { let t = -1; for (let j = a; j <= b2; j++) { const v = o.hi.get(k - j); if (v > t) t = v; } return t > 0 ? t : null; };
    const avgV = (a, b2) => { let t = 0, n = 0; for (let j = a; j <= b2; j++) { const v = o.vol.get(k - j); if (v > 0) { t += v; n++; } } return n ? t / n : null; };
    set('gap', c0 / ma0 - 1);
    const m1 = ma(1), m3 = ma(3), m6 = ma(6); if (m1) set('slope1', ma0 / m1 - 1); if (m3) set('slope3', ma0 / m3 - 1); if (m6) set('slope6', ma0 / m6 - 1);
    { let cr = 0, a24 = 0, ok = true; for (let j = 1; j <= 24; j++) { const a = ab(j), b2 = ab(j + 1); if (a == null || b2 == null) { ok = false; break; } if (a !== b2) cr++; if (a) a24++; } if (ok) { set('cross24', cr); set('above24', a24 / 24); } }
    { let bl = 0; for (let j = 1; j < 120; j++) { const a = ab(j); if (a === false) bl++; else break; } set('below', bl); }
    const a12 = avgC(0, 11), a24m = avgC(0, 23), a60 = avgC(0, 59); if (a12) set('c_ma12', c0 / a12 - 1); if (a24m) set('ma10_ma24', ma0 / a24m - 1); if (a60) set('c_ma60', c0 / a60 - 1);
    const op = o.op.get(k), h = o.hi.get(k), l = o.lo.get(k);
    if (op > 0 && h > 0 && l > 0) { const hl = h - l || 1; set('body', (c0 - op) / op); set('upwick', (h - Math.max(op, c0)) / hl); set('lowwick', (Math.min(op, c0) - l) / hl); set('range', hl / op); set('close_pos', (c0 - l) / hl); }
    const c1 = c(1), c3 = c(3), c12 = c(12); if (c1 > 0) set('ret1', c0 / c1 - 1); if (c3 > 0) set('ret3', c0 / c3 - 1); if (c12 > 0) set('ret12', c0 / c12 - 1);
    { const h24 = maxHi(1, 24), h36 = maxHi(1, 36), h12 = maxHi(1, 12); if (h24) set('high24', c0 / h24 - 1); if (h36) set('dd36', c0 / h36 - 1); if (h12) set('hi12_break', c0 >= h12 ? 1 : 0); }
    { const lr = []; let ok = true; for (let j = 0; j < 12; j++) { const a = c(j), b2 = c(j + 1); if (!(a > 0 && b2 > 0)) { ok = false; break; } lr.push(Math.log(a / b2)); } if (ok) { const mu = lr.reduce((t, v) => t + v, 0) / 12; set('volat12', Math.sqrt(lr.reduce((t, v) => t + (v - mu) ** 2, 0) / 12)); } }
    { let up = 0, mu = 0, ok = true; for (let j = 0; j < 6; j++) { const a = c(j), b2 = c(j + 1), ma1 = ma(j), ma2 = ma(j + 1); if (!(a > 0 && b2 > 0 && ma1 > 0 && ma2 > 0)) { ok = false; break; } if (a > b2) up++; if (ma1 > ma2) mu++; } if (ok) { set('up6', up); set('ma_up6', mu); } }
    { const pg = ab(1) != null && c1 > 0 && ma(1) > 0 ? c1 / ma(1) - 1 : null; set('gap_prev', pg); }
    { const v = o.vol.get(k), v12 = avgV(1, 12), v3 = avgV(0, 2), vb = avgV(3, 14); const v36 = (() => { let t = 0; for (let j = 1; j <= 36; j++) { const q = o.vol.get(k - j); if (q > t) t = q; } return t; })();
      if (v > 0 && v12) { set('vol', Math.log((v + 1) / (v12 + 1))); set('turn', Math.log10(v12 * c0 + 1)); } if (v3 && vb) set('vol3', Math.log((v3 + 1) / (vb + 1))); if (v > 0 && v36 > 0) set('vol_max36', v / v36); }
    return x;
  };

  // ═════ 묶음 1: 매수 신호 (돌파·확인 조건)
  if (on(1)) {
    const S = n => `1-${n}`;
    [1.5, 2, 3].forEach(m => addPool(S('01 돌파 달 거래대금'), `돌파 달 거래대금이 평소(직전 12개월)의 ${m}배 이상인 돌파만`, { ck: 'tv' + m, sig: (r, o, t0) => { const t = turnAt(o, t0), a = avgTurn(o, t0, 12); return !!(t && a && t / a >= m); } }));
    [0.02, 0.05, 0.1].forEach(g => addPool(S('02 돌파 강도'), `돌파 달 종가가 10이평보다 ${g * 100}% 이상 위`, { ck: 'gp' + g, sig: (r, o, t0) => { const ma = maAtN(o, t0, 10), cl = o.m.get(t0); return !!(ma && cl / ma - 1 >= g); } }));
    [6, 12, 24].forEach(n => addPool(S('03 10이평 아래 있던 기간'), `돌파 전 10이평 아래 연속 ${n}개월 이상`, { ck: 'bl' + n, sig: r => r.x[X.below] >= n }));
    addPool(S('04 신고가'), '24개월 신고가를 같이 돌파', { ck: 'h24a', sig: r => r.x[X.high24] >= 0 });
    addPool(S('04 신고가'), '24개월 고점 대비 −10% 이내', { ck: 'h24b', sig: r => r.x[X.high24] >= -0.1 });
    addPool(S('05 이평 방향'), '확인 달에 10이평이 올라가는 중', { ck: 'mar', cond: ({ o, j }) => { const a = maAtN(o, j, 10), b = maAtN(o, j - 1, 10); return !!(a && b && a > b); } });
    addPool(S('06 60이평'), '돌파 달 종가 > 60이평일 때만', { ck: 'm60a', sig: r => r.x[X.c_ma60] > 0 });
    addPool(S('06 60이평'), '60이평 아래에서의 첫 돌파만', { ck: 'm60b', sig: r => r.x[X.c_ma60] < 0 });
    [0.2, 0.35].forEach(u => addPool(S('07 윗꼬리'), `돌파 봉 윗꼬리 ${u * 100}% 초과 제외`, { ck: 'uw' + u, sig: r => !(r.x[X.upwick] > u) }));
    [2, 3].forEach(n => addPool(S('08 연속 상승'), `확인 때까지 ${n}개월 연속 상승`, { ck: 'up' + n, cond: ({ o, j }) => o.m.get(j) > o.m.get(j - 1) && (n < 3 || o.m.get(j - 1) > o.m.get(j - 2)) }));
    [1, 2].forEach(n => addPool(S('09 돌파 실패 이력'), `최근 3년 돌파 실패 ${n + 1}번 이상이면 제외`, { ck: 'pf' + n, sig: r => !(r.x[X.prev_fail] > n) }));
    [2, 3].forEach(n => addPool(S('10 확인 조건 바꾸기'), `확인 = +10% 대신 ${n}개월 연속 10이평 위`, { ck: 'cf' + n, confirm: ({ o, j }) => { for (let i = 0; i < n; i++) { const cl = o.m.get(j - i), ma = maAtN(o, j - i, 10); if (!(cl > ma)) return false; } return true; } }));
    addPool(S('11 확인 조건 바꾸기'), '확인 = +10% 대신 돌파 달 고가를 넘음', { ck: 'cfh', confirm: ({ o, j, t0 }) => o.m.get(j) > (o.hi.get(t0) || Infinity) });
    addPool(S('12 정배열 강화'), '정배열 5>10>20>60', { ck: 'al4', alignFn: (o, j) => { const a = maAtN(o, j, 5), b = maAtN(o, j, 10), d = maAtN(o, j, 20), e = maAtN(o, j, 60); return !!(a && b && d && e && a > b && b > d && d > e); } });
    [0.3, 0.5, 0.8].forEach(x => addPool(S('13 과열 제외'), `확인 달 종가가 10이평보다 ${x * 100}% 이상 벌어지면 제외`, { ck: 'oh' + x, cond: ({ o, j, p }) => { const ma = maAtN(o, j, 10); return !!(ma && p / ma - 1 < x); } }));
    [2, 3].forEach(x => addPool(S('14 많이 오른 종목 제외'), `36개월 저점 대비 +${x * 100}% 이상 오른 종목 제외`, { ck: 'lo' + x, cond: ({ o, j, p }) => { let lo = Infinity; for (let i = j - 35; i <= j; i++) { const v = o.lo.get(i) || o.m.get(i); if (v && v < lo) lo = v; } return lo < Infinity && p / lo - 1 < x; } }));
    [0.05, 0.1].forEach(b => addPool(S('15 눌림 매수'), `+10% 확인 뒤 10이평 +${b * 100}% 안으로 눌릴 때 삼(6개월 안)`, { ck: 'pb' + b, confirm: ({ o, j, p, p0, st }) => { const ma = maAtN(o, j, 10); if (!st.armed) { if (p / p0 - 1 >= 0.1) { st.armed = true; st.t = j; } else return false; } return !!(ma && j - st.t <= 6 && p > ma && p / ma - 1 <= b); } }));
    [[0.15, 0.1], [0.1, 0.15], [0.05, 0.1], [0.1, 0.05], [0.2, 0.1]].forEach(([k, u]) => addPool(S('16 문턱을 시장별로'), `확인 문턱 한국 ${k * 100}% · 미국 ${u * 100}%`, { ck: 'th' + k + '_' + u, thrFn: r => (isKR(r.y) ? k : u) }));
    addPool(S('19 상대강도'), '12개월 수익률이 시장 지수보다 높을 때만', { ck: 'rs', sig: r => r.x[X.ret12] > r.x[X.idx_ret12] });
    { const sizes = []; mBase.forEach(a => sizes.push(a.length)); const med = pctl(sizes, 0.5), p90 = pctl(sizes, 0.9);
      add(S('20 후보가 몰린 달'), `후보가 많은 달(중앙값 ${med}개 이상)만 매수`, { cand: wrap(mBase, a => (a.length >= med ? a : [])) });
      add(S('20 후보가 몰린 달'), `후보가 너무 많은 달(상위 10%, ${p90}개 이상)은 쉼`, { cand: wrap(mBase, a => (a.length >= p90 ? [] : a)) }); }
    { const bm = ym => (ym % 100) % 12 + 1;
      add(S('21 계절성'), '11~4월 매수만', { cand: wrap(mBase, (a, ym) => ([11, 12, 1, 2, 3, 4].includes(bm(ym)) ? a : [])) });
      add(S('21 계절성'), '5~10월 매수만', { cand: wrap(mBase, (a, ym) => ([5, 6, 7, 8, 9, 10].includes(bm(ym)) ? a : [])) });
      add(S('21 계절성'), '12월 매수 쉼', { cand: wrap(mBase, (a, ym) => (bm(ym) === 12 ? [] : a)) }); }
    add(S('22 금리차'), '장단기 금리차가 역전(10년−2년<0)된 달은 신규 매수 쉼', { cand: candOf(mBase), o: { buyBlock: (k, ym) => { const v = num(mc(ym).t10y2y); return v != null && v < 0; } } });
    add(S('23 VIX'), 'VIX 30 이상인 달은 신규 매수 쉼', { cand: candOf(mBase), o: { buyBlock: (k, ym) => { const v = num(mc(ym).vix); return v != null && v >= 30; } } });
    add(S('23 VIX'), 'VIX 30 이상인 달에만 신규 매수', { cand: candOf(mBase), o: { buyBlock: (k, ym) => { const v = num(mc(ym).vix); return !(v != null && v >= 30); } } });
    add(S('24 금리 상승기'), '국채10년 금리 오르는 중이면 신규 매수 쉼', { cand: candOf(mBase), o: { buyBlock: k => rateJ(k - 1) === true } });
    add(S('24 금리 상승기'), '국채10년 금리 오르는 중이면 2종목만', { cand: candOf(mBase), o: { nFn: ym => (rateJ(mi(ym)) === true ? 2 : 4) } });
  }

  // ═════ 묶음 2: 순위 (점수 대신·함께)
  if (on(2)) {
    const S = n => `2-${n}`;
    const j0 = e => mi(e.r.ym), o0 = e => px(e.r.y);
    const mom = n => e => retN(o0(e), j0(e), n);
    add(S('26 점수 하위(대조)'), '점수 낮은 순 4종목', { cand: sortBy(mBase, e => e.s, -1) });
    [12, 6, 3].forEach(n => { add(S('27 모멘텀'), `${n}개월 수익률 큰 순`, { cand: sortBy(mBase, mom(n), 1) }); add(S('27 모멘텀'), `${n}개월 수익률 작은 순(대조)`, { cand: sortBy(mBase, mom(n), -1) }); });
    add(S('29 변동성'), '12개월 변동성 작은 순', { cand: sortBy(mBase, e => e.r.x[X.volat12], -1) });
    add(S('29 변동성'), '12개월 변동성 큰 순(대조)', { cand: sortBy(mBase, e => e.r.x[X.volat12], 1) });
    const capEst = e => { const cap = CAP.get(e.r.y), o = o0(e), cl = o.m.get(j0(e)); return cap > 0 && cl > 0 && o.lastC > 0 ? cap * cl / o.lastC : null; };
    add(S('30 시총'), '그 시점 시총 큰 순(추정)', { cand: sortBy(mBase, capEst, 1) });
    add(S('30 시총'), '그 시점 시총 작은 순(추정)', { cand: sortBy(mBase, capEst, -1) });
    add(S('31 확인까지 걸린 기간'), '확인까지 짧게 걸린 순', { cand: sortBy(mBase, e => e.wait, -1) });
    add(S('31 확인까지 걸린 기간'), '확인까지 오래 걸린 순', { cand: sortBy(mBase, e => e.wait, 1) });
    add(S('32 10이평에 가까운 순'), '확인 달 종가가 10이평에 가까운 순', { cand: sortBy(mBase, e => { const o = o0(e), j = j0(e), ma = maAtN(o, j, 10), cl = o.m.get(j); return ma && cl ? Math.abs(cl / ma - 1) : null; }, -1) });
    add(S('33 52주 고점'), '12개월 고점에 가까운 순', { cand: sortBy(mBase, e => { const o = o0(e), j = j0(e); let h = 0; for (let i = j - 11; i <= j; i++) { const v = o.hi.get(i) || o.m.get(i); if (v > h) h = v; } const cl = o.m.get(j); return h && cl ? cl / h : null; }, 1) });
    add(S('34 거래대금 증가'), '확인 달 거래대금이 평소보다 많이 늘어난 순', { cand: sortBy(mBase, e => { const o = o0(e), j = j0(e), t = turnAt(o, j), a = avgTurn(o, j, 12); return t && a ? t / a : null; }, 1) });
    add(S('37 정배열 간격'), '5이평÷20이평 간격이 큰 순', { cand: sortBy(mBase, e => { const o = o0(e), j = j0(e), a = maAtN(o, j, 5), d = maAtN(o, j, 20); return a && d ? a / d - 1 : null; }, 1) });
    add(S('35 점수+모멘텀 섞기'), '점수 순위와 12개월 모멘텀 순위의 평균', { cand: wrap(mBase, a => {
      const rk = f => { const r = new Map(), s = [...a].sort((x, y) => (f(y) ?? -1e18) - (f(x) ?? -1e18)); s.forEach((e, i) => r.set(e, i)); return r; };
      const r1 = rk(e => e.s), r2 = rk(mom(12));
      return [...a].sort((x, y) => (r1.get(x) + r2.get(x)) - (r1.get(y) + r2.get(y))); }) });
    { const allS = []; mBase.forEach(a => a.forEach(e => allS.push(e.s)));
      [['0점(예상 수익 0) 이상', 0], ['하위 25% 제외', pctl(allS, 0.25)], ['상위 50%만', pctl(allS, 0.5)], ['상위 25%만', pctl(allS, 0.75)]].forEach(([nm, th]) =>
        add(S('36 점수 문턱'), `점수 ${nm}만 사고 나머지는 현금`, { cand: wrap(mBase, a => a.filter(e => e.s >= th)) })); }
  }

  const trainFiltered = (pred, hz) => Y => {                                  // data.js trainSet과 같은 시점 규칙(Y년 1월 1일에 알던 정답만). hz: 정답을 hz개월 뒤 수익으로 고정
    const cut = (Y - 1) * 12 + 12, out = [];
    for (const r of ALL) {
      const e = cut - (Math.floor(r.ym / 100) * 12 + r.ym % 100); if (e < 1) continue;
      if (pred && !pred(r, cut)) continue;
      let t = null;
      if (hz) { const q = MK.indexOf(hz); if (e >= hz && r.mk[q] !== null) t = r.mk[q]; }
      else if (r.exoff !== null && r.exoff <= e) t = r.t;
      else if (e >= 12) { for (let q = MK.length - 1; q >= 0; q--) if (MK[q] <= e && r.mk[q] !== null) { t = r.mk[q]; break; } }
      if (t !== null) out.push({ ym: r.ym, x: r.x, t });
    }
    return out;
  };

  // ═════ 묶음 3: 점수 모델 (학습 방식 바꾸기) — 해마다 그 전까지 알던 것만으로 다시 학습
  if (on(3)) {
    const S = n => `3-${n}`;
    const alt = (name, opts, ck) => {
      const m2 = rescore(opts), old = scored[kA]; scored[kA] = m2;
      let pm; try { pm = mk({ ck }); } finally { scored[kA] = old; }
      add(S('모델'), name, { cand: candOf(pm) });
    };
    [5, 3].forEach(y => alt(`38 최근 ${y}년 신호에 가중치 2배로 학습`, { recentDup: y }, 'rd' + y));
    [6, 12, 24].forEach(h => alt(`39 정답을 ${h}개월 뒤 수익으로 고정해 학습`, { trainFn: trainFiltered(null, h) }, 'hz' + h));
    [10, 15].forEach(n => alt(`40 기여가 큰 지표 ${n}개만 쓰기`, { topCols: n }, 'tc' + n));
    { const candKey = new Map(); mBase.forEach(a => a.forEach(e => candKey.set(e.r.y + '|' + e.sym, e.cj)));
      alt('43 확인 매수 후보가 된 신호만으로 학습', { trainFn: trainFiltered((r, cut) => { const cj = candKey.get(r.y + '|' + r.ym); return cj !== undefined && cj <= cut; }) }, 'cd'); }
  }

  // ═════ 묶음 4: 비중·구성
  if (on(4)) {
    const S = n => `4-${n}`, cm = candOf(mBase);
    add(S('44 변동성 낮은 종목에 더'), '비중 ∝ 1/변동성(12개월)', { cand: cm, o: { wFn: r => 1 / Math.max(0.03, r.x[X.volat12] || 0.1) } });
    add(S('44 변동성 낮은 종목에 더'), '비중 ∝ 1/√변동성', { cand: cm, o: { wFn: r => 1 / Math.sqrt(Math.max(0.03, r.x[X.volat12] || 0.1)) } });
    add(S('45 분할 매수'), '첫 달 절반, 산 달 말에도 10이평 위면 나머지 절반', { cand: cm, o: { firstFrac: 0.5 } });
    [[2, 6], [3, 5], [2, 8], [4, 8]].forEach(([a, b]) => add(S('46 후보 수에 따라 종목 수'), `후보 수대로 ${a}~${b}종목`, { cand: cm, o: { nFn: (ym, list) => Math.max(a, Math.min(b, list.length)) } }));
    [0.15, 0.2, 0.3].forEach(cap => add(S('47 한 종목 비중 한도'), `한 종목이 전체 자산의 ${cap * 100}%를 넘으면 넘는 만큼 판매(매월)`, { cand: cm, o: { trim: { months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], cap } } }));
    add(S('48 리밸런싱'), '12월 말마다 보유 평균보다 큰 종목을 평균으로 줄임', { cand: cm, o: { trim: { months: [12], over: 0 } } });
    add(S('48 리밸런싱'), '분기 말마다 보유 평균의 1.5배를 넘으면 줄임', { cand: cm, o: { trim: { months: [3, 6, 9, 12], over: 0.5 } } });
    add(S('50 시장 비중 한도'), '한 시장이 보유의 80%를 넘으면 그 시장 신규 매수 쉼', { cand: cm, o: { mktCap: 0.8 } });
    add(S('50 시장 비중 한도'), '한 시장이 보유의 65%를 넘으면 그 시장 신규 매수 쉼', { cand: cm, o: { mktCap: 0.65 } });
  }

  // ═════ 묶음 5: 매도
  if (on(5)) {
    const S = n => `5-${n}`, cm = candOf(mBase);
    const R = (extra, nm) => ({ ...rule10, ...extra, rateName: nm || rule10.rateName });
    // (정정) 예전 "이탈 즉시" 시험은 유예 0 = 10이평 이탈 때 안 파는 상태였을 수 있어 유예 1달 = 즉시로 다시 넣음
    [[1, true, '이탈 즉시'], [1, false, '이탈 즉시(금리 판단 없음)'], [2, false, '유예 2달(금리 판단 없음)'], [3, true, '유예 3달+금리'], [4, true, '유예 4달+금리']].forEach(([g, rt, nm]) => {
      const rule = { tp: 2, grace: g, rate: rt, ...(rt ? { rateFn: chg('dgs10', 6) } : {}), rateName: rt ? '국채10년 6개월' : '금리 없음' };
      addPool(S('00 유예 달 수(정정 재시험)'), `익절 2배 · ${nm}`, { ck: 'g' + g + rt }, {}, rule);
    });
    [[6, 0], [12, 0], [12, 0.1], [24, 0.1], [24, 0.3]].forEach(([T, th]) => add(S('51 시간 손절'), `${T}개월이 지나도 수익이 ${th * 100}% 미만이면 판매`, { cand: cm, o: { exitFn: (h, k) => ((k - h.buyK >= T && h.last / h.buyPx - 1 < th) ? 'time' : null) } }));
    [24, 36, 60].forEach(T => add(S('52 최대 보유 기간'), `최대 ${T}개월 보유`, { cand: cm, o: { exitFn: (h, k) => (k - h.buyK >= T ? 'maxhold' : null) } }));
    [0.2, 0.3, 0.4].forEach(x => add(S('53 고점 대비 하락'), `보유 중 고점(월말 종가)에서 −${x * 100}%면 판매`, { cand: cm, o: { exitFn: h => (h.last <= h.peak * (1 - x) ? 'ddstop' : null) } }));
    [2, 3].forEach(X0 => add(S('54 부분 익절'), `${X0}배 도달 때 절반 판매, 나머지는 트레일`, { cand: cm, o: { exitFn: (h, k, cx) => { const ma = ma10(h.px, k); if (!h.half && ma && h.last >= X0 * ma) { h.half = true; cx.part(0.5, 'tp-half'); } return null; } } }));
    [20, 5].forEach(n => addPool(S('55 판매 기준 이평'), `진입은 10이평, 판매 기준은 ${n}이평`, { ck: 'ex' + n }, { o: { exitMaN: n } }, R({ exitMaN: n }, '국채10년 6개월')));
    [0.03, 0.05, 0.1].forEach(b => addPool(S('56 이탈 완충'), `10이평 × ${(1 - b).toFixed(2)} 아래로 내려와야 이탈로 봄`, { ck: 'bf' + b }, { o: { exitBuf: b } }, R({ exitBuf: b }, '국채10년 6개월')));
    [1, 0.5].forEach(th => add(S('57 이긴 종목은 20이평'), `수익 +${th * 100}% 넘은 종목은 판매 기준을 20이평으로`, { cand: cm, o: { exitMaFn: (h, k) => (h.last / h.buyPx - 1 >= th ? maAtN(h.px, k, 20) : ma10(h.px, k)) } }));
    add(S('58 이익·손실 따라 유예'), '손실 중인 종목은 유예 없이 즉시 판매', { cand: cm, o: { graceN2: h => (h.last < h.buyPx ? 1 : undefined) } });
    add(S('58 이익·손실 따라 유예'), '이익 중인 종목은 유예 없이 즉시 판매', { cand: cm, o: { graceN2: h => (h.last >= h.buyPx ? 1 : undefined) } });
    add(S('59 2배 뒤 5이평'), '2배 도달 뒤에는 5이평 이탈 때 판매', { cand: cm, o: { exitFn: (h, k) => { if (!h.t2x) { const ma = ma10(h.px, k); if (ma && h.last >= 2 * ma) h.t2x = true; } if (h.t2x) { const m5 = maAtN(h.px, k, 5); if (m5 && h.last < m5) return 'tp5'; } return null; } } });
    { const macro = {
        'VIX 25 이상': k => { const v = num(mc(ymOf(k)).vix); return v == null ? null : v >= 25; },
        'VIX 30 이상': k => { const v = num(mc(ymOf(k)).vix); return v == null ? null : v >= 30; },
        '하이일드 스프레드 6개월 전보다 큼': k => { const a = num(mc(ymOf(k)).hy), b = num(mc(ymOf(k - 6)).hy); return a == null || b == null ? null : a > b; },
        '달러 강세(12개월 변화 > 0)': k => { const v = num(mc(ymOf(k)).usd_chg12); return v == null ? null : v > 0; },
        '장단기 금리차 역전': k => { const v = num(mc(ymOf(k)).t10y2y); return v == null ? null : v < 0; } };
      Object.entries(macro).forEach(([nm, fn]) => {
        addPool(S('60 금리 대신 다른 신호'), `국채금리 대신 [${nm}]이면 즉시 판매`, { ck: 'mr' + nm }, {}, { tp: 2, grace: 2, rate: true, rateFn: fn, rateName: '대체:' + nm });
        const un = k => { const a = rateJ(k), b = fn(k); return (a === true || b === true) ? true : (a == null && b == null ? null : false); };
        addPool(S('60 금리 대신 다른 신호'), `국채금리 또는 [${nm}]이면 즉시 판매`, { ck: 'mu' + nm }, {}, { tp: 2, grace: 2, rate: true, rateFn: un, rateName: '합침:' + nm });
      }); }
    add(S('61 지수가 약할 때'), '그 시장 지수가 10이평 아래면 유예 없이 즉시 판매', { cand: cm, o: { graceN2: (h, k) => (idxBelow(isKR(h.y) ? 'ks' : 'sp', k) === true ? 1 : undefined) } });
    [6, 12].forEach(n => add(S('62 재매수 금지'), `판 뒤 ${n}개월은 같은 종목 재매수 금지`, { cand: cm, o: { banMonths: n } }));
    addPool(S('63 재매수 허용'), '팔린 뒤 조건을 다시 채우면 같은 돌파 종목도 다시 삼', { ck: 'rb', rebuy: true });
    add(S('64 세금 늦추기'), '12월 말 판매될 미국 이익 종목은 1월로 미룸', { cand: cm, o: { taxDefer: true } });
  }

  // ═════ 묶음 6: 자금·비용·세금
  if (on(6)) {
    const S = n => `6-${n}`, cm = candOf(mBase);
    const Cx = f => { const x = JSON.parse(JSON.stringify(C1)); f(x); return x; };
    [100000, 500000, 3000000, 10000000].forEach(d => add(S('65 월 입금액'), `월 불입금 ${d / 10000}만원(정수 주 영향)`, { cand: cm, dep: d }));
    [1e8, 1e9].forEach(L => add(S('66 거치식'), `첫 달 ${L / 1e8}억원 한 번에, 추가 입금 없음`, { cand: cm, dep: 0, o: { lump: L } }));
    [3, 6].forEach(n => add(S('67 입금 주기'), `${n}개월마다 ${n}배 입금`, { cand: cm, o: { depEvery: n } }));
    add(S('68 남는 현금 굴리기'), '남는 현금을 S&P500(원화 환산)에 넣어 둠', { cand: cm, o: { cashRetFn: k => { const a = idxAt('sp', k), b = idxAt('sp', k - 1); return a && b ? (a * fx(k)) / (b * fx(k - 1)) - 1 : 0; } } });
    add(S('68 남는 현금 굴리기'), '남는 현금을 코스피에 넣어 둠', { cand: cm, o: { cashRetFn: k => { const a = idxAt('ks', k), b = idxAt('ks', k - 1); return a && b ? a / b - 1 : 0; } } });
    [0.1, 0.2].forEach(x => add(S('69 현금 유지'), `항상 현금 ${x * 100}% 남기고 삼`, { cand: cm, o: { cashKeep: x } }));
    [2, 3, 5, 10].forEach(m => add(S('70 비용 배수'), `수수료·환전 비용 ${m}배`, { cand: cm, C: Cx(x => { x.us.commission *= m; x.us.fx_spread *= m; x.kr.commission *= m; }) }));
    add(S('71 환율 효과'), '환율을 시작 시점으로 고정(달러 기준 성과에 가까움)', { cand: cm, o: { fxFlat: true } });
    add(S('72 금투세 가정'), '국내 주식 이익에도 22%(공제 5천만원)', { cand: cm, o: { krGainTax: { rate: 0.22, exempt: 50000000 } } });
    add(S('72 금투세 가정'), '국내 주식 이익에도 22%(공제 250만원)', { cand: cm, o: { krGainTax: { rate: 0.22, exempt: 2500000 } } });
    add(S('72 금투세 가정'), '국내 주식 이익에도 22%(공제 없음)', { cand: cm, o: { krGainTax: { rate: 0.22, exempt: 0 } } });
    add(S('73 양도세 공제'), '미국 양도세 공제 500만원(부부 분산)', { cand: cm, C: Cx(x => { x.us.cg_exemption_krw = 5000000; }) });
    add(S('73 양도세 공제'), '미국 양도세 공제 750만원(3인 분산)', { cand: cm, C: Cx(x => { x.us.cg_exemption_krw = 7500000; }) });
    const dv = { divFn: divOf, divTaxUS: 0.15, divTaxKR: 0.154, divSkipBuy: true };
    add(S('74 배당 포함 재확인'), '지금 규칙 + 배당(세후)', { cand: cm, o: dv });
    [[0, 2], [3, 2], [2, 1], [2, 3]].forEach(([tp, g]) => { const rule = { tp, grace: g, rate: true, rateFn: chg('dgs10', 6), rateName: '국채10년 6개월' };
      addPool(S('74 배당 포함 재확인'), `배당(세후) + 익절 ${tp ? tp + '배' : '없음'} · 유예 ${g}달`, { ck: 'dv' + tp + g }, { o: dv }, rule); });
  }

  // ═════ 묶음 7: 체결·시점
  if (on(7)) {
    const S = n => `7-${n}`, cm = candOf(mBase);
    add(S('75 첫날 시가'), '구매를 첫날 종가 대신 시가에', { cand: cm, o: { fdOpen: true } });
    add(S('76 판매 시점'), '판매를 다음 달 첫날 종가에(월말 대신)', { cand: cm, o: { sellDelay: 1, sellFd: true } });
    add(S('78 판매 시점'), '판매를 한 달 늦게(다음 달 말)', { cand: cm, o: { sellDelay: 1 } });
    [1, 2].forEach(n => add(S('77 구매 시점'), `구매를 ${n}달 늦게(신호가 얼마나 오래 유효한가)`, { cand: cm, o: { buyDelay: n } }));
    [0.05, 0.1].forEach(p => [1, 2].forEach(sd => add(S('82 주문 실패'), `확률 ${p * 100}%로 주문 실패 → 다음 순위(무작위 ${sd})`, { cand: cm, o: { failP: p, failSeed: sd } })));
    [[1 / 12, '1/12'], [1 / 6, '1/6']].forEach(([p, nm]) => [1, 2].forEach(sd => add(S('83 한 달 놓침'), `무작위 ${nm}의 달에 구매를 통째로 건너뜀(무작위 ${sd})`, { cand: cm, o: { buyBlock: k => hash01('sk|' + k + '|' + sd) < p } })));
  }

  // ═════ 묶음 8: 종목 범위
  if (on(8)) {
    const S = n => `8-${n}`;
    const nameOf = r => CO_NAME.get(r.y) || '';
    const allT = []; byYm.forEach(a => a.forEach(x => { const t = x.r.x[TURN]; if (Number.isFinite(t)) allT.push(t); }));
    [[0.1, 10], [0.25, 25], [0.5, 50], [0.75, 75]].forEach(([p, lab]) => { const th = pctl(allT, p); add(S('84 91 유동성·범위 크기'), `거래대금(turn) 하위 ${lab}% 제외 = 더 좁은(큰) 종목군`, { cand: wrap(mBase, a => a.filter(e => !(e.r.x[TURN] < th))) }); });
    { const t1 = pctl(allT, 1 / 3), t2 = pctl(allT, 2 / 3);
      add(S('92 규모별'), '거래대금 하위 1/3 종목만(소형에 가까움)', { cand: wrap(mBase, a => a.filter(e => e.r.x[TURN] < t1)) });
      add(S('92 규모별'), '거래대금 중간 1/3 종목만', { cand: wrap(mBase, a => a.filter(e => e.r.x[TURN] >= t1 && e.r.x[TURN] < t2)) });
      add(S('92 규모별'), '거래대금 상위 1/3 종목만(대형에 가까움)', { cand: wrap(mBase, a => a.filter(e => e.r.x[TURN] >= t2)) }); }
    add(S('85 시장'), '코스닥 제외(코스피+미국)', { cand: wrap(mBase, a => a.filter(e => !/\.KQ$/.test(e.r.y))) });
    add(S('85 시장'), '코스피만(미국·코스닥 제외)', { cand: wrap(mBase, a => a.filter(e => /\.KS$/.test(e.r.y))) });
    add(S('85 시장'), '코스닥만', { cand: wrap(mBase, a => a.filter(e => /\.KQ$/.test(e.r.y))) });
    add(S('85 시장'), '미국만', { cand: wrap(mBase, a => a.filter(e => !isKR(e.r.y))) });
    add(S('87 우선주'), '우선주 제외', { cand: wrap(mBase, a => a.filter(e => !(isKR(e.r.y) ? /(우|우B|우C|2우B|3우B)$/.test(nameOf(e.r)) : /Preferred|Pfd/i.test(nameOf(e.r))))) });
    add(S('88 ADR'), 'ADR(미국 상장 외국 기업) 제외', { cand: wrap(mBase, a => a.filter(e => !/ADR|ADS/.test(nameOf(e.r)))) });
    add(S('89 비싼 주식'), '1주 가격이 100만원 이상인 종목 제외', { cand: candOf(mBase), o: { skipFn: (r, o, p, k) => p * (r.x[US] === 1 ? fx(k) : 1) >= 1e6 } });
    [36, 60].forEach(L => add(S('90 상장 기간'), `월봉이 ${L}개월 이상 있는 종목만`, { cand: candOf(mBase), o: { skipFn: (r, o, p, k) => !o.m.has(k - L) } }));
  }

  // ═════ 묶음 9: 검증 (규칙은 그대로, 결과를 믿어도 되는지)
  if (on(9)) {
    const S = n => `9-${n}`, cm = candOf(mBase);
    [0.01, 0.02, 0.05].forEach(p => [1, 2].forEach(sd => add(S('93 생존 편향 가정'), `거래의 ${p * 100}%가 36개월 안에 상장폐지(가치 0)된다고 가정(무작위 ${sd})`, { cand: cm, o: { delistP: p, delistSeed: sd } })));
    posts.push(() => post9());
  }

  // ═════ 묶음 10: 다른 전략과 비교
  if (on(10)) {
    const S = n => `10-${n}`, U = { members: k => universe().members(k) };           // 범위 목록은 처음 쓸 때 읽음(약 10~30초)
    const mkX = s => { const x = new Array(F.length).fill(0); x[US] = s.grp === 'US' ? 1 : 0; x[ETF] = s.etf ? 1 : 0; x[TURN] = 8; return x; };
    const memCache = new Map(), members = k => { if (!memCache.has(k)) memCache.set(k, U.members(k)); return memCache.get(k); };
    const momCand = (n, keep) => ym => {                                          // ym(YYYYMM) 월말 기준: 그달 시총 상위 범위 안 종목을 n개월 수익률 큰 순으로
      const k = mi(ym), out = [];
      for (const s of members(k)) {
        const a = s.cl.get(k), b = s.cl.get(k - n); if (!(a > 0 && b > 0)) continue;
        const r = a / b - 1; if (keep && !keep(s, r, k)) continue;
        out.push({ r: { y: s.y, ym, exoff: null, x: mkX(s) }, s: r });
      }
      out.sort((x, y) => y.s - x.s); return out.slice(0, 40);
    };
    const oneMonth = { exitFn: () => 'rebal' };
    add(S('105 단순 모멘텀'), '매달 12개월 수익률 상위 4, 한 달 보유 후 다시 고름', { cand: momCand(12), rule: {}, o: oneMonth });
    add(S('105 단순 모멘텀'), '매달 6개월 수익률 상위 4, 한 달 보유', { cand: momCand(6), rule: {}, o: oneMonth });
    add(S('106 듀얼 모멘텀'), '12개월 수익률이 0 넘고 그 시장 지수도 12개월 플러스인 종목 중 상위 4, 한 달 보유', { cand: momCand(12, (s, r, k) => { if (!(r > 0)) return false; const key = s.grp === 'US' ? 'sp' : 'ks', a = idxAt(key, k), b = idxAt(key, k - 12); return !!(a && b && a > b); }), rule: {}, o: oneMonth });
    posts.push(() => post10(U, members));
  }

  // ═════ 묶음 11: 조합·일관성 점검 — 묶음 1~10에서 앞·뒤·낙폭이 같이 좋아 보인 것들을 합쳐 보고, 해마다 이겼는지(15년 중 몇 해) 확인
  if (on(11)) {
    const S = n => `11-${n}`;
    const up2 = ({ o, j }) => o.m.get(j) > o.m.get(j - 1);
    const ruleMa5 = { ...rule10, exitMaN: 5 };
    const dd20 = { exitFn: h => (h.last <= h.peak * 0.8 ? 'ddstop' : null) };
    const spCash = { cashRetFn: k => { const a = idxAt('sp', k), b = idxAt('sp', k - 1); return a && b ? (a * fx(k)) / (b * fx(k - 1)) - 1 : 0; } };
    const nUp = { nFn: ym => (rateJ(mi(ym)) === true ? 2 : 4) };
    const mUp = mk({ ck: 'c_up2', cond: up2 }), mUp5 = mk({ ck: 'c_up2m5', cond: up2 }, ruleMa5), mM5 = mk({ ck: 'c_m5' }, ruleMa5);
    add(S('단독'), '단독 ① 확인 때까지 2개월 연속 상승', { cand: candOf(mUp) });
    add(S('단독'), '단독 ② 보유 중 고점에서 −20%면 판매', { cand: candOf(mBase), o: dd20 });
    add(S('단독'), '단독 ③ 판매 기준을 5이평으로', { cand: candOf(mM5), rule: ruleMa5, o: { exitMaN: 5 } });
    add(S('단독'), '단독 ④ 국채금리 오르는 중이면 2종목만', { cand: candOf(mBase), o: nUp });
    add(S('단독'), '단독 ⑤ 남는 현금을 S&P500에(운용 방식)', { cand: candOf(mBase), o: spCash });
    add(S('단독'), '단독 ⑥ 윗꼬리 20% 초과 돌파 제외', { cand: candOf(mk({ ck: 'uw0.2', sig: r => !(r.x[X.upwick] > 0.2) })) });
    add(S('조합'), '①+② 연속 상승 + 고점 −20% 판매', { cand: candOf(mUp), o: dd20 });
    add(S('조합'), '①+③ 연속 상승 + 5이평 판매', { cand: candOf(mUp5), rule: ruleMa5, o: { exitMaN: 5 } });
    add(S('조합'), '①+④ 연속 상승 + 금리 오르면 2종목', { cand: candOf(mUp), o: nUp });
    add(S('조합'), '①+②+③ 연속 상승 + 고점 −20% + 5이평', { cand: candOf(mUp5), rule: ruleMa5, o: { ...dd20, exitMaN: 5 } });
    add(S('조합'), '①+② + 남는 현금 S&P500', { cand: candOf(mUp), o: { ...dd20, ...spCash } });
    add(S('조합'), '①+⑥ 연속 상승 + 윗꼬리 20% 제외', { cand: candOf(mk({ ck: 'c_up2uw', cond: up2, sig: r => !(r.x[X.upwick] > 0.2) })) });
    add(S('조합'), '①+②+④ 연속 상승 + 고점 −20% + 금리 오르면 2종목', { cand: candOf(mUp), o: { ...dd20, ...nUp } });
    posts.push(() => post11());
  }

  // ═════ 묶음 12: 판매 기준 이평 파고들기 — PC 결과에서 "판매 기준을 5이평으로"(③)가 크게 좋아져서 길이·유예·익절·비용·거래 횟수·해마다 일관성을 같이 봄
  if (on(12)) {
    const S = n => `12-${n}`;
    const Cx = f => { const x = JSON.parse(JSON.stringify(C1)); f(x); return x; };
    const dd20 = { exitFn: h => (h.last <= h.peak * 0.8 ? 'ddstop' : null) };
    const spCash = { cashRetFn: k => { const a = idxAt('sp', k), b = idxAt('sp', k - 1); return a && b ? (a * fx(k)) / (b * fx(k - 1)) - 1 : 0; } };
    const up2 = ({ o, j }) => o.m.get(j) > o.m.get(j - 1);
    // 판매 기준 이평 N · 유예 g달 · 금리 판단 rt · 익절 tp(0=없음) · 이탈 완충 buf — 후보 풀의 가상 포지션도 같은 규칙(rule)으로 팔리게 함
    const mkRule = (N, g, rt, tp, buf) => ({ tp, grace: g, rate: rt, ...(rt ? { rateFn: chg('dgs10', 6) } : {}), rateName: rt ? '국채10년 6개월' : '금리 없음', exitMaN: N, ...(buf ? { exitBuf: buf } : {}) });
    const addM = (sec, name, N, g, rt, tp, buf, extra = {}, q = {}) => {
      const rule = mkRule(N, g, rt, tp, buf), o = { exitMaN: N, ...(buf ? { exitBuf: buf } : {}), ...(extra.o || {}) };
      const m = mk({ ck: `m${N}g${g}r${rt ? 1 : 0}t${tp}b${buf || 0}${q.ck || ''}`, ...q }, rule);
      add(S(sec), name, { cand: candOf(m), rule, ...extra, o });
    };
    [3, 4, 5, 6, 7, 8, 9, 12, 15].forEach(N => addM('A 판매 기준 이평 길이(유예 2달+금리, 익절 2배)', `판매 기준 ${N}이평`, N, 2, true, 2));
    [[1, '즉시'], [2, '유예 2달(지금)'], [3, '유예 3달'], [4, '유예 4달']].forEach(([g, nm]) => addM('B 5이평 × 유예', `5이평 · ${nm}+금리`, 5, g, true, 2));
    addM('B 5이평 × 유예', '5이평 · 유예 2달(금리 판단 없음)', 5, 2, false, 2);
    [[0, '익절 없음'], [3, '익절 3배']].forEach(([tp, nm]) => addM('C 5이평 × 익절', `5이평 · 유예 2달+금리 · ${nm}`, 5, 2, true, tp));
    [2, 3, 5].forEach(m => addM('D 5이평 × 비용', `5이평 · 수수료·환전 ${m}배`, 5, 2, true, 2, 0, { C: Cx(x => { x.us.commission *= m; x.us.fx_spread *= m; x.kr.commission *= m; }) }));
    addM('E 5이평 × 이탈 완충', '5이평 × 0.97 아래로 내려와야 이탈', 5, 2, true, 2, 0.03);
    addM('F 5이평 × 다른 변경', '5이평 + 보유 고점 −20% 판매', 5, 2, true, 2, 0, { o: dd20 });
    addM('F 5이평 × 다른 변경', '5이평 + 남는 현금 S&P500', 5, 2, true, 2, 0, { o: spCash });
    addM('F 5이평 × 다른 변경', '5이평 + 확인 때까지 2개월 연속 상승(①)', 5, 2, true, 2, 0, {}, { cond: up2, ck: 'u2' });
    addM('F 5이평 × 다른 변경', '5이평 + ①+고점 −20% + 남는 현금 S&P500', 5, 2, true, 2, 0, { o: { ...dd20, ...spCash } }, { cond: up2, ck: 'u2' });
    // 이익 난 종목만 5이평으로(손실 종목은 10이평) / 손실 종목만 5이평으로 — 어디서 이득이 나는지
    { const rule = mkRule(10, 2, true, 2);
      add(S('G 5이평을 쓰는 종목'), '이익 난 종목만 5이평 판매(손실 종목은 10이평)', { cand: candOf(mBase), rule, o: { exitMaFn: (h, k) => (h.last >= h.buyPx ? maAtN(h.px, k, 5) : ma10(h.px, k)) } });
      add(S('G 5이평을 쓰는 종목'), '손실 난 종목만 5이평 판매(이익 종목은 10이평)', { cand: candOf(mBase), rule, o: { exitMaFn: (h, k) => (h.last < h.buyPx ? maAtN(h.px, k, 5) : ma10(h.px, k)) } });
      add(S('G 5이평을 쓰는 종목'), '미국 종목만 5이평 판매(한국은 10이평)', { cand: candOf(mBase), rule, o: { exitMaFn: (h, k) => (!isKR(h.y) ? maAtN(h.px, k, 5) : ma10(h.px, k)) } });
      add(S('G 5이평을 쓰는 종목'), '한국 종목만 5이평 판매(미국은 10이평)', { cand: candOf(mBase), rule, o: { exitMaFn: (h, k) => (isKR(h.y) ? maAtN(h.px, k, 5) : ma10(h.px, k)) } }); }
    posts.push(() => post12());
  }


  // ═════ 묶음 13: 판매 규칙 2 — 5이평(③)을 여러 방향에서 흔들어 봄: 시장별 길이·두 이평 조합·금리 기간·익절·종목 수·문턱·재매수·손절·현금 굴리기·순위·타이밍·시장·무작위 순위
  if (on(13)) {
    const S = n => `13-${n}`;
    const Cx = f => { const x = JSON.parse(JSON.stringify(C1)); f(x); return x; };
    const dd = p => ({ exitFn: h => (h.last <= h.peak * (1 - p) ? 'ddstop' : null) });
    const cashIdx = (key, w = 1) => ({ cashRetFn: k => { const a = idxAt(key, k), b = idxAt(key, k - 1); return a && b ? (a * (key === 'sp' || key === 'nq' ? fx(k) : 1)) / (b * (key === 'sp' || key === 'nq' ? fx(k - 1) : 1)) - 1 : 0; } });
    const cashMix = { cashRetFn: k => { const f = key => { const a = idxAt(key, k), b = idxAt(key, k - 1); return a && b ? (a * (key === 'sp' ? fx(k) : 1)) / (b * (key === 'sp' ? fx(k - 1) : 1)) - 1 : 0; }; return (f('sp') + f('ks')) / 2; } };
    const mkRule = (N, g, rt, tp, buf, months) => ({ tp, grace: g, rate: rt, ...(rt ? { rateFn: chg('dgs10', months || 6) } : {}), rateName: rt ? `국채10년 ${months || 6}개월` : '금리 없음', exitMaN: N, ...(buf ? { exitBuf: buf } : {}) });
    const cache = {};
    const PL = (key, rule, q = {}) => (cache[key] = cache[key] || mk({ ck: key, ...q }, rule));
    const r5 = mkRule(5, 2, true, 2);
    const m5 = PL('x5', r5);                                                  // 5이평으로 팔리는 가상 포지션을 쓰는 후보 풀
    const A = (sec, name, cand, rule, o = {}, extra = {}) => add(S(sec), name, { cand, rule, o, ...extra });
    const R5 = (sec, name, o = {}, extra = {}) => A(sec, name, candOf(m5), r5, { exitMaN: 5, ...o }, extra);      // 5이평 기준에 o만 바꿈
    const R10 = (sec, name, o = {}, extra = {}) => A(sec, name, candOf(mBase), rule10, o, extra);                  // 지금(10이평) 기준에 o만 바꿈
    const U = (sec, name, krN, usN, poolRule) => A(sec, name, candOf(poolRule ? m5 : mBase), poolRule ? r5 : rule10, { exitMaFn: (h, k) => maAtN(h.px, k, isKR(h.y) ? krN : usN) });
    R5('기준', '5이평 · 12묶음과 같은 규칙(재현 확인)');
    // A 시장별 길이: 한국 n이평 × 미국 n이평(후보 풀은 지금 10이평 가상 포지션, 12묶음 G와 같은 방식)
    [4, 5, 6, 7].forEach(kr => [10, 7, 5].forEach(us => { if (!(kr === 5 && us === 10)) U('A 시장별 이평 길이', `한국 ${kr}이평 · 미국 ${us}이평`, kr, us); }));
    U('A 시장별 이평 길이', '한국 5이평 · 미국 10이평(후보 풀도 5이평 가상 포지션)', 5, 10, true);
    // B 두 이평 조합: 둘 다 아래여야 이탈(min) / 하나만 아래여도 이탈(max) / 평균
    [[5, 10], [5, 20], [7, 15], [3, 10]].forEach(([a, b]) => {
      A('B 두 이평 조합', `${a}이평·${b}이평 둘 다 아래여야 이탈`, candOf(mBase), rule10, { exitMaFn: (h, k) => Math.min(maAtN(h.px, k, a), maAtN(h.px, k, b)) });
      A('B 두 이평 조합', `${a}이평·${b}이평 하나라도 아래면 이탈`, candOf(mBase), rule10, { exitMaFn: (h, k) => Math.max(maAtN(h.px, k, a), maAtN(h.px, k, b)) });
    });
    [[5, 10], [5, 20]].forEach(([a, b]) => A('B 두 이평 조합', `판매 기준 = ${a}이평·${b}이평의 평균`, candOf(mBase), rule10, { exitMaFn: (h, k) => (maAtN(h.px, k, a) + maAtN(h.px, k, b)) / 2 }));
    // C 금리 판단 기간(5이평)
    [3, 9, 12].forEach(mo => { const r = mkRule(5, 2, true, 2, 0, mo), m = PL('x5r' + mo, r); A('C 5이평 × 금리 기간', `5이평 · 국채10년 ${mo}개월 전보다 높으면 즉시`, candOf(m), r, { exitMaN: 5 }); });
    // D 익절 기준(5이평)
    [1.5, 2.5, 4].forEach(tp => { const r = mkRule(5, 2, true, tp), m = PL('x5t' + tp, r); A('D 5이평 × 익절', `5이평 · 익절 ${tp}배`, candOf(m), r, { exitMaN: 5 }); });
    // E 보유 종목 수
    [2, 3, 5, 6, 8].forEach(n => R5('E 5이평 × 종목 수', `5이평 · ${n}종목`, { nFn: () => n }));
    [3, 5, 6, 8].forEach(n => R10('E 5이평 × 종목 수', `10이평(지금) · ${n}종목`, { nFn: () => n }));
    // F 확인 문턱·정배열
    [0.05, 0.15, 0.2].forEach(t => { const m = PL('x5th' + t, r5, { thr: t }); A('F 5이평 × 확인 조건', `5이평 · 확인 문턱 +${t * 100}%`, candOf(m), r5, { exitMaN: 5 }); });
    { const m = PL('x5al0', r5, { alignFn: () => true }); A('F 5이평 × 확인 조건', '5이평 · 정배열 조건 없음', candOf(m), r5, { exitMaN: 5 }); }
    { const m = PL('x5al1', r5, { alignFn: (o, j) => { const a = maAtN(o, j, 5), b = maAtN(o, j, 10); return !!(a && b && a > b); } }); A('F 5이평 × 확인 조건', '5이평 · 정배열 5>10만', candOf(m), r5, { exitMaN: 5 }); }
    // G 재매수
    { const m = PL('x5rb', r5, { rebuy: true }); A('G 5이평 × 재매수', '5이평 · 팔린 뒤 조건 다시 채우면 같은 종목 재매수', candOf(m), r5, { exitMaN: 5 }); }
    { const m = PL('x5rb', r5, { rebuy: true }); A('G 5이평 × 재매수', '5이평 · 재매수 + 남는 현금 S&P500', candOf(m), r5, { exitMaN: 5, ...cashIdx('sp') }); }
    // H 손절(고점 대비)
    [0.15, 0.25, 0.3].forEach(p => R5('H 5이평 × 고점 대비 손절', `5이평 · 보유 고점 −${p * 100}% 판매`, dd(p)));
    // I 남는 현금 굴리기
    [6, 7].forEach(n => { const r = mkRule(n, 2, true, 2), m = PL('x' + n, r); A('I 남는 현금', `${n}이평 + 남는 현금 S&P500`, candOf(m), r, { exitMaN: n, ...cashIdx('sp') }); });
    [[0, '익절 없음'], [3, '익절 3배']].forEach(([tp, nm]) => { const r = mkRule(5, 2, true, tp), m = PL('x5t' + tp, r); A('I 남는 현금', `5이평 + 남는 현금 S&P500 · ${nm}`, candOf(m), r, { exitMaN: 5, ...cashIdx('sp') }); });
    R5('I 남는 현금', '5이평 + 남는 현금 나스닥100', cashIdx('nq'));
    R5('I 남는 현금', '5이평 + 남는 현금 코스피', cashIdx('ks'));
    R5('I 남는 현금', '5이평 + 남는 현금 S&P500·코스피 절반씩', cashMix);
    R5('I 남는 현금', '5이평 + 남는 현금 S&P500 + 고점 −25%', { ...cashIdx('sp'), ...dd(0.25) });
    R10('I 남는 현금', '10이평(지금) + 남는 현금 S&P500', cashIdx('sp'));
    R10('I 남는 현금', '10이평(지금) + 남는 현금 나스닥100', cashIdx('nq'));
    A('I 남는 현금', '한국 5이평(미국 10이평) + 남는 현금 S&P500', candOf(mBase), rule10, { exitMaFn: (h, k) => maAtN(h.px, k, isKR(h.y) ? 5 : 10), ...cashIdx('sp') });
    // J 후보 순위(5이평 풀)
    add(S('J 5이평 × 후보 순위'), '5이평 · 변동성(12개월) 낮은 순', { cand: sortBy(m5, e => -(e.r.x[X.volat12] ?? 9), 1), rule: r5, o: { exitMaN: 5 } });
    add(S('J 5이평 × 후보 순위'), '5이평 · 12개월 상승률 큰 순', { cand: sortBy(m5, e => e.r.x[X.ret12], 1), rule: r5, o: { exitMaN: 5 } });
    add(S('J 5이평 × 후보 순위'), '5이평 · 3개월 상승률 작은 순(눌림)', { cand: sortBy(m5, e => -(e.r.x[X.ret3] ?? 9), 1), rule: r5, o: { exitMaN: 5 } });
    add(S('J 5이평 × 후보 순위'), '5이평 · 점수 낮은 순(대조)', { cand: sortBy(m5, e => -e.s, 1), rule: r5, o: { exitMaN: 5 } });
    // K 타이밍·누락 내성
    R5('K 5이평 × 타이밍', '5이평 · 판매를 다음 달 첫날 종가에', { sellDelay: 1, sellFd: true });
    R5('K 5이평 × 타이밍', '5이평 · 판매를 한 달 늦게', { sellDelay: 1 });
    R5('K 5이평 × 타이밍', '5이평 · 구매를 한 달 늦게', { buyDelay: 1 });
    [1, 2].forEach(sd => { R5('K 5이평 × 달 건너뛰기', `5이평 · 무작위 1/6의 달 구매 건너뜀(${sd})`, { buyBlock: k => hash01('sk|' + k + '|' + sd) < 1 / 6 }); R10('K 5이평 × 달 건너뛰기', `10이평(지금) · 무작위 1/6의 달 구매 건너뜀(${sd})`, { buyBlock: k => hash01('sk|' + k + '|' + sd) < 1 / 6 }); });
    // L 시장·종류
    R5('L 5이평 × 시장', '5이평 · 한국 종목만 거래', { skipFn: r => !isKR(r.y) });
    R5('L 5이평 × 시장', '5이평 · 미국 종목만 거래', { skipFn: r => isKR(r.y) });
    R10('L 5이평 × 시장', '10이평(지금) · 한국 종목만 거래', { skipFn: r => !isKR(r.y) });
    R10('L 5이평 × 시장', '10이평(지금) · 미국 종목만 거래', { skipFn: r => isKR(r.y) });
    R5('L 5이평 × 시장', '5이평 · ETF 제외', { skipFn: r => r.x[ETF] === 1 });
    // M 점수가 5이평에서도 쓸모 있나: 후보 순위를 무작위로(씨앗 5개)
    [1, 2, 3, 4, 5].forEach(sd => { const rnd = m => wrap(m, a => [...a].sort((x, y) => hash01('rk|' + sd + '|' + x.r.y + x.r.ym) - hash01('rk|' + sd + '|' + y.r.y + y.r.ym)));
      add(S('M 무작위 순위'), `5이평 · 후보 순위 무작위(${sd})`, { cand: rnd(m5), rule: r5, o: { exitMaN: 5 } });
      add(S('M 무작위 순위'), `10이평(지금) · 후보 순위 무작위(${sd})`, { cand: rnd(mBase), rule: rule10, o: {} }); });
    posts.push(() => post12('13-', '13 판매 규칙 2'));
  }

  // ═════ 묶음 14: 점수 학습 — 학습 정답(타깃)·벌점을 바꿔 다시 학습한 점수로 5이평·10이평 규칙을 같이 시험(해마다 그 전까지 알던 것만)
  if (on(14)) {
    const S = n => `14-${n}`;
    const r5 = { tp: 2, grace: 2, rate: true, rateFn: chg('dgs10', 6), rateName: '국채10년 6개월', exitMaN: 5 };
    const tf = fn => Y => { const rows = trainFiltered(null)(Y), by = new Map(); rows.forEach(r => { const a = by.get(r.ym) || []; a.push(r); by.set(r.ym, a); });
      const mu = mean(rows.map(r => r.t)), sd = sdOf(rows.map(r => r.t)) || 1, out = [];
      by.forEach(a => { const ts = fn(a); a.forEach((r, i) => out.push({ ...r, t: ts[i] })); });
      const m2 = mean(out.map(r => r.t)), s2 = sdOf(out.map(r => r.t)) || 1; return out.map(r => ({ ...r, t: mu + (r.t - m2) / s2 * sd })); };
    const demean = a => { const m = mean(a.map(r => r.t)); return a.map(r => r.t - m); };
    const rankT = a => { const idx = a.map((r, i) => [r.t, i]).sort((x, y) => x[0] - y[0]), out = new Array(a.length); idx.forEach(([, i], q) => { out[i] = (q + 0.5) / a.length; }); return out; };
    const topQ = a => { const sorted = a.map(r => r.t).sort((x, y) => x - y), th = sorted[Math.floor(sorted.length * 0.75)]; return a.map(r => (r.t >= th ? 1 : 0)); };
    const alt = (name, opts, ck) => {
      const m2 = rescore(opts), old = scored[kA]; scored[kA] = m2;
      let pm, pm5; try { pm = mk({ ck: 'y' + ck }); pm5 = mk({ ck: 'y5' + ck }, r5); } finally { scored[kA] = old; }
      add(S('10이평(지금) 규칙'), name, { cand: candOf(pm) });
      add(S('5이평 규칙'), name, { cand: candOf(pm5), rule: r5, o: { exitMaN: 5 } });
    };
    { const m5b = mk({ ck: 'y5base' }, r5); add(S('5이평 규칙'), '점수 모델 그대로(기준)', { cand: candOf(m5b), rule: r5, o: { exitMaN: 5 } }); }
    alt('정답에서 그달 평균 뺌', { trainFn: tf(demean) }, 'dm');
    alt('정답을 그달 순위(백분위)로 바꿈', { trainFn: tf(rankT) }, 'rk');
    alt('정답을 그달 상위 25% 여부(0/1)로 바꿈', { trainFn: tf(topQ) }, 'tq');
    [0.3, 3].forEach(x => alt(`벌점(λ) ${x}배`, { lamMul: x }, 'lm' + x));
    alt('기여가 큰 지표 12개만', { topCols: 12 }, 'tc12');
    alt('최근 3년 신호 가중 2배', { recentDup: 3 }, 'rd3');
    alt('신호의 절반만 무작위 추출해 학습(씨앗 1)', { subsample: { seed: 'a1', frac: 0.5 } }, 'ss1');
    alt('신호의 절반만 무작위 추출해 학습(씨앗 2)', { subsample: { seed: 'a2', frac: 0.5 } }, 'ss2');
    alt('신호의 절반만 무작위 추출해 학습(씨앗 3)', { subsample: { seed: 'a3', frac: 0.5 } }, 'ss3');
    posts.push(() => post12('14-', '14 점수 학습'));
  }

  // ═════ 묶음 15: 신호 쪽 이평 길이 — 3_build.js를 MA_N=n으로 다시 돌려 만든 events(신호·정답·지표가 n이평 기준)에서 판매 기준 이평을 바꿔 봄. exp.sh가 n마다 events를 다시 만들고 끝나면 원래대로 되돌림
  if (on(15)) {
    const MAN = +process.env.MA_N || 10, S = n => `15-신호 ${MAN}이평`;
    const mkr = N => ({ tp: 2, grace: 2, rate: true, rateFn: chg('dgs10', 6), rateName: '국채10년 6개월', exitMaN: N });
    V[0].name = `A 신호 ${MAN}이평 · 판매도 ${MAN}이평(기준 재계산)`;
    [5, 7, 10, 15].filter(N => N !== MAN).forEach(N => { const r = mkr(N), m = mk({ ck: 'sg' + N }, r); add(S(), `신호 ${MAN}이평 · 판매 ${N}이평`, { cand: candOf(m), rule: r, o: { exitMaN: N } }); });
    [[2, '유예 2달'], [1, '즉시']].forEach(([g, nm]) => { const r = { ...mkr(MAN), grace: g }, m = mk({ ck: 'sgg' + g }, r); add(S(), `신호 ${MAN}이평 · 판매 ${MAN}이평 · ${nm}`, { cand: candOf(m), rule: r, o: { exitMaN: MAN } }); });
    posts.push(() => post12('15-', '15 신호 이평 길이'));
  }


  // ═════ 묶음 16: 일봉 판단 — 보유 중 일 단위로 손절·이평 이탈을 보고 그날 값으로 팔기(data/daily, 2g_daily.js로 받음). 월봉 판단(지금)에 더하거나 대신함.
  //   일봉이 없는 종목·달, 월말 종가와 일봉 종가가 3% 넘게 어긋나는 달(액면·감자 조정 불일치)은 일봉 규칙을 쓰지 않고 월봉 규칙만 씀. 매수 후 첫날(구매일)은 건너뛰고 다음 날부터 봄.
  if (on(16)) {
    const S = n => `16-${n}`;
    const r5 = { tp: 2, grace: 2, rate: true, rateFn: chg('dgs10', 6), rateName: '국채10년 6개월', exitMaN: 5 };
    const m5 = mk({ ck: 'd5' }, r5);
    let miss = 0, used = 0;
    // 규칙: stopPeak(고점 종가 대비 하락률, 종가 기준·그날 종가에 판매) · stopLow(고점 종가 대비 저가 하락률, 손절가에 판매·종가가 더 낮으면 종가) · stopBuy(매수가 대비 하락률, 종가) · ma(일봉 N일 이평 아래 종가가 days일 연속이면 그날 종가에 판매)
    //       · armUp/armStop(매수가의 armUp배를 넘긴 뒤 고점 종가 대비 armStop 하락이면 판매)
    const mkDaily = (cfg) => (h, k) => {
      const D = dailyOf(h.y); if (!D) { return null; }
      const rg = D.month.get(k); if (!rg) return null;
      const mc = h.px.m.get(k), lastC = D.c[rg[1] - 1];
      if (mc && Math.abs(lastC / mc - 1) > 0.03) { if (!h.dBadK || h.dBadK !== k) { h.dBadK = k; miss++; } return null; }
      const St = h.dS || (h.dS = { peak: h.buyPx || 0, below: 0 });
      used++;
      for (let i = rg[0]; i < rg[1]; i++) {
        if (h.buyK === k && i === rg[0]) continue;                          // 구매일(그달 첫 거래일)은 건너뜀
        const c = D.c[i], l = D.l[i];
        if (cfg.stopLow && l <= St.peak * (1 - cfg.stopLow)) return { px: Math.min(c, St.peak * (1 - cfg.stopLow)), rs: 'd-저가손절' };
        if (cfg.stopPeak && c <= St.peak * (1 - cfg.stopPeak)) return { px: c, rs: 'd-고점손절' };
        if (cfg.stopBuy && h.buyPx && c <= h.buyPx * (1 - cfg.stopBuy)) return { px: c, rs: 'd-매수가손절' };
        if (cfg.ma && i + 1 >= cfg.ma) {
          const sma = (D.cs[i + 1] - D.cs[i + 1 - cfg.ma]) / cfg.ma;
          if (c < sma) { St.below++; if (St.below >= (cfg.days || 1)) return { px: c, rs: 'd-일봉이평' }; } else St.below = 0;
        }
        if (cfg.armUp) { if (c >= h.buyPx * cfg.armUp) St.armed = true; if (St.armed && c <= St.peak * (1 - cfg.armStop)) return { px: c, rs: 'd-익절후하락' }; }
        if (c > St.peak) St.peak = c;
      }
      return null;
    };
    const base = (sec, name, cfg, five, extra = {}) => add(S(sec), name, five ? { cand: candOf(m5), rule: r5, o: { exitMaN: 5, dailyFn: mkDaily(cfg), ...extra } } : { cand: candOf(mBase), rule: rule10, o: { dailyFn: mkDaily(cfg), ...extra } });
    add(S('기준'), '월봉 규칙 그대로(기준, 일봉 안 봄) 10이평', { cand: candOf(mBase), rule: rule10 });
    add(S('기준'), '월봉 규칙 그대로(기준, 일봉 안 봄) 5이평', { cand: candOf(m5), rule: r5, o: { exitMaN: 5 } });
    [false, true].forEach(five => {
      const T = five ? '5이평 + ' : '10이평(지금) + ';
      [0.15, 0.2, 0.25, 0.3, 0.4].forEach(p => base('A 일봉 고점 대비 손절(종가)', `${T}일봉 종가가 고점 종가 −${p * 100}%면 그날 종가에 판매`, { stopPeak: p }, five));
      [0.15, 0.2, 0.25, 0.3].forEach(p => base('B 일봉 고점 대비 손절(저가 기준, 손절가에 판매 — 종가가 더 낮으면 종가)', `${T}일봉 저가가 고점 종가 −${p * 100}%면 손절가(종가가 더 낮으면 종가)에 판매`, { stopLow: p }, five));
      [0.15, 0.2, 0.3].forEach(p => base('C 일봉 매수가 대비 손절', `${T}일봉 종가가 매수가 −${p * 100}%면 그날 종가에 판매`, { stopBuy: p }, five));
      [[0.2, 0.15], [0.3, 0.2]].forEach(([a, b]) => base('D 일봉 매수가+고점 이중 손절', `${T}매수가 −${a * 100}% 또는 고점 −${(a + 0.05) * 100}%`, { stopBuy: a, stopPeak: a + 0.05 }, five));
      [[1.5, 0.15], [2, 0.15], [2, 0.2], [2, 0.25], [3, 0.2]].forEach(([u, q]) => base('E 일봉 익절 뒤 하락', `${T}매수가의 ${u}배를 넘긴 뒤 고점 −${q * 100}%면 판매`, { armUp: u, armStop: q }, five));
    });
    // F 일봉 이평 이탈(월봉 이탈에 더함: 일봉 이평 아래 종가가 days일 연속이면 그날 판매) — 월봉 판단은 그대로 남음
    [[50, 1], [50, 5], [100, 1], [100, 5], [100, 10], [150, 5], [200, 1], [200, 5], [200, 10]].forEach(([n, d]) => base('F 일봉 이평 이탈(월봉 판단에 더함)', `10이평(지금) + 일봉 ${n}일 이평 아래 종가 ${d}일 연속이면 판매`, { ma: n, days: d }, false));
    [[50, 5], [100, 5], [200, 5]].forEach(([n, d]) => base('F 일봉 이평 이탈(월봉 판단에 더함)', `5이평 + 일봉 ${n}일 이평 아래 종가 ${d}일 연속이면 판매`, { ma: n, days: d }, true));
    // G 일봉 이평만 쓰고 월봉 이탈 판단은 끔(익절 트레일만 남음)
    [[50, 5], [100, 5], [150, 5], [200, 5], [100, 1], [200, 10]].forEach(([n, d]) => base('G 일봉 이평만(월봉 이탈 끔)', `일봉 ${n}일 이평 아래 종가 ${d}일 연속이면 판매, 월봉 이탈 판단 없음`, { ma: n, days: d }, false, { exitMaFn: () => 0 }));
    // H 조합
    base('H 조합', '10이평 + 일봉 100일 이평 5일 연속 + 고점 −25%', { ma: 100, days: 5, stopPeak: 0.25 }, false);
    base('H 조합', '5이평 + 일봉 100일 이평 5일 연속 + 고점 −25%', { ma: 100, days: 5, stopPeak: 0.25 }, true);
    base('H 조합', '10이평 + 매수가 −20% + 고점 −25% + 익절 뒤 −20%(2배)', { stopBuy: 0.2, stopPeak: 0.25, armUp: 2, armStop: 0.2 }, false);
    posts.push(() => { post12('16-', '16 일봉 판단'); post16(); });
    function post16() {                                                       // 일봉 규칙이 실제로 판 거래: 이유별 건수·평균 수익, 그리고 일봉을 쓴/못 쓴 달 수
      const mine = V.filter((v, i) => String(v.sec).startsWith('16-'));
      log(''); log('## 16 일봉 판단 — 판매 이유별 건수(평균 수익) · 일봉 규칙을 쓴 보유-달 수 / 월봉과 어긋나 못 쓴 달 수(전체 시험 합계)');
      log(`일봉을 쓴 보유-달 ${used} · 월봉과 3% 넘게 어긋나 건너뛴 달 ${miss}` + (used === 0 ? ' → 일봉 자료가 없음: node 2g_daily.js 먼저 실행' : ''));
      log('방식                                                       이유별(건수 · 평균 수익)');
      mine.forEach(v => { safe('16 이유', () => {
        const sm = simulate(ym => v.cand(ym).slice(0, 4), 4, v.C || C1, { ...simOpt(v.rule, v.o || {}), cand: v.cand, log: true }, v.dep != null ? v.dep : DEP), by = {};
        (sm.trades || []).filter(t => t.ret != null && t.sellYm).forEach(t => { const r = String(t.reason).replace(/^ma10-.*/, '월봉 이탈').replace(/^tpTrail$/, '월봉 익절').replace(/^ma10$/, '월봉 이탈'); (by[r] = by[r] || []).push(t.ret); });
        log(`${v.name.slice(0, 54).padEnd(54)} ` + Object.entries(by).sort((a, b) => b[1].length - a[1].length).map(([r, a]) => `${r} ${a.length}(${pc(mean(a))})`).join(' · '));
      }); });
    }
  }


  // ═════ 묶음 17: 미국 공매도 거래량 — FINRA 일별 공매도 거래량(2h_short.js로 받음)에서 월 공매도 비율(공매도 거래량 ÷ 전체 거래량)을 만들어, 그 달 미국 종목 중 순위(백분위)로 후보를 거르거나 순서를 바꿈.
  //   확인(구매 결정) 달 말까지의 값만 씀(미래 정보 없음). 한국 종목·자료 없는 종목은 '중립'(거르지 않음, 순위 0.5). 자료가 없으면 이 묶음은 기준과 똑같이 나옴.
  if (on(17)) {
    const S = n => `17-${n}`;
    const r5 = { tp: 2, grace: 2, rate: true, rateFn: chg('dgs10', 6), rateName: '국채10년 6개월', exitMaN: 5 };
    const m5 = mk({ ck: 's5' }, r5);
    const normSym = y => String(y).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const SH = new Map();
    const shMonth = k => {                                                       // 그 달(k) 종목별 공매도 비율. 거래량이 너무 적은 종목(받은 날 합계 10만 주 미만·3일 미만)은 뺌
      if (SH.has(k)) return SH.get(k);
      let v = null;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(DATA, 'short', ymOf(k) + '.json'), 'utf8')), m = new Map(), arr = [];
        for (const [sym, a] of Object.entries(j.d || {})) if (a[1] >= 1e5 && a[2] >= 3) { const r = a[0] / a[1]; m.set(normSym(sym), r); arr.push(r); }
        arr.sort((x, y) => x - y); if (arr.length > 200) v = { m, arr };
      } catch (e) {}
      SH.set(k, v); return v;
    };
    const shRatio = (y, k) => { if (isKR(y)) return null; const v = shMonth(k); const r = v && v.m.get(normSym(y)); return r == null ? null : r; };
    const shPct = (y, k) => { const r = shRatio(y, k); if (r == null) return null; const a = shMonth(k).arr; let lo = 0, hi = a.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < r) lo = mid + 1; else hi = mid; } return lo / a.length; };
    const shChg = (y, k) => { const a = shPct(y, k); if (a == null) return null; let t = 0, n = 0; for (let i = 1; i <= 3; i++) { const b = shPct(y, k - i); if (b != null) { t += b; n++; } } return n ? a - t / n : null; };
    let have = 0, total = 0; mBase.forEach(a => a.forEach(e => { if (!isKR(e.r.y)) { total++; if (shPct(e.r.y, e.cj) != null) have++; } }));
    const keep = (m, f) => wrap(m, a => a.filter(e => { const p = shPct(e.r.y, e.cj); return p == null || f(p, e); }));       // 자료 없는 종목은 거르지 않음
    const rankBy = (m, f, dir) => wrap(m, a => { const rows = a.map(e => { const p = shPct(e.r.y, e.cj); return [e, p == null ? 0.5 : p]; }); rows.sort((x, y) => dir * (x[1] - y[1])); return rows.map(x => x[0]); });
    const both = (sec, name, mk10, mk5) => { add(S(sec), '10이평 · ' + name, { cand: mk10, rule: rule10 }); add(S(sec), '5이평 · ' + name, { cand: mk5, rule: r5, o: { exitMaN: 5 } }); };
    add(S('기준'), '10이평(지금) 기준', { cand: candOf(mBase), rule: rule10 });
    add(S('기준'), '5이평 기준', { cand: candOf(m5), rule: r5, o: { exitMaN: 5 } });
    [0.1, 0.2, 0.3].forEach(q => both('A 공매도 비율 높은 종목 제외', `그 달 미국 종목 중 공매도 비율 상위 ${q * 100}% 제외`, keep(mBase, p => p < 1 - q), keep(m5, p => p < 1 - q)));
    [0.5, 0.7].forEach(q => both('B 공매도 비율 낮은 종목만', `공매도 비율 하위 ${q * 100}% 안인 미국 종목만(한국·자료 없음은 그대로)`, keep(mBase, p => p <= q), keep(m5, p => p <= q)));
    both('C 대조', '공매도 비율 상위 20%인 미국 종목만(나머지 미국은 제외)', keep(mBase, p => p >= 0.8), keep(m5, p => p >= 0.8));
    [0.3, 0.2].forEach(t => both('D 공매도 증가', `공매도 비율 순위가 최근 3개월 평균보다 ${t} 넘게 올라간 종목 제외`, wrap(mBase, a => a.filter(e => { const c = shChg(e.r.y, e.cj); return c == null || c < t; })), wrap(m5, a => a.filter(e => { const c = shChg(e.r.y, e.cj); return c == null || c < t; }))));
    both('E 공매도 감소', '공매도 비율 순위가 최근 3개월 평균보다 0.2 넘게 내려간 종목만(미국, 한국·자료 없음은 그대로)', wrap(mBase, a => a.filter(e => { const c = shChg(e.r.y, e.cj); return c == null || c <= -0.2; })), wrap(m5, a => a.filter(e => { const c = shChg(e.r.y, e.cj); return c == null || c <= -0.2; })));
    both('F 순위', '공매도 비율 낮은 순(자료 없음은 가운데)', rankBy(mBase, 0, 1), rankBy(m5, 0, 1));
    both('F 순위', '공매도 비율 높은 순(대조)', rankBy(mBase, 0, -1), rankBy(m5, 0, -1));
    const mix = m => wrap(m, a => { const rk = f => { const r = new Map(), s2 = [...a].sort((x, y) => f(y) - f(x)); s2.forEach((e, i) => r.set(e, i)); return r; }; const r1 = rk(e => e.s), r2 = rk(e => -(shPct(e.r.y, e.cj) ?? 0.5)); return [...a].sort((x, y) => (r1.get(x) + r2.get(x)) - (r1.get(y) + r2.get(y))); });
    both('G 점수와 섞기', '점수 순위와 공매도 낮은 순위의 평균', mix(mBase), mix(m5));
    [0.5, 0.6].forEach(t => both('H 절대 비율', `월 공매도 비율이 ${t * 100}% 넘는 미국 종목 제외`, wrap(mBase, a => a.filter(e => { const r = shRatio(e.r.y, e.cj); return r == null || r <= t; })), wrap(m5, a => a.filter(e => { const r = shRatio(e.r.y, e.cj); return r == null || r <= t; }))));
    posts.push(() => { post12('17-', '17 공매도'); post17(); post17b(); });
    function post17b() {                                                      // 공매도 자료가 있는 해(2019~)만 따로: 같은 규칙 기준 대비 연평균
      const ys = YEARS_ALL.filter(y => y >= 2019); if (!ys.length) return;
      log(''); log(`## 17 공매도 자료가 있는 ${ys[0]}~${ys[ys.length - 1]}만 본 연평균(자료는 2018-08부터) — 같은 규칙 기준 대비`);
      const base = { '10이평': V.find(v => v.name === '10이평(지금) 기준'), '5이평': V.find(v => v.name === '5이평 기준') };
      const b = Object.fromEntries(Object.entries(base).map(([k2, v]) => [k2, v && v.full && v.full.yearly ? cagrOver(v.full.yearly, ys) : null]));
      log(`기준: 10이평 ${b['10이평'] == null ? '-' : pc(b['10이평'])} · 5이평 ${b['5이평'] == null ? '-' : pc(b['5이평'])}`);
      V.filter(v => String(v.sec).startsWith('17-') && !String(v.sec).startsWith('17-기준')).forEach(v => { if (!v.full || !v.full.yearly) return; const k2 = v.name.startsWith('5이평') ? '5이평' : '10이평', c0 = cagrOver(v.full.yearly, ys); log(`${v.name.slice(0, 56).padEnd(56)} ${pc(c0).padStart(7)}  (기준 대비 ${b[k2] == null ? '-' : (c0 - b[k2] >= 0 ? '+' : '') + ((c0 - b[k2]) * 100).toFixed(1) + '%p'})`); });
    }
    function post17() {                                                       // 실제 거래를 공매도 비율 순위 구간별로 나눠 봄(신호 달 = 구매 전달 말)
      safe('17 연결 진단', () => {                                              // 어디가 비었나: 연도별로 공매도 자료가 있는 달 수 / 그 해 미국 후보 중 값이 연결된 비율(달은 있는데 비율이 낮으면 종목 이름이 안 맞는 것, 달이 비면 받기가 덜 된 것)
        const byY = {}; mBase.forEach(arr => arr.forEach(e => { if (isKR(e.r.y)) return; const Y = Math.floor(e.r.ym / 100), o = byY[Y] || (byY[Y] = { n: 0, h: 0 }); o.n++; if (shPct(e.r.y, e.cj) != null) o.h++; }));
        const lines = Object.keys(byY).sort().map(Y => { let mo = 0; for (let mth = 1; mth <= 12; mth++) if (shMonth(mi(+Y * 100 + mth))) mo++; return `${Y}: 자료 있는 달 ${mo}/12 · 후보 ${byY[Y].n}건 중 연결 ${byY[Y].h}건(${byY[Y].n ? (byY[Y].h / byY[Y].n * 100).toFixed(0) : 0}%)`; });
        log(''); log('## 17 연결 진단 — ' + lines.join(' | '));
      });
      log(''); log(`## 17 공매도 — 자료 연결: 미국 후보 ${total}건 중 공매도 값이 있는 것 ${have}건(${total ? (have / total * 100).toFixed(0) : 0}%)` + (have === 0 ? ' → 공매도 자료가 없음: node 2h_short.js 먼저 실행' : ''));
      log('## 17 공매도 — 실제 거래를 구매 전달 말의 공매도 비율 순위(미국 종목 중 백분위)로 나눈 성과(전체 기간)');
      log('방식                       구간                    거래 수   이긴 거래   평균 수익   중앙값');
      V.filter(v => String(v.sec).startsWith('17-기준')).forEach(v => safe('17 구간', () => {
        const sm = simulate(ym => v.cand(ym).slice(0, 4), 4, C1, { ...simOpt(v.rule, v.o || {}), cand: v.cand, log: true }, DEP), by = { '없음(한국·자료 없음)': [], '상위 20%': [], '중상(50~80%)': [], '중하(20~50%)': [], '하위 20%': [] };
        (sm.trades || []).filter(t => t.ret != null && t.buyYm).forEach(t => { const p = shPct(t.y, mi(t.buyYm) - 1); (p == null ? by['없음(한국·자료 없음)'] : p >= 0.8 ? by['상위 20%'] : p >= 0.5 ? by['중상(50~80%)'] : p >= 0.2 ? by['중하(20~50%)'] : by['하위 20%']).push(t.ret); });
        Object.entries(by).forEach(([nm, a]) => log(`${v.name.slice(0, 22).padEnd(22)} ${nm.padEnd(22)} ${String(a.length).padStart(6)}   ${a.length ? (a.filter(x => x > 0).length / a.length * 100).toFixed(0).padStart(5) + '%' : '    -'}   ${a.length ? pc(mean(a)).padStart(8) : '       -'}   ${a.length ? pc(pctl(a, 0.5)).padStart(7) : '      -'}`));
      }));
    }
  }


  // ═════ 묶음 18: 남은 시험 모음 — A 지수에 같은 규칙(108) · B 판매 기준 EMA(17·18 판매 쪽) · C 쌍별 순위 학습(41) · D 확인 시점 지표 다시 계산(42) · E 업종 분산(49·86·SIC) · F S&P500 편입 전후(122)
  //   E·F는 data/sic.json(2i_sic.js)·data/sp500.json(2j_sp500.js)가 있어야 효과가 있음(없으면 기준과 똑같이 나옴, 연결 건수를 보고에 적음). 한국 종목은 업종·편입 자료가 없어 그대로 둠.
  if (on(18)) {
    const S = n => `18-${n}`;
    const r5 = { tp: 2, grace: 2, rate: true, rateFn: chg('dgs10', 6), rateName: '국채10년 6개월', exitMaN: 5 };
    const m5 = mk({ ck: 'g5' }, r5);
    const A5 = (sec, name, cand, o = {}) => add(S(sec), name, { cand, rule: r5, o: { exitMaN: 5, ...o } });
    const A10 = (sec, name, cand, o = {}) => add(S(sec), name, { cand, rule: rule10, o });
    add(S('기준'), '10이평(지금) 기준', { cand: candOf(mBase), rule: rule10 });
    A5('기준', '5이평 기준', candOf(m5));
    // B 판매 기준 EMA(지수이동평균): 같은 길이의 단순이평보다 최근 값에 가중
    const emaCache = new Map();
    const emaAt = (o, k, N) => {
      let byN = emaCache.get(o); if (!byN) { byN = new Map(); emaCache.set(o, byN); }
      let ser = byN.get(N);
      if (!ser) { ser = new Map(); const keys = [...o.m.keys()].sort((a, b) => a - b), al = 2 / (N + 1); let e = null; keys.forEach((kk, i) => { const c = o.m.get(kk); e = e == null ? c : al * c + (1 - al) * e; ser.set(kk, i >= N ? e : null); }); byN.set(N, ser); }
      return ser.get(k) ?? null;
    };
    [3, 4, 5, 6, 7, 9, 12].forEach(N => A10('B 판매 기준 EMA', `판매 기준 EMA ${N}(유예 2달+금리·익절 2배, 후보 풀은 10이평)`, candOf(mBase), { exitMaFn: (h, k) => emaAt(h.px, k, N) }));
    // C 쌍별 순위 학습: 같은 달 안에서 (A가 B보다 수익이 큰) 쌍을 골라 점수 차이가 맞도록 로지스틱으로 학습(그달 순위를 직접 맞추는 방식)
    const pairFit = (opt = {}) => (Z, T, G) => {
      const d = Z[0].length, w = new Array(d + 1).fill(0), by = new Map();
      G.forEach((g, i) => { (by.get(g) || by.set(g, []).get(g)).push(i); });
      const groups = [...by.values()].filter(a => a.length >= 5), E = opt.epochs || 6, K = opt.k || 4, lam = opt.lam ?? 0.001, lr0 = opt.lr || 0.05, mg = opt.margin ?? 0.05;
      let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      for (let ep = 0; ep < E; ep++) {
        const lr = lr0 / (1 + ep);
        for (const g of groups) {
          const n = g.length;
          for (let q = 0; q < n * K; q++) {
            const a = g[Math.floor(rnd() * n)], b2 = g[Math.floor(rnd() * n)]; if (a === b2) continue;
            const dt = T[a] - T[b2]; if (Math.abs(dt) < mg) continue;
            const sg = dt > 0 ? 1 : -1; let sdiff = 0; for (let k = 0; k < d; k++) sdiff += w[k + 1] * (Z[a][k] - Z[b2][k]);
            const gr = 1 / (1 + Math.exp(sg * sdiff));
            for (let k = 0; k < d; k++) w[k + 1] += lr * (gr * sg * (Z[a][k] - Z[b2][k]) - lam * w[k + 1]);
          }
        }
      }
      return w;
    };
    const altModel = (name, opts, ck) => {
      const m2 = rescore(opts), old = scored[kA]; scored[kA] = m2;
      let pm, pm5; try { pm = mk({ ck: 'q' + ck }); pm5 = mk({ ck: 'q5' + ck }, r5); } finally { scored[kA] = old; }
      A10('C 쌍별 순위 학습', '10이평 · ' + name, candOf(pm)); A5('C 쌍별 순위 학습', '5이평 · ' + name, candOf(pm5));
    };
    altModel('쌍별 순위 학습(기본, 벌점 0.001)', { fitFn: pairFit() }, 'pw1');
    altModel('쌍별 순위 학습(벌점 0.01)', { fitFn: pairFit({ lam: 0.01 }) }, 'pw2');
    altModel('쌍별 순위 학습(수익 차이 0.3 넘는 쌍만)', { fitFn: pairFit({ margin: 0.3 }) }, 'pw3');
    altModel('쌍별 순위 학습(쌍 2배·12번 반복)', { fitFn: pairFit({ k: 8, epochs: 12 }) }, 'pw4');
    // D 확인 시점 지표 다시 계산: 지금 점수는 돌파 달 지표인데, 확인 달(구매 결정 달)의 가격 지표로 다시 계산해 같은 모델로 점수를 냄. 월봉 가격으로 만들 수 있는 지표만 갱신(거시·지수·돌파 실패 횟수는 돌파 때 값 그대로)
    { const keep = {}; rescore({ keep });
      const sc2 = (e, avg) => { const Y = Math.floor(e.r.ym / 100), M = keep[Y]; if (!M) return e.s; const x2 = featAt(px(e.r.y), e.cj, e.r.x); if (!x2) return e.s; const s2 = score(M.w, z({ x: x2 }, M.P)); return avg ? (s2 + e.s) / 2 : s2; };
      [[false, '확인 달 지표로 다시 계산한 점수 순'], [true, '돌파 때 점수와 확인 달 점수의 평균 순']].forEach(([avg, nm]) => {
        A10('D 확인 시점 지표', '10이평 · ' + nm, wrap(mBase, a => [...a].sort((x, y) => sc2(y, avg) - sc2(x, avg))));
        A5('D 확인 시점 지표', '5이평 · ' + nm, wrap(m5, a => [...a].sort((x, y) => sc2(y, avg) - sc2(x, avg)))); }); }
    // E 업종 분산 · F S&P500 편입 전후
    let SIC = {}, SPM = {}; try { SIC = JSON.parse(fs.readFileSync(path.join(DATA, 'sic.json'), 'utf8')); } catch (e) {} try { SPM = JSON.parse(fs.readFileSync(path.join(DATA, 'sp500.json'), 'utf8')); } catch (e) {}
    const normSym = y => String(y).replace(/[^A-Za-z0-9]/g, '').toUpperCase(), sf = y => y.replace(/[^A-Za-z0-9.\-]/g, '_');
    const SPN = new Map(); Object.entries(SPM).forEach(([k2, v]) => SPN.set(normSym(k2), v));
    const sicGroup = y => { if (isKR(y)) return null; const a = SIC[sf(y)]; return a && a.sic ? String(a.sic).padStart(4, '0').slice(0, 2) : null; };
    const spAddedYm = y => { if (isKR(y)) return undefined; const a = SPN.get(normSym(y)); if (!a) return undefined; const d = String(a.added || '').match(/^(\d{4})-(\d{2})/); return d ? +d[1] * 100 + +d[2] : 0; };    // undefined = 목록에 없음, 0 = 편입일 모름
    let nUs = 0, nSic = 0, nSp = 0; mBase.forEach(a => a.forEach(e => { if (!isKR(e.r.y)) { nUs++; if (sicGroup(e.r.y) != null) nSic++; if (spAddedYm(e.r.y) !== undefined) nSp++; } }));
    const diversify = (m, cap) => wrap(m, a => { const cnt = new Map(), first = [], rest = []; for (const e of a) { const g = sicGroup(e.r.y); if (g == null) { first.push(e); continue; } const c = cnt.get(g) || 0; if (c < cap) { first.push(e); cnt.set(g, c + 1); } else rest.push(e); } return first.concat(rest); });
    [1, 2].forEach(cap => { A10('E 업종 분산', `10이평 · 같은 업종(SIC 앞 2자리)은 한 달에 ${cap}종목까지 먼저 고르고 나머지는 뒤로`, diversify(mBase, cap)); A5('E 업종 분산', `5이평 · 같은 업종(SIC 앞 2자리)은 한 달에 ${cap}종목까지 먼저 고르고 나머지는 뒤로`, diversify(m5, cap)); });
    const spf = (m, f) => wrap(m, a => a.filter(e => f(spAddedYm(e.r.y), ymOf(e.cj))));
    [['미래에 S&P500에 들어갈 종목은 제외(그 시점엔 편입 전)', (d, y) => !(d !== undefined && d > 0 && d > y)], ['S&P500에 이미 들어가 있던 미국 종목만(한국은 그대로, 편입 안 된 미국 종목 제외)', (d, y) => d === undefined ? false : d <= y], ['아직 S&P500 편입 전이던 종목만(대조, 한국은 그대로)', (d, y) => d !== undefined && d > y]].forEach(([nm, f], i) => {
      const f2 = (d, y) => d === undefined && !(nm.startsWith('S&P500에 이미') || nm.startsWith('아직')) ? true : f(d, y);
      const g2 = (m) => wrap(m, a => a.filter(e => isKR(e.r.y) ? true : f2(spAddedYm(e.r.y), ymOf(e.cj))));
      A10('F S&P500 편입 전후', '10이평 · ' + nm, g2(mBase)); A5('F S&P500 편입 전후', '5이평 · ' + nm, g2(m5)); });
    posts.push(() => { post12('18-', '18 남은 시험'); post18(); });
    function post18() {
      log(''); log(`## 18 연결 상태 — 미국 후보 ${nUs}건 중 업종(SIC) 값 ${nSic}건(${nUs ? (nSic / nUs * 100).toFixed(0) : 0}%) · S&P500 현재 편입 종목 ${nSp}건(${nUs ? (nSp / nUs * 100).toFixed(0) : 0}%)` + (nSic === 0 ? ' → 업종 자료 없음: node 2i_sic.js' : '') + (nSp === 0 ? ' → S&P500 자료 없음: node 2j_sp500.js' : ''));
      safe('18 검산', () => {                                                 // 검산: 돌파 달에서 다시 계산한 지표가 events의 원래 값과 같아야 함(다르면 D의 결과는 믿지 말 것)
        const rows = ALL.filter((r, i) => i % Math.max(1, Math.floor(ALL.length / 3000)) === 0), bad = {}, tot = {}; let nulls = 0;
        rows.forEach(r => { const x2 = featAt(px(r.y), mi(r.ym), r.x); if (!x2) { nulls++; return; } Object.entries(FI).forEach(([n, j]) => { const a = r.x[j], b2 = x2[j]; if (!Number.isFinite(a)) return; tot[n] = (tot[n] || 0) + 1; if (!(Math.abs(a - b2) <= 1e-3 * Math.max(1, Math.abs(a)))) bad[n] = (bad[n] || 0) + 1; }); });
        const worst = Object.keys(tot).map(n => [n, (bad[n] || 0) / tot[n]]).filter(x => x[1] > 0.02).sort((x, y) => y[1] - x[1]);
        log(`## 18 검산 — 돌파 달에서 다시 계산한 가격 지표 ${Object.keys(tot).length}개 vs events 원래 값(표본 ${rows.length}행, 계산 못 한 행 ${nulls}): ` + (worst.length ? '2% 넘게 다른 지표: ' + worst.map(([n, f]) => `${n} ${(f * 100).toFixed(0)}%`).join(' · ') + ' → D 결과는 이 지표 차이를 감안해서 볼 것' : '모두 일치'));
      });
      log(''); log('## 18 지수에 같은 규칙(108) — 지수 이평 타이밍(10이평 위면 보유, 아래로 g달 연속 내려가면 현금, 다시 위로 오면 보유; 2012-01~2026-10, 월 수익률 복리, 왕복 비용 포함)');
      log('지수                  이평 길이   유예 1달(즉시)         유예 2달            (연평균 · 낙폭)');
      safe('108 지수', () => {
        const k0 = mi(201201), k1 = mi(202610);
        [['ks', '코스피', 0.001], ['sp', 'S&P500(원화)', 0.0035], ['nq', '나스닥100(원화)', 0.0035]].forEach(([key, nm, cost]) => {
          const rk = k => { const a = idxAt(key, k), b2 = idxAt(key, k - 1); return a && b2 ? (key === 'ks' ? a / b2 : (a * fx(k)) / (b2 * fx(k - 1))) - 1 : 0; };
          const bh = []; for (let k = k0; k <= k1; k++) bh.push(rk(k));
          log(`${nm.padEnd(18)} 그냥 보유            ${pc(cagrOf(bh)).padStart(7)} · ${pc(mddOf(bh)).padStart(7)}`);
          [3, 4, 5, 6, 7, 8, 10, 12].forEach(N => {
            const res = [1, 2].map(g => { let pos = false, below = 0; const a = []; for (let k = k0; k <= k1; k++) { const p = idxAt(key, k - 1), mm = idxMa(key, k - 1, N); if (!p || !mm) { a.push(0); continue; } const isB = p < mm; below = isB ? below + 1 : 0; const want = !isB ? true : (pos && below < g); let r = want ? rk(k) : 0; if (want !== pos) { r -= cost; pos = want; } a.push(r); } return `${pc(cagrOf(a)).padStart(7)} · ${pc(mddOf(a)).padStart(7)}`; });
            log(`${nm.padEnd(18)} ${String(N).padStart(2)}이평            ${res[0]}      ${res[1]}`);
          });
        });
      });
    }
  }


  // ═════ 묶음 19: 점수 오답 분석 · 손실 걸러내기 — "점수가 높았는데 크게 잃은 거래"와 "점수가 낮았는데 크게 번 거래"가 어떤 지표 구조였는지 보고(분석 표), 손실 위험·큰 이익을 따로 예측하는 점수로 후보를 걸러내거나 순위를 섞어 봄(해마다 그 전 자료만으로 학습)
  //   분석 표는 같은 자료에서 고르는 것이라 과장될 수 있어 앞쪽(~2019)·뒤쪽(2020~)이 모두 같은 방향인 것만 믿을 것. 시험 변형(걸러내기·순위 섞기)은 걸어가며 학습이라 그런 편향이 없음.
  if (on(19)) {
    const S = n => `19-${n}`;
    const r5 = { tp: 2, grace: 2, rate: true, rateFn: chg('dgs10', 6), rateName: '국채10년 6개월', exitMaN: 5 };
    const m5 = mk({ ck: 'h5' }, r5);
    const A5 = (sec, name, cand) => add(S(sec), name, { cand, rule: r5, o: { exitMaN: 5 } });
    const A10 = (sec, name, cand) => add(S(sec), name, { cand, rule: rule10 });
    A10('기준', '10이평(지금) 기준', candOf(mBase)); A5('기준', '5이평 기준', candOf(m5));
    const indModel = (name, f) => {                                           // 정답을 0/1(손실이었나·크게 올랐나)로 바꿔 해마다 학습 → (종목|신호월) → 예측 값
      const m2 = rescore({ trainFn: Y => trainFiltered(null)(Y).map(r => ({ ...r, t: f(r.t) ? 1 : 0 })) }), mp = new Map();
      m2.forEach(a => a.forEach(x => mp.set(x.r.y + '|' + x.r.ym, x.s))); return mp;
    };
    const LOSS10 = indModel('loss10', t => t < Math.log(0.9)), LOSS20 = indModel('loss20', t => t < Math.log(0.8)), GAIN50 = indModel('gain50', t => t > Math.log(1.5));
    const key = e => e.r.y + '|' + e.sym;
    const vetoBy = (m, MP, q) => wrap(m, a => { if (a.length < 5) return a; const sc = a.map(e => MP.get(key(e)) ?? 0), idx = a.map((e, i) => i).sort((i, j) => sc[j] - sc[i]), drop = new Set(idx.slice(0, Math.floor(a.length * q))); return a.filter((e, i) => !drop.has(i)); });
    const rk = (a, f) => { const r = new Map(), s2 = [...a].sort((x, y) => f(y) - f(x)); s2.forEach((e, i) => r.set(e, i)); return r; };
    const blend = (m, wl, wg, lossMp) => wrap(m, a => { if (a.length < 2) return a; const r0 = rk(a, e => e.s), rl = rk(a, e => -(lossMp.get(key(e)) ?? 0)), rg = rk(a, e => GAIN50.get(key(e)) ?? 0); return [...a].sort((x, y) => (r0.get(x) + wl * rl.get(x) + wg * rg.get(x)) - (r0.get(y) + wl * rl.get(y) + wg * rg.get(y))); });
    [[mBase, A10, '10이평'], [m5, A5, '5이평']].forEach(([m, A, nm]) => {
      [0.1, 0.2, 0.3].forEach(q => A('A 손실 위험 높은 후보 제외', `${nm} · 손실(−10% 이하) 위험 예측 상위 ${q * 100}% 제외`, vetoBy(m, LOSS10, q)));
      A('A 손실 위험 높은 후보 제외', `${nm} · 큰 손실(−20% 이하) 위험 예측 상위 20% 제외`, vetoBy(m, LOSS20, 0.2));
      A('B 점수 + 손실 위험', `${nm} · 점수 순위 + 0.5 × 손실 위험 낮은 순위`, blend(m, 0.5, 0, LOSS10)); A('B 점수 + 손실 위험', `${nm} · 점수 순위 + 1 × 손실 위험 낮은 순위`, blend(m, 1, 0, LOSS10));
      A('C 점수 + 큰 이익', `${nm} · 점수 순위 + 0.5 × 큰 이익(+50%↑) 예측 순위`, blend(m, 0, 0.5, LOSS10));
      A('D 세 가지 섞기', `${nm} · 점수 + 0.5 × 큰 이익 + 0.5 × 손실 위험 낮은 순위`, blend(m, 0.5, 0.5, LOSS10));
      A('E 대조', `${nm} · 손실 위험 낮은 순만`, wrap(m, a => [...a].sort((x, y) => (LOSS10.get(key(x)) ?? 0) - (LOSS10.get(key(y)) ?? 0))));
    });
    posts.push(() => { post12('19-', '19 점수 오답 분석·손실 걸러내기'); post19(); });
    function post19() {
      const FN = c.F || []; const vArr = V.filter(v => String(v.sec).startsWith('19-기준'));
      vArr.forEach(v => safe('19 분석', () => {
        const sm = simulate(ym => v.cand(ym).slice(0, 4), 4, C1, { ...simOpt(v.rule, v.o || {}), cand: v.cand, log: true }, DEP);
        const T = (sm.trades || []).filter(t => t.ret != null && t.buyYm && t.score != null && Array.isArray(t.feats));
        if (T.length < 50) { log(`(19 분석: 거래 ${T.length}건뿐이라 건너뜀)`); return; }
        const byS = [...T].sort((a, b) => b.score - a.score), n = T.length;
        log(''); log(`## 19 점수 구간별 성과 — ${v.name} (실제 거래 ${n}건, 구매 때 점수 순위 5구간)`);
        log('구간          거래 수   이긴 거래   평균 수익   중앙값    큰 손실(−15% 이하)   큰 이익(+50% 이상)');
        for (let q = 0; q < 5; q++) { const a = byS.slice(Math.floor(n * q / 5), Math.floor(n * (q + 1) / 5)).map(t => t.ret); log(`${['상위 20%', '중상 20%', '가운데 20%', '중하 20%', '하위 20%'][q].padEnd(10)} ${String(a.length).padStart(7)}   ${(a.filter(x => x > 0).length / a.length * 100).toFixed(0).padStart(5)}%   ${pc(mean(a)).padStart(8)}  ${pc(pctl(a, 0.5)).padStart(7)}   ${(a.filter(x => x <= -0.15).length / a.length * 100).toFixed(0).padStart(10)}%   ${(a.filter(x => x >= 0.5).length / a.length * 100).toFixed(0).padStart(14)}%`); }
        const cut40 = byS[Math.floor(n * 0.4)].score, cutL = byS[Math.floor(n * 0.6)].score;
        const HL = T.filter(t => t.score >= cut40 && t.ret <= -0.15), LW = T.filter(t => t.score <= cutL && t.ret >= 0.5);
        const zdiff = G => { const out = []; FN.forEach((nm, j) => { const all = T.map(t => t.feats[j]).filter(Number.isFinite), g = G.map(t => t.feats[j]).filter(Number.isFinite); if (all.length < 30 || g.length < 5) return; const mu = mean(all), sd = sdOf(all) || 1; out.push([nm, (mean(g) - mu) / sd, g.length]); }); return out.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 8); };
        log(''); log(`## 19 오답 분석 — ${v.name}: 점수 상위 60%인데 −15% 이하로 잃은 거래 ${HL.length}건 vs 점수 하위 60%인데 +50% 이상 번 거래 ${LW.length}건, 그 거래들의 지표 평균이 전체 거래 평균과 얼마나 달랐나(표준편차 단위, 큰 순 8개)`);
        log('점수 높았는데 크게 잃음: ' + zdiff(HL).map(([nm, d]) => `${nm} ${d >= 0 ? '+' : ''}${d.toFixed(2)}`).join(' · '));
        log('점수 낮았는데 크게 번 : ' + zdiff(LW).map(([nm, d]) => `${nm} ${d >= 0 ? '+' : ''}${d.toFixed(2)}`).join(' · '));
        // 지표 하나로 손실 걸러내기: 그 지표가 가장 나쁜 10% 거래를 뺐을 때 거래 평균 수익이 어떻게 바뀌나 — 앞쪽(~2019)·뒤쪽(2020~) 모두 좋아지는 지표만 (같은 자료에서 고른 것이라 과장됨)
        const E1 = T.filter(t => t.buyYm <= 201912), E2 = T.filter(t => t.buyYm > 201912), res = [];
        FN.forEach((nm, j) => { if (nm.startsWith('m_') || nm === 'us' || nm === 'etf') return; [1, -1].forEach(dir => {
          const effect = A => { const vals = A.map(t => t.feats[j]).filter(Number.isFinite); if (vals.length < 30) return null; const th = pctl(vals, dir > 0 ? 0.9 : 0.1); const kept = A.filter(t => !(Number.isFinite(t.feats[j]) && (dir > 0 ? t.feats[j] >= th : t.feats[j] <= th))); return kept.length ? mean(kept.map(t => t.ret)) - mean(A.map(t => t.ret)) : null; };
          const a = effect(E1), b = effect(E2); if (a != null && b != null) res.push([nm + (dir > 0 ? ' 큰 값 10% 제외' : ' 작은 값 10% 제외'), a, b]); }); });
        log(''); log(`## 19 지표 하나로 손실 걸러내기(${v.name}) — 그 지표가 가장 나쁜 10% 거래를 빼면 거래 평균 수익이 얼마나 오르나 (앞쪽 ${E1.length}건 / 뒤쪽 ${E2.length}건, 둘 다 오르는 것만, 같은 자료에서 고른 것이라 과장됨)`);
        res.filter(x => x[1] > 0 && x[2] > 0).sort((x, y) => Math.min(y[1], y[2]) - Math.min(x[1], x[2])).slice(0, 8).forEach(([nm, a, b]) => log(`${nm.padEnd(30)} 앞쪽 ${pc(a).padStart(7)} · 뒤쪽 ${pc(b).padStart(7)}`));
      }));
    }
  }


  // ═════ 묶음 20: 지친 말 점수 — "달리는 말에 타고, 지치면 내리고, 다시 달리는 말에 탄다". 지금 점수는 올라탈 때(돌파) 고르는 점수인데, 보유 중인 종목이 지쳤는지(곧 꺾일지)·더 갈지를 따로 점수로 만들어
  //   ① 지쳤다고 보면 이평 이탈 전에 판매 ② 이평 아래로 내려왔어도 안 지쳤으면 유예를 늘림 ③ 지쳤으면 유예 없이 즉시 판매 를 시험. 점수는 '이평 위에 있는 모든 종목-달'(보유 상태) 자료로 해마다 그 전까지만 학습: 다음 달 −8% 이하 하락 여부(위험)·다음 3개월 수익(기대).
  if (on(20)) {
    const S = n => `20-${n}`;
    const r5 = { tp: 2, grace: 2, rate: true, rateFn: chg('dgs10', 6), rateName: '국채10년 6개월', exitMaN: 5 };
    const m5 = mk({ ck: 'k5' }, r5);
    const base = new Array(F.length).fill(NaN), COLS = Object.values(FI), MANt = +process.env.MA_N || 10;
    // 보유 상태 표: 이평 위에 있는 종목-달마다 지표 + 다음 달 하락 여부 + 다음 3개월 수익
    const syms = [...new Set(ALL.map(r => r.y))], panel = [];
    syms.forEach(y => { const o = px(y), keys = [...o.m.keys()].sort((a, b) => a - b); if (keys.length < 60) return;
      keys.forEach(k => { if (k < keys[0] + 40 || ymOf(k) < 200901) return; const c0 = o.m.get(k), c1 = o.m.get(k + 1), c3 = o.m.get(k + 3); if (!(c0 > 0 && c1 > 0 && c3 > 0)) return;
        const ma = maAtN(o, k, MANt); if (!(ma > 0) || c0 <= ma) return; const x = featAt(o, k, base); if (!x) return;
        panel.push({ k, y, x, t1: c1 / c0 - 1 <= -0.08 ? 1 : 0, r1: c1 / c0 - 1, t3: Math.max(-1, Math.min(1, Math.log(c3 / c0))) }); }); });
    const models = {};                                                          // 연도 → { P, wR(위험), wE(기대), q(위험 분위값들), e(기대 분위값들) }
    const yrsM = [...new Set(panel.map(r => Math.floor(ymOf(r.k) / 100)))].filter(Y => Y >= 2012).sort();
    yrsM.forEach(Y => { const cut = mi(Y * 100 + 1) - 3, tr = panel.filter((r, i) => r.k < cut && i % 2 === 0); if (tr.length < 2000) return;
      const P = prep(tr, COLS), Zs = tr.map(r => z(r, P)), wR = fitRidge(Zs, tr.map(r => r.t1), 300), wE = fitRidge(Zs, tr.map(r => r.t3), 300);
      const pr = Zs.map(zx => score(wR, zx)).sort((a, b) => a - b), pe = Zs.map(zx => score(wE, zx)).sort((a, b) => a - b), qf = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
      models[Y] = { P, wR, wE, q: { 5: qf(pr, 0.95), 10: qf(pr, 0.9), 20: qf(pr, 0.8), 50: qf(pr, 0.5), 70: qf(pr, 0.3) }, e: { 10: qf(pe, 0.1), 50: qf(pe, 0.5) } }; });
    const cache = new Map();
    const sc = (h, k) => { const key = h.y + '|' + k; if (cache.has(key)) return cache.get(key); const M = models[Math.floor(ymOf(k) / 100)]; let v = null;
      if (M) { const x = featAt(h.px, k, base); if (x) { const zx = z({ x }, M.P); v = { risk: score(M.wR, zx), exp: score(M.wE, zx), M }; } } cache.set(key, v); return v; };
    const tired = (h, k, p) => { const v = sc(h, k); return !!(v && v.risk >= v.M.q[p]); };
    const fresh = (h, k, p) => { const v = sc(h, k); return !!(v && v.risk <= v.M.q[p]); };
    const lowExp = (h, k) => { const v = sc(h, k); return !!(v && v.exp <= v.M.e[10]); };
    add(S('기준'), '10이평(지금) 기준', { cand: candOf(mBase), rule: rule10 }); add(S('기준'), '5이평 기준', { cand: candOf(m5), rule: r5, o: { exitMaN: 5 } });
    [[mBase, rule10, {}, '10이평'], [m5, r5, { exitMaN: 5 }, '5이평']].forEach(([m, rule, o0, nm]) => {
      const A = (sec, name, extra) => add(S(sec), `${nm} · ${name}`, { cand: candOf(m), rule, o: { ...o0, ...extra } });
      [[20, '상위 20%'], [10, '상위 10%'], [5, '상위 5%']].forEach(([p, t]) => A('A 지쳤으면 이평 위여도 판매', `다음 달 큰 하락 위험이 ${t}이면 판매`, { exitFn: (h, k) => (tired(h, k, p) ? 'tired' : null) }));
      A('A 지쳤으면 이평 위여도 판매', '다음 3개월 기대 수익이 하위 10%면 판매', { exitFn: (h, k) => (lowExp(h, k) ? 'tired' : null) });
      A('B 안 지쳤으면 유예 연장', '이평 아래여도 위험이 하위 30%면 유예 3달', { graceN2: (h, k) => (fresh(h, k, 70) ? 3 : undefined) });
      A('B 안 지쳤으면 유예 연장', '이평 아래여도 위험이 하위 50%면 유예 3달', { graceN2: (h, k) => (fresh(h, k, 50) ? 3 : undefined) });
      A('C 지쳤으면 유예 없이 판매', '이평 아래이고 위험이 상위 50%면 유예 없이 즉시', { graceN2: (h, k) => (tired(h, k, 50) ? 1 : undefined) });
      A('D 섞기', '유예 3달(안 지침) + 즉시(지침) 같이', { graceN2: (h, k) => (fresh(h, k, 70) ? 3 : tired(h, k, 50) ? 1 : undefined) });
      A('D 섞기', '유예 3달/즉시 + 위험 상위 10% 이평 위여도 판매', { graceN2: (h, k) => (fresh(h, k, 70) ? 3 : tired(h, k, 50) ? 1 : undefined), exitFn: (h, k) => (tired(h, k, 10) ? 'tired' : null) });
    });
    posts.push(() => { post12('20-', '20 지친 말 점수'); post20(); });
    function post20() {                                                       // 지친 말을 미리 알 수 있나: 점수 구간별 다음 달·3개월 수익(그 해 이전 자료로만 학습한 점수, 학습에 안 쓴 해의 자료)
      log(''); log(`## 20 지친 말 점수 — 보유 상태 표 ${panel.length}행(이평 위 종목-달) · 학습한 해 ${Object.keys(models).length}개`);
      const bins = (lo, hi) => { const out = Array.from({ length: 5 }, () => ({ n: 0, r1: 0, t1: 0, t3: 0 }));
        panel.forEach(r => { const Y = Math.floor(ymOf(r.k) / 100); if (Y < lo || Y > hi) return; const M = models[Y]; if (!M) return; const zx = z(r, M.P), v = score(M.wR, zx); const b = v >= M.q[10] ? 0 : v >= M.q[20] ? 1 : v >= M.q[50] ? 2 : v >= M.q[70] ? 3 : 4; const o = out[b]; o.n++; o.r1 += r.r1; o.t1 += r.t1; o.t3 += r.t3; });
        return out; };
      [['앞쪽 2012~2019', 2012, 2019], ['뒤쪽 2020~', 2020, 2100]].forEach(([nm, lo, hi]) => { const b = bins(lo, hi);
        log(`${nm}: 위험 점수 구간별 — 행 수 · 다음 달 평균 수익 · 다음 달 −8% 이하 비율 · 다음 3개월 평균 로그수익`);
        ['상위 10%(가장 지침)', '상위 10~20%', '중간(20~50%)', '50~70%', '하위 30%(가장 건강)'].forEach((l, i) => { const o = b[i]; log(`  ${l.padEnd(20)} ${String(o.n).padStart(7)}  ${pc(o.r1 / (o.n || 1)).padStart(7)}  ${(o.t1 / (o.n || 1) * 100).toFixed(1).padStart(5)}%  ${(o.t3 / (o.n || 1)).toFixed(3).padStart(7)}`); }); });
    }
  }


  // ═════ 묶음 21: 바벨 구성 — 점수는 손실을 피하는 일은 하지만 대박(변동성 크고 봉이 긴 종목)은 못 찾으므로, 4종목 중 일부 칸을 '대박 예측' 순으로 채움(나머지는 점수 순). 해마다 그 전 자료로만 학습한 '+50% 이상 오를 가능성' 점수 등을 씀.
  //   g칸을 대박 칸으로: 점수 순 (4−g)종목 + 대박 순 g종목. 대조로 같은 칸을 무작위로 채운 것(분산 효과만 보려고)과 5종목(점수 4 + 대박 1)도 시험.
  if (on(21)) {
    const S = n => `21-${n}`;
    const r5 = { tp: 2, grace: 2, rate: true, rateFn: chg('dgs10', 6), rateName: '국채10년 6개월', exitMaN: 5 };
    const m5 = mk({ ck: 'bb5' }, r5);
    const indModel = f => { const m2 = rescore({ trainFn: Y => trainFiltered(null)(Y).map(r => ({ ...r, t: f(r.t) ? 1 : 0 })) }), mp = new Map(); m2.forEach(a => a.forEach(x => mp.set(x.r.y + '|' + x.r.ym, x.s))); return mp; };
    const GAIN50 = indModel(t => t > Math.log(1.5)), GAIN100 = indModel(t => t > Math.log(2)), LOSS10 = indModel(t => t < Math.log(0.9));
    const key = e => e.r.y + '|' + e.sym, VOL = fi('volat12'), RNG = fi('range');
    // 점수 순 (4−g)종목 + (남은 후보 중 rankFn이 큰 순) g종목 + 나머지(점수 순). pool: 점수 상위 몇 %의 후보 안에서만 대박 칸을 고름, veto: 손실 위험 상위 몇 %는 대박 칸에서도 뺌
    const barbell = (m, g, rankFn, o = {}) => wrap(m, a0 => {
      const a = [...a0].sort((x, y) => y.s - x.s); if (a.length < 2) return a;
      const k = Math.max(0, 4 - g), first = a.slice(0, k), fs2 = new Set(first);
      let pool = a.filter(e => !fs2.has(e));
      if (o.pool) { const lim = Math.ceil(a.length * o.pool); pool = pool.filter(e => a.indexOf(e) < lim); }
      if (o.veto && pool.length >= 4) { const sc = pool.map(e => LOSS10.get(key(e)) ?? 0), idx = pool.map((e, i) => i).sort((i, j) => sc[j] - sc[i]), drop = new Set(idx.slice(0, Math.floor(pool.length * o.veto))); pool = pool.filter((e, i) => !drop.has(i)); }
      const big = [...pool].sort((x, y) => rankFn(y) - rankFn(x)).slice(0, g), chosen = new Set([...first, ...big]);
      return [...first, ...big, ...a.filter(e => !chosen.has(e))];
    });
    const gainR = e => GAIN50.get(key(e)) ?? 0, gain100R = e => GAIN100.get(key(e)) ?? 0, volR = e => e.r.x[VOL] ?? 0, rngR = e => e.r.x[RNG] ?? 0, rndR = e => hash01('bb|' + e.r.y + '|' + e.sym);
    [[mBase, rule10, {}, '10이평'], [m5, r5, { exitMaN: 5 }, '5이평']].forEach(([m, rule, o0, nm]) => {
      const A = (sec, name, cand, extra = {}) => add(S(sec), `${nm} · ${name}`, { cand, rule, o: { ...o0, ...extra } });
      A('기준', '점수 순 4종목(지금)', candOf(m));
      A('A 대박 칸 1개', '점수 3 + 대박(+50%↑ 가능성) 1', barbell(m, 1, gainR));
      A('A 대박 칸 1개', '점수 3 + 대박(+100%↑ 가능성) 1', barbell(m, 1, gain100R));
      A('A 대박 칸 1개', '점수 3 + 변동성(12개월) 큰 순 1', barbell(m, 1, volR));
      A('A 대박 칸 1개', '점수 3 + 봉 길이(range) 큰 순 1', barbell(m, 1, rngR));
      A('B 대박 칸 조건', '점수 3 + 대박 1(점수 상위 50% 안에서만 고름)', barbell(m, 1, gainR, { pool: 0.5 }));
      A('B 대박 칸 조건', '점수 3 + 대박 1(손실 위험 상위 30%는 뺌)', barbell(m, 1, gainR, { veto: 0.3 }));
      A('C 대박 칸 2개', '점수 2 + 대박 2', barbell(m, 2, gainR));
      A('D 대조', '점수 3 + 무작위 1(대박 효과가 아니라 분산 효과인지)', barbell(m, 1, rndR));
      A('D 대조', '점수 2 + 무작위 2', barbell(m, 2, rndR));
      A('E 5종목', '점수 4 + 대박 1 (5종목)', barbell(m, 1, gainR), { nFn: () => 5 });
    });
    posts.push(() => post12('21-', '21 바벨 구성'));
  }

  if (posts.length) AD8.ad9post = () => posts.forEach(f => f());


  function post11() {                                                          // 11 묶음: 해마다 기준을 이긴 횟수·3구간 연평균
    const base = V[0], yrs = YEARS_ALL.filter(y => y < 2026), n = yrs.length;
    log(''); log(`## 11 일관성 점검 — 해마다 기준(A)보다 높았던 해 수(${yrs[0]}~${yrs[n - 1]} ${n}년, 2026은 진행 중이라 뺌) · 3구간 연평균`);
    log('방식                                                         이긴 해   2012~16   2017~21   2022~26   전체    낙폭');
    const seg = (v, a, b) => pc(cagrOver(v.full.yearly, YEARS_ALL.filter(y => y >= a && y <= b)));
    V.forEach(v => { if (!v.full || !v.full.yearly) return; const w = yrs.filter(y => (v.full.yearly[y] ?? 0) > (base.full.yearly[y] ?? 0)).length;
      log(`${v.name.slice(0, 50).padEnd(50)} ${String(v === base ? '-' : w + '/' + n).padStart(7)}  ${seg(v, 2012, 2016).padStart(8)}  ${seg(v, 2017, 2021).padStart(8)}  ${seg(v, 2022, 2026).padStart(8)}  ${pc(v.full.cagr).padStart(7)}  ${pc(v.full.mdd).padStart(7)}`); });
  }


  function post12(prefix = '12-', title = '12 판매 기준 이평 파고들기') {                                                          // 12 묶음: 거래 통계(횟수·보유 기간·승률) · 해마다 이긴 해 · 3구간 · 3·5년 창 분포
    const mine = V.filter((v, i) => i === 0 || String(v.sec).startsWith(prefix)), base = V[0], yrs = YEARS_ALL.filter(y => y < 2026), n = yrs.length;
    const runLog = v => simulate(ym => v.cand(ym).slice(0, 4), 4, v.C || C1, { ...simOpt(v.rule, v.o || {}), cand: v.cand, log: true }, v.dep != null ? v.dep : DEP);
    log(''); log(`## ${title} — 거래 통계 (전체 기간, 월 100만원)`);
    log('방식                                                       거래 수  평균 보유(월)  이긴 거래  평균 수익  중앙값    연평균');
    const stats = [];
    mine.forEach(v => { safe('12 통계', () => {
      const sm = runLog(v), tr = (sm.trades || []).filter(t => t.ret != null && t.buyYm && t.sellYm);
      const hold = tr.map(t => mi(t.sellYm) - mi(t.buyYm)), rets = tr.map(t => t.ret), arr = sm.rets.filter(x => !x.partial).map(x => x.r);
      stats.push({ v, arr });
      log(`${v.name.slice(0, 50).padEnd(50)} ${String(tr.length).padStart(7)}  ${mean(hold).toFixed(1).padStart(11)}  ${(rets.filter(x => x > 0).length / rets.length * 100).toFixed(0).padStart(7)}%  ${pc(mean(rets)).padStart(8)}  ${pc(pctl(rets, 0.5)).padStart(7)}  ${pc(cagrOf(arr)).padStart(7)}`);
    }); });
    log(''); log(`## ${title} 해마다 기준(A)보다 높았던 해 수(${yrs[0]}~${yrs[n - 1]} ${n}년) · 3구간 연평균`);
    log('방식                                                         이긴 해   2012~16   2017~21   2022~26   전체    낙폭');
    const seg = (v, a, b) => pc(cagrOver(v.full.yearly, YEARS_ALL.filter(y => y >= a && y <= b)));
    mine.forEach(v => { if (!v.full || !v.full.yearly) return; const w = yrs.filter(y => (v.full.yearly[y] ?? 0) > (base.full.yearly[y] ?? 0)).length;
      log(`${v.name.slice(0, 50).padEnd(50)} ${String(v === base ? '-' : w + '/' + n).padStart(7)}  ${seg(v, 2012, 2016).padStart(8)}  ${seg(v, 2017, 2021).padStart(8)}  ${seg(v, 2022, 2026).padStart(8)}  ${pc(v.full.cagr).padStart(7)}  ${pc(v.full.mdd).padStart(7)}`); });
    log(''); log(`## ${title} 어느 달에 시작해도? — 3·5년 창 연평균(최소 · 10% · 중앙, 월 수익률 창 기준; 기준 + 연평균 높은 8개)`);
    const pickW = prefix === '13-' ? [stats[0], ...stats.filter(x => /^한국 [567]이평 · 미국 10이평$|^5이평 · 12묶음|^한국 5이평\(미국 10이평\) \+ 남는 현금 S&P500$/.test(x.v.name))] : prefix === '12-' ? stats.filter(x => x.v === base || /^판매 기준 (3|5|7|9)이평|^5이평 · 유예 2달\+금리$|^5이평 \+ 남는 현금/.test(x.v.name)).slice(0, 8) : [stats[0], ...stats.slice(1).sort((a, b) => (b.v.full.cagr || -9) - (a.v.full.cagr || -9)).slice(0, 8)].filter(Boolean);
    pickW.forEach(({ v, arr }) => {
      [36, 60].forEach(L => { const a = []; for (let i = 0; i + L <= arr.length; i++) a.push(cagrOf(arr.slice(i, i + L))); if (a.length) log(`${v.name.slice(0, 42).padEnd(42)} ${L / 12}년 창 ${a.length}개: 최소 ${pc(Math.min(...a))} · 10% ${pc(pctl(a, 0.1))} · 중앙 ${pc(pctl(a, 0.5))} · 0% 미만 ${(a.filter(x => x < 0).length / a.length * 100).toFixed(0)}%`); });
    });
  }

  // ─────────────── 묶음 9·2 보고용 도구
  const baseSim = (extra = {}) => { const v = V[0], o = simOpt(v.rule, v.o || {}); return simulate(ym => v.cand(ym).slice(0, 4), 4, C1, { ...o, cand: v.cand, log: true, ...extra }); };
  const twr = a => a.reduce((p, x) => p * (1 + x), 1);
  const cagrOf = a => Math.pow(twr(a), 12 / a.length) - 1;
  const mddOf = a => { let idx = 1, pk = 1, dd = 0; a.forEach(x => { idx *= 1 + x; pk = Math.max(pk, idx); dd = Math.min(dd, idx / pk - 1); }); return dd; };
  const underwater = a => { let idx = 1, pk = 1, cur = 0, mx = 0; a.forEach(x => { idx *= 1 + x; if (idx >= pk) { pk = idx; cur = 0; } else { cur++; mx = Math.max(mx, cur); } }); return mx; };
  const rng = seed => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const distLine = (nm, a, f) => log(`${nm.padEnd(38)} 최소 ${f(Math.min(...a))} · 10% ${f(pctl(a, 0.1))} · 중앙 ${f(pctl(a, 0.5))} · 90% ${f(pctl(a, 0.9))} · 최대 ${f(Math.max(...a))}`);
  const safe = (nm, f) => { try { f(); } catch (e) { log(`(${nm} 오류: ${String((e && e.message) || e).slice(0, 80)})`); } };

  function post9() {
    const sm = baseSim(), rets = sm.rets.filter(x => !x.partial), arr = rets.map(x => x.r);
    log(''); log(`## 9 검증 — 기준 규칙의 월 수익률 ${arr.length}개월(전체 연평균 ${pc(cagrOf(arr))}, 최대 낙폭 ${pc(mddOf(arr))}, 최장 물속 ${underwater(arr)}개월)`);
    safe('94·95 시작 시점·기간별 분포', () => {
      log('[94·95] 어느 달에 시작해도 N년 뒤 연평균은? (기준 규칙의 월 수익률을 N년 창으로 잘라 본 분포, 시작 달만 다름)');
      [36, 60, 120].forEach(L => { const a = []; for (let i = 0; i + L <= arr.length; i++) a.push(cagrOf(arr.slice(i, i + L))); if (a.length) { distLine(`${L / 12}년 창(${a.length}개)`, a, pc); log(`${''.padEnd(38)} 연평균이 0% 미만인 창 ${(a.filter(x => x < 0).length / a.length * 100).toFixed(0)}% · 10% 미만 ${(a.filter(x => x < 0.1).length / a.length * 100).toFixed(0)}%`); } });
    });
    safe('97 순서 섞기', () => {
      const R = rng(7), res = [], uw = [];
      for (let t = 0; t < 10000; t++) { const b = [...arr]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } res.push(mddOf(b)); uw.push(underwater(b)); }
      log(`[97] 월 수익 순서를 1만 번 섞으면: 최대 낙폭 중앙 ${pc(pctl(res, 0.5))} · 최악 10% ${pc(pctl(res, 0.1))} · 최악 1% ${pc(pctl(res, 0.01))} / 최장 물속 중앙 ${pctl(uw, 0.5)}개월 · 90% ${pctl(uw, 0.9)}개월 · 실제 ${pc(mddOf(arr))} · ${underwater(arr)}개월`);
    });
    safe('98 신뢰구간', () => {
      const R = rng(11), res = [], B = 12, nb = Math.ceil(arr.length / B);
      for (let t = 0; t < 5000; t++) { const b = []; for (let q = 0; q < nb; q++) { const s0 = Math.floor(R() * (arr.length - B + 1)); for (let i = 0; i < B; i++) b.push(arr[s0 + i]); } res.push(cagrOf(b.slice(0, arr.length))); }
      log(`[98] 12개월 덩어리로 다시 뽑은 연평균(5천 번): 5% ${pc(pctl(res, 0.05))} · 중앙 ${pc(pctl(res, 0.5))} · 95% ${pc(pctl(res, 0.95))} (실제 ${pc(cagrOf(arr))})`);
    });
    safe('99~101 시장 상태별', () => {
      const grp = (nm, test) => { const a = rets.filter(x => test(x.k) === true).map(x => x.r), b = rets.filter(x => test(x.k) === false).map(x => x.r);
        const f = x => x.length ? `${x.length}개월 · 월평균 ${pc(mean(x))} · 연환산 ${pc(Math.pow(1 + mean(x), 12) - 1)} · 이긴 달 ${(x.filter(v => v > 0).length / x.length * 100).toFixed(0)}%` : '없음';
        log(`${nm.padEnd(40)} 참: ${f(a)} | 거짓: ${f(b)}`); };
      log('[99] 시장 상태(앞달 말 기준)별 월 수익:');
      grp('S&P500이 10이평 위', k => { const v = idxBelow('sp', k - 1); return v == null ? null : !v; });
      grp('코스피가 10이평 위', k => { const v = idxBelow('ks', k - 1); return v == null ? null : !v; });
      grp('S&P500 12개월 수익률 > 0', k => { const a = idxAt('sp', k - 1), b = idxAt('sp', k - 13); return a && b ? a > b : null; });
      grp('S&P500 12개월 수익률 > +15%', k => { const a = idxAt('sp', k - 1), b = idxAt('sp', k - 13); return a && b ? a / b - 1 > 0.15 : null; });
      log('[100] 금리 상태별:'); grp('국채10년 금리 오르는 중', k => rateJ(k - 1));
      log('[101] 환율 상태별:'); grp('원화 약세(12개월 환율 상승)', k => { const a = fx(k - 1), b = fx(k - 13); return a && b ? a > b : null; });
    });
    safe('102 앞뒤 경계', () => {
      const yearly = {}; rets.forEach(x => { const Y = Math.floor(ymOf(x.k) / 100); yearly[Y] = (yearly[Y] || 1) * (1 + x.r); }); Object.keys(yearly).forEach(y => { yearly[y] -= 1; });
      log('[102] 앞·뒤 구간 경계를 바꿔 본 연평균(기준 규칙):');
      [2017, 2019, 2021].forEach(B => log(`  ~${B}년 ${pc(cagrOver(yearly, YEARS_ALL.filter(y => y <= B)))}  |  ${B + 1}년~ ${pc(cagrOver(yearly, YEARS_ALL.filter(y => y > B)))}`));
    });
    safe('103 상위 거래 몫', () => {
      const led = sm.ledger, byY = {};
      led.forEach((m, ym) => (m.sells || []).forEach(s => { const Y = Math.floor(ym / 100), p = s.amt - s.basis; (byY[Y] = byY[Y] || []).push(p); }));
      log('[103] 연도별 실현 이익에서 상위 3거래가 차지하는 몫(이익 낸 거래들 합 대비, 제거가 아니라 몫만):');
      Object.keys(byY).sort().forEach(Y => { const g = byY[Y].filter(x => x > 0).sort((a, b) => b - a), tot = g.reduce((a, b) => a + b, 0); if (tot > 0) log(`  ${Y}  이익 거래 ${g.length}건 · 상위 3거래 몫 ${(g.slice(0, 3).reduce((a, b) => a + b, 0) / tot * 100).toFixed(0)}%`); });
      const all = Object.values(byY).flat().filter(x => x > 0).sort((a, b) => b - a), T = all.reduce((a, b) => a + b, 0);
      log(`  전체  이익 거래 ${all.length}건 · 상위 3거래 ${(all.slice(0, 3).reduce((a, b) => a + b, 0) / T * 100).toFixed(0)}% · 상위 10거래 ${(all.slice(0, 10).reduce((a, b) => a + b, 0) / T * 100).toFixed(0)}% · 상위 10%(${Math.ceil(all.length / 10)}건) ${(all.slice(0, Math.ceil(all.length / 10)).reduce((a, b) => a + b, 0) / T * 100).toFixed(0)}%`);
    });
    safe('104 회복 기간', () => {
      const eq = []; let idx = 1; arr.forEach(x => { idx *= 1 + x; eq.push(idx); });
      let pk = 0, worst = 0, ws = 0, we = 0, pkI = 0;
      eq.forEach((v, i) => { if (v >= eq[pkI]) pkI = i; const dd = v / eq[pkI] - 1; if (dd < worst) { worst = dd; ws = pkI; we = i; } });
      let rec = null; for (let i = we; i < eq.length; i++) if (eq[i] >= eq[ws]) { rec = i - ws; break; }
      log(`[104] 최대 낙폭 ${pc(worst)}: 고점 뒤 ${we - ws}개월에 바닥, 고점 회복까지 ${rec == null ? '아직 못 함' : rec + '개월(고점 기준)'}`);
    });
    safe('96 점수 재학습 흔들림', () => {
      const res = [];
      for (let sd = 1; sd <= 10; sd++) {
        const m2 = rescore({ subsample: { seed: sd, frac: 0.85 } }), old = scored[kA]; scored[kA] = m2; let pm; try { pm = mk({ ck: 'jit' + sd }); } finally { scored[kA] = old; }
        const o = simOpt(rule10, {}), cd = candOf(pm); res.push(summ(simulate(ym => cd(ym).slice(0, 4), 4, C1, { ...o, cand: cd })).cagr);
      }
      log(`[96] 점수를 학습 자료 85%만 무작위로 써서 10번 다시 학습(같은 규칙): 연평균 최소 ${pc(Math.min(...res))} · 중앙 ${pc(pctl(res, 0.5))} · 최대 ${pc(Math.max(...res))} · 표준편차 ${pc(sdOf(res))} (기준 ${pc(cagrOf(arr))})`);
    });
    safe('25 무작위 순위', () => {
      const res = [], o = simOpt(rule10, {});
      for (let sd = 1; sd <= 100; sd++) {
        const cd = ym => { const a = [...(mBase.get(ym) || [])]; return a.map(e => [e, hash01(e.r.y + '|' + ym + '|' + sd)]).sort((x, y) => x[1] - y[1]).map(x => x[0]); };
        res.push(summ(simulate(ym => cd(ym).slice(0, 4), 4, C1, { ...o, cand: cd })).cagr);
      }
      const better = res.filter(x => x >= cagrOf(arr)).length;
      log(`[25] 같은 후보에서 순위를 무작위로 100번 섞은 연평균: 최소 ${pc(Math.min(...res))} · 10% ${pc(pctl(res, 0.1))} · 중앙 ${pc(pctl(res, 0.5))} · 90% ${pc(pctl(res, 0.9))} · 최대 ${pc(Math.max(...res))} / 점수 순(기준) ${pc(cagrOf(arr))} → 무작위 중 기준 이상 ${better}/100번`);
    });
  }

  function post10(U, members) {
    const sm = baseSim(), rets = sm.rets.filter(x => !x.partial), arr = rets.map(x => x.r), ks = rets.map(x => x.k);
    log(''); log(`## 10 다른 전략과 비교 — 기준 규칙 연평균 ${pc(cagrOf(arr))} · 낙폭 ${pc(mddOf(arr))} (같은 달 구간 ${ymOf(ks[0])}~${ymOf(ks[ks.length - 1])}, 모두 월 수익률 복리 기준)`);
    const line = (nm, a) => log(`${nm.padEnd(46)} 연평균 ${pc(cagrOf(a)).padStart(7)} · 낙폭 ${pc(mddOf(a)).padStart(7)}`);
    safe('107 지수 이평 타이밍', () => {
      [['ks', '코스피', 0.001], ['sp', 'S&P500(원화 환산)', 0.0035], ['nq', '나스닥100(원화 환산)', 0.0035]].forEach(([key, nm, cost]) => {
        const rk = k => { const a = idxAt(key, k), b = idxAt(key, k - 1); return a && b ? (key === 'ks' ? a / b : (a * fx(k)) / (b * fx(k - 1))) - 1 : 0; };
        const bh = ks.map(rk); line(`${nm} 그냥 보유`, bh);
        let pos = false; const tm = ks.map(k => { const want = idxBelow(key, k - 1) === false; let r = want ? rk(k) : 0; if (want !== pos) { r -= cost; pos = want; } return r; });
        line(`${nm}: 10이평 위면 보유·아래면 현금`, tm);
      });
    });
    safe('109 전략+지수 50:50', () => {
      const sp = ks.map(k => { const a = idxAt('sp', k), b = idxAt('sp', k - 1); return a && b ? (a * fx(k)) / (b * fx(k - 1)) - 1 : 0; });
      line('전략 50% + S&P500(원화) 50% (매월 재조정)', arr.map((x, i) => 0.5 * x + 0.5 * sp[i]));
      const kp = ks.map(k => { const a = idxAt('ks', k), b = idxAt('ks', k - 1); return a && b ? a / b - 1 : 0; });
      line('전략 50% + 코스피 50% (매월 재조정)', arr.map((x, i) => 0.5 * x + 0.5 * kp[i]));
    });
    safe('110 범위 전체 동일 비중', () => {
      const a = ks.map(k => { const m = members(k - 1), r = []; for (const s of m) { const c1 = s.cl.get(k), c0 = s.cl.get(k - 1); if (c1 > 0 && c0 > 0) r.push(c1 / c0 - 1); } return r.length ? mean(r) : 0; });
      line('시총 상위 범위 전체 종목 동일 비중(비용 없음, 생존 편향 포함)', a);
    });
    safe('111 같은 기간 무작위 종목', () => {
      const tr = (sm.trades || []).filter(t => t.ret != null && t.buyYm && t.sellYm), R = rng(5), strat = [], rnd = [];
      const sims = [];
      for (let it = 0; it < 200; it++) {
        const v = [];
        tr.forEach(t => {
          const kb = mi(t.buyYm), ksl = mi(t.sellYm), m = members(kb - 1); if (!m.length) return;
          for (let q = 0; q < 8; q++) { const s = m[Math.floor(R() * m.length)], a = s.cl.get(kb), b = s.cl.get(ksl); if (a > 0 && b > 0) { v.push(b / a - 1); break; } }
        });
        sims.push(mean(v));
      }
      tr.forEach(t => { const a = t.buyPx, b = t.sellPx; if (a > 0 && b > 0) strat.push(b / a - 1); });
      log(`[111] 같은 거래 수(${tr.length})·같은 보유 기간에 무작위 종목을 샀다면 평균 거래 수익(총수익, 비용 제외) 중앙 ${pc(pctl(sims, 0.5))} (10%~90% ${pc(pctl(sims, 0.1))}~${pc(pctl(sims, 0.9))}) / 전략 거래 평균 ${pc(mean(strat))}, 중앙값 ${pc(pctl(strat, 0.5))}`);
    });
  }
}

// 그 시점 시총 상위 범위(3_build.js UNIVERSE=cap과 같은 방식: 그 달 종가 × 오늘 주식 수 근사, 코스피 300·코스닥 200·미국 500) — 10번 묶음의 단순 전략용
let UNI = null;
function universe() {
  if (UNI) return UNI;
  const ctxRaw = module.exports._ctx;
  const { fs, path, DATA, RAW, mi } = ctxRaw;
  const list = JSON.parse(fs.readFileSync(path.join(DATA, 'lists.json'), 'utf8')), CAPN = { KOSPI: 300, KOSDAQ: 200, US: 500 };
  const syms = [], byKey = new Map();
  for (const s of list) {
    if (!(s.cap > 0)) continue;
    let arr; try { arr = JSON.parse(fs.readFileSync(path.join(RAW, s.y.replace(/[^A-Za-z0-9.\-]/g, '_') + '.json'))); } catch (e) { continue; }
    const cl = new Map(); let last = 0; arr.forEach(b => { if (b[4] > 0) { cl.set(mi(b[0]), b[4]); last = b[4]; } });
    if (!last) continue;
    const grp = s.mk === 'US' ? 'US' : s.mk, o = { y: s.y, grp, cap: s.cap, cl, last, etf: s.type === 'etf' };
    syms.push(o);
    cl.forEach((cv, k) => { const key = k + '|' + grp; (byKey.get(key) || byKey.set(key, []).get(key)).push(s.cap * cv / last); });
  }
  const th = new Map(); byKey.forEach((a, key) => { const N = CAPN[key.split('|')[1]]; if (N) { a.sort((x, y) => y - x); th.set(key, a[Math.min(N, a.length) - 1]); } });
  UNI = { syms, th, members: k => syms.filter(s => { const cv = s.cl.get(k), t = th.get(k + '|' + s.grp); return cv > 0 && t !== undefined && s.cap * cv / s.last >= t; }) };
  return UNI;
}

module.exports = { build: (c, which) => { module.exports._ctx = c; return build(c, which); } };
