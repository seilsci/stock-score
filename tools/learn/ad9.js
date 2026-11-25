'use strict';
// ad9.js — 시험 목록 전체(122개 중 지금 자료로 되는 것) 묶음. 7_backtest.js의 STAGE14 안에서 AD9=1~10(쉼표로 여러 개) 또는 all 로 부름.
//   기준(A) = 지금 규칙(확인 매수 + 익절 2배 트레일 + 유예 2달 + 국채10년 금리, 상위 4, 월 100만원, 시총 기준 events.csv).
//   묶음: 1 매수 신호 · 2 순위 · 3 점수 모델 · 4 비중·구성 · 5 매도 · 6 자금·비용·세금 · 7 체결·시점 · 8 종목 범위 · 9 검증 · 10 다른 전략과 비교
//   결과는 7_backtest.js의 "확인 매수 후속 ..." 표로 나오고(전체·앞쪽·뒤쪽·낙폭·절반 되풀이), 9·10과 2의 일부는 따로 "## ..." 보고가 붙음.
//   한 시험이 오류여도 나머지는 계속 돌고 이름 끝에 [오류: ...]가 붙음. 일봉·새 자료가 필요한 것은 여기에 없음(README-PC.md 참고).

function build(c, which) {
  const { V, AD8, pool, simulate, simOpt, summ, C1, DEP, mi, ymOf, px, fx, ma10, maAtN, F, fi, US, TURN, ETF, hash01, rateJ, MACRO, scored, kA, byYm, CO_NAME, chg,
    YEARS_ALL, log, cagrOver, END, rescore, ALL, MK, divOf, fs, path, DATA, RAW } = c;
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

  // ═════ 묶음 3: 점수 모델 (학습 방식 바꾸기) — 해마다 그 전까지 알던 것만으로 다시 학습
  if (on(3)) {
    const S = n => `3-${n}`;
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

  if (posts.length) AD8.ad9post = () => posts.forEach(f => f());


  function post11() {                                                          // 11 묶음: 해마다 기준을 이긴 횟수·3구간 연평균
    const base = V[0], yrs = YEARS_ALL.filter(y => y < 2026), n = yrs.length;
    log(''); log(`## 11 일관성 점검 — 해마다 기준(A)보다 높았던 해 수(${yrs[0]}~${yrs[n - 1]} ${n}년, 2026은 진행 중이라 뺌) · 3구간 연평균`);
    log('방식                                                         이긴 해   2012~16   2017~21   2022~26   전체    낙폭');
    const seg = (v, a, b) => pc(cagrOver(v.full.yearly, YEARS_ALL.filter(y => y >= a && y <= b)));
    V.forEach(v => { if (!v.full || !v.full.yearly) return; const w = yrs.filter(y => (v.full.yearly[y] ?? 0) > (base.full.yearly[y] ?? 0)).length;
      log(`${v.name.slice(0, 50).padEnd(50)} ${String(v === base ? '-' : w + '/' + n).padStart(7)}  ${seg(v, 2012, 2016).padStart(8)}  ${seg(v, 2017, 2021).padStart(8)}  ${seg(v, 2022, 2026).padStart(8)}  ${pc(v.full.cagr).padStart(7)}  ${pc(v.full.mdd).padStart(7)}`); });
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
