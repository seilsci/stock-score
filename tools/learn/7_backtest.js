// 7단계: 월 100만원 적립 투자 시뮬레이션 → data/backtest.txt
// 매달 말 입금 → 그달 매수 신호 중 고른 종목에 균등 매수 → 월말 종가가 10이평 아래면 매도 → 현금은 다음 달 재투자
// 연도별 수익률 = 그해 마지막 거래일(12월 월봉 종가) 기준 시간가중(입금액 영향 제외), 누적 = 곱
const { fs, path, DATA, RAW, progress } = require('./common');
const { prep, z, fitRidge, score } = require('./ml');
const { load, trainSet, trainSetL, modelDefs } = require('./data');
const GBM = require('./gbm');
const { F, L: ALL } = load(), fi = n => F.indexOf(n);
// 재무 지표(미국, SEC 공시; fund.js): 있으면 신호마다 "그 시점에 이미 공시된 값만"으로 계산해 지표 끝에 붙임(이름 f_*). 한국은 아직 자료가 없어 빈 값.
const FUND = { on: false, cover: 0, us: 0 };
if (process.env.FUND !== '0' && fs.existsSync(path.join(DATA, 'sec'))) {
  const Fu = require('./fund');
  const iUS = F.indexOf('us');
  F.push(...Fu.NAMES.map(n => 'f_' + n));
  ALL.forEach(r => { const o = r.x[iUS] === 1 ? Fu.featuresAt(r.y, r.ym) : null; if (r.x[iUS] === 1) FUND.us++; if (o) FUND.cover++; Fu.NAMES.forEach(n => r.x.push(o ? o[n] : NaN)); });
  FUND.on = FUND.cover > 0;
}
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
// 배당(백테스트 전용, 사이트에는 안 씀): data/div/<종목>.json [[배당락일(초), 주당 배당금], ...](2f_div.js) → 종목별 월(k)별 주당 배당 합계
const DIVC = new Map();
// 일봉(백테스트 전용): data/daily/<종목>.json.gz {d,l,c}(2g_daily.js) → {d,l,c,cs(종가 누적합),month:Map(k→[시작,끝) 인덱스)}. 없으면 null
const DAYC = new Map();
function dailyOf(y) {
  if (DAYC.has(y)) return DAYC.get(y);
  let D = null;
  try {
    D = JSON.parse(require('zlib').gunzipSync(fs.readFileSync(path.join(DATA, 'daily', y.replace(/[^A-Za-z0-9.\-]/g, '_') + '.json.gz'))).toString());
    if (!D.d.length) D = null;
    else {
      D.cs = new Float64Array(D.c.length + 1); D.c.forEach((v, i) => { D.cs[i + 1] = D.cs[i] + v; });
      D.month = new Map(); D.d.forEach((dd, i) => { const kk = mi(Math.floor(dd / 100)), m = D.month.get(kk); if (m) m[1] = i + 1; else D.month.set(kk, [i, i + 1]); });
    }
  } catch (e) { D = null; }
  DAYC.set(y, D); return D;
}
function divOf(y, k) {
  let m = DIVC.get(y);
  if (!m) {
    m = new Map();
    try {
      JSON.parse(fs.readFileSync(path.join(DATA, 'div', y.replace(/[^A-Za-z0-9.\-]/g, '_') + '.json'), 'utf8')).forEach(([ts, a]) => {
        const d = new Date((ts + (/\.(KS|KQ)$/.test(y) ? 9 * 3600 : 0)) * 1000), kk = mi(d.getUTCFullYear() * 100 + d.getUTCMonth() + 1);
        m.set(kk, (m.get(kk) || 0) + a);
      });
    } catch (e) {}
    DIVC.set(y, m);
  }
  return m.get(k) || 0;
}
const now = new Date(), CUR = now.getFullYear() * 100 + now.getMonth() + 1;
const START = mi((START_Y - 1) * 100 + 12), END = mi(CUR) - 1;
const yOfK = k => Math.floor((k - 1) / 12);

// ── 가격(월말 종가)·환율
const PXC = new Map();
const rawFile = y => path.join(RAW, y.replace(/[^A-Za-z0-9.\-]/g, '_') + '.json');
function px(y) {
  let o = PXC.get(y); if (o) return o;
  o = { m: new Map(), op: new Map(), hi: new Map(), lo: new Map(), vol: new Map(), lastK: 0, lastC: 0 };
  try { JSON.parse(fs.readFileSync(rawFile(y))).forEach(b => { if (b[4] > 0) { const k = mi(b[0]); o.m.set(k, b[4]); if (b[1] > 0) o.op.set(k, b[1]); if (b[2] > 0) o.hi.set(k, b[2]); if (b[3] > 0) o.lo.set(k, b[3]); if (b[5] > 0) o.vol.set(k, b[5]); if (k >= o.lastK) { o.lastK = k; o.lastC = b[4]; } } }); } catch (e) {}
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
// 첫날 시가(시험용): data/first/<종목>.json = [[ym, 시가, 종가], ...]
const FDO = new Map();
function fdOpen(y, k) {
  let m = FDO.get(y);
  if (!m) { m = new Map(); try { JSON.parse(fs.readFileSync(path.join(DATA, 'first', y.replace(/[^A-Za-z0-9.\-]/g, '_') + '.json'))).forEach(b => { if (b[1] > 0) m.set(mi(b[0]), b[1]); }); } catch (e) {} FDO.set(y, m); }
  return m.get(k);
}
const hash01 = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
const maAtN = (o, k, n) => { let s = 0; for (let j = k; j > k - n; j--) { const p = o.m.get(j); if (p === undefined) return null; s += p; } return s / n; };
const FXFLAT = (() => { try { return fx(mi(START_Y * 100 + 1)); } catch (e) { return 1; } })();       // 환율 효과 빼기 시험: 시작 시점 환율로 고정
const US = fi('us'), TURN = fi('turn'), ETF = fi('etf');
const MAN = +process.env.MA_N || 10;                                  // 이동평균 길이(달), 3_build.js와 같게
const ma10 = (o, k) => { let s = 0; for (let j = k; j > k - MAN; j--) { const p = o.m.get(j); if (p === undefined) return null; s += p; } return s / MAN; };
// 거시 지표 (ff_chg12 등) — ymOf(k) → ym 형태로 lookup
let MACRO = {}; try { MACRO = JSON.parse(fs.readFileSync(path.join(DATA, 'macro.json'))); } catch (e) {}
const ffChg12 = k => { const m = MACRO[ymOf(k)]; return m && m.ff_chg12 != null ? m.ff_chg12 : null; };
// 일지·장부가 쓰는 금리 판단(2026-11-25 채택): 미국 국채 10년 금리(그 달 마지막 거래일 값)가 6개월 전 달말보다 높으면 "금리 상승 중" → 유예 없이 즉시 매도. data/rates.json(2e_rates.js)이 없으면 예전 규칙(기준금리 12개월 변화)으로 대신함
let RATES_J = null; try { RATES_J = JSON.parse(fs.readFileSync(path.join(DATA, 'rates.json'))); } catch (e) { console.log('※ data/rates.json 없음(2e_rates.js): 금리 판단을 예전 규칙(기준금리 12개월 변화)으로 대신함'); }
const rateJ = k => { if (!RATES_J) { const f = ffChg12(k); return f == null ? null : f > 0; } const a = (RATES_J[ymOf(k)] || {}).dgs10, b = (RATES_J[ymOf(k - 6)] || {}).dgs10; return a != null && b != null ? a > b : null; };
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
// 점수 모델 선택: SCORE_MODEL=gbm이면 점수 모델 'A'(점수 상위 N·매매일지·장부)를 트리 모델(gbm.js)로 바꿈. 해마다 그 전까지 알던 정답(첫날 진입 + 지금 판매 규칙 수익)만으로 학습, 씨앗 3개 평균, 지수 지표 제외(사이트 계산과 같은 입력)
const SCORE_MODEL = process.env.SCORE_MODEL || 'ridge';
const scoredRidgeA = scored[KA0];
if (SCORE_MODEL === 'gbm') {
  const SLg = require('./strat'), noidx = modelDefs(F).PRICE.filter(j => !F[j].startsWith('idx_'));
  const labsG = ALL.map(r => SLg.label(r.y, r.ym, { entry: 'fd', tp: 2, grace: 2, rate: true }, END)), gm = new Map();
  years.forEach((Y, yi) => {
    progress('트리 점수', yi / years.length);
    const tr0 = trainSetL(ALL, labsG, Y, 12), te = ALL.filter(r => Math.floor(r.ym / 100) === Y);
    if (tr0.length < 500 || !te.length) return;
    const ms = [1, 2, 3].map(sd => GBM.fit(tr0.map(r => r.x), tr0.map(r => clipT(r.t)), noidx, { seed: sd }));
    te.forEach(r => { let v = 0; ms.forEach(M => { v += GBM.predict(M, r.x); }); const a = gm.get(r.ym) || []; a.push({ r, s: v / ms.length }); gm.set(r.ym, a); });
  });
  gm.forEach(a => a.sort((x, y) => y.s - x.s));
  scored[KA0] = gm; progress('트리 점수', 1); process.stdout.write('\n');
}

// ── 매도 유예 모델: 매도 신호(종가<10이평) 달의 가격 지표 → 3개월 뒤 수익 예측 → 높으면 유예
// 매도 신호 이벤트를 원시 월봉에서 직접 생성 (종가·이평만으로 계산 가능한 가격 지표 사용)
const sellEvents = [];
const listAll = JSON.parse(fs.readFileSync(path.join(DATA, 'lists.json')));
for (const s of listAll) {
  const o = px(s.y); if (o.m.size < 25) continue;
  const ks = [...o.m.keys()].sort((a, b) => a - b), cs = ks.map(k => o.m.get(k)), n = cs.length;
  const ma = cs.map((_, i) => i >= MAN - 1 ? avg(cs, i - MAN + 1, i) : null);
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

// 같은 회사 판별(보통주·우선주, Class A/B/C, 환헤지 ETF 등): 이름에서 괄호·Class·우선주 꼬리를 떼어 같으면 한 회사로 봄 (opt.oneCo 시험용)
const CO_NAME = new Map(); try { JSON.parse(fs.readFileSync(path.join(DATA, 'lists.json'))).forEach(x => CO_NAME.set(x.y, x.name)); } catch (e) {}
function coKey(y) {
  let n = CO_NAME.get(y); if (!n) return y;
  n = n.replace(/\s*\(.*?\)\s*/g, '').replace(/\s*(ADR|ADS)\s*$/, '').replace(/\s*(Class|클래스)\s*[A-C]\s*$/, '').replace(/\s+[A-C]$/, '');      // ADR·ADS는 한국 상장 원주와 같은 회사(SK하이닉스·SK텔레콤·KT·한국전력·우리금융지주)
  if (/[가-힣]/.test(n)) n = n.replace(/(우선주|2우B|3우B|우B|우C|우)$/, '');
  return n.trim() || y;
}
// ── 시뮬레이션
function krTax(C, Y) { const t = C.kr.sell_tax, nm = x => x < 10000 ? x * 100 + 1 : x, yy = Y < 10000 ? Y * 100 + 12 : Y; let v = 0; Object.keys(t).map(Number).sort((a, b) => nm(a) - nm(b)).forEach(y => { if (nm(y) <= yy) v = t[y]; }); return v; }     // 키: 연도(YYYY, 그 해 1월부터) 또는 연월(YYYYMM, 그 달 말 매도부터). Y: 연도 또는 연월
function simulate(pickFn, N, C, opt = {}, dep = DEP) {
  // opt.tp: 익절 배수 (종가 ≥ 매수가 × tp 이면 다음달 매도). opt.tpSame: true면 당월 즉시 매도.
  let cash = 0, holds = [], prevAfter = 0, deposits = 0; const rets = [], usGain = {}, krGain = {}, banUntil = new Map();
  const fxf = opt.fxFlat ? (() => FXFLAT) : fx;
  const trades = opt.log ? [] : null;                     // 거래 기록 (opt.log=true일 때만)
  const snapshots = opt.log ? new Map() : null;           // ym → 보유 종목 스냅샷
  const led = opt.log ? new Map() : null;                 // ym → 그달 입금·매도·세금·매수·못 산 종목·월말 현금(매매일지 장부)
  let cur = null;                                         // 지금 처리 중인 달의 장부
  const usFee = C.us.commission + C.us.fx_spread, val = (h, k) => (h.deadK && k >= h.deadK) ? 0 : h.sh * h.last * (h.us ? fxf(k) : 1);
  const sellCash = (h, k, reason) => {                   // 한 종목을 팔아 현금으로: 수수료·거래세·(미국) 손익 기록
    const v = val(h, k);
    if (opt.banMonths && !h._part) banUntil.set(h.y, k + opt.banMonths);
    let got, taxR = 0;
    if (h.us) { const pr = v * (1 - usFee), Y = yOfK(k); usGain[Y] = (usGain[Y] || 0) + pr - h.basis; got = pr; }
    else { taxR = (h.etf && C.kr.etf_exempt ? 0 : krTax(C, ymOf(k))); got = v * (1 - C.kr.commission - taxR); if (opt.krGainTax) krGain[yOfK(k)] = (krGain[yOfK(k)] || 0) + got - h.basis; }
    if (cur) cur.sells.push({ y: h.y, buyYm: h.buyYm, us: h.us, sh: h.sh, px: h.last, fx: h.us ? fxf(k) : null, gross: v,
      feeRate: h.us ? usFee : C.kr.commission, fee: v * (h.us ? usFee : C.kr.commission), taxRate: taxR, tax: v * taxR,
      amt: got, basis: h.basis, ret: got / h.basis - 1, reason: reason || 'ma10' });
    if (trades && h.buyYm) trades.push({ y: h.y, buyYm: h.buyYm, sellYm: ymOf(k), buyPx: h.buyPx, sellPx: h.last,
      ret: got / h.basis - 1, score: h.buyScore, feats: h.buyFeats, reason: reason || 'ma10' });
    if (opt.splitN > 1) soldAt.set(k, (soldAt.get(k) || 0) + got);           // 나눠 넣기 시험: 그달 판 돈 기록
    return got;
  };
  const soldAt = new Map(); let injected = 0;
  const lockedAt = b => {                                  // 나눠 넣기(opt.splitN=N): s달 말에 판 돈은 b달 구매 때 min(N, b−s)/N만 쓸 수 있음 → 아직 못 쓰는 몫
    let L = 0; const N = opt.splitN; for (const [sk, v] of soldAt) { const d = b - sk; if (d >= 1 && d < N) L += v * (1 - d / N); } return L;
  };
  const usTax = Y => C.us.cg_tax_rate * Math.max(0, (usGain[Y] || 0) - C.us.cg_exemption_krw) + (opt.krGainTax ? opt.krGainTax.rate * Math.max(0, (krGain[Y] || 0) - opt.krGainTax.exempt) : 0);
  const sellPart = (h, k, fr, reason) => {                 // 일부만 팔기(부분 익절·비중 줄이기): 수수료·세금은 팔린 몫만큼
    if (!(fr > 0) || fr >= 1) { if (fr >= 1) { cash += sellCash(h, k, reason); h.sh = 0; h.basis = 0; } return; }
    const hh = Object.assign({}, h, { sh: h.sh * fr, basis: h.basis * fr, _part: true });
    const got = sellCash(hh, k, reason); h.sh -= hh.sh; h.basis -= hh.basis; cash += got;
  };
  const dl = (h, k, reason) => {                           // 판매 미루기(시험): sellDelay달 늦게 · 12월 미국 이익 종목은 1월로(taxDefer). 미룰 때 true
    let d = 0;
    if (opt.sellDelay) d = opt.sellDelay;
    else if (opt.taxDefer && h.us && (k - 1) % 12 === 11 && val(h, k) > h.basis) d = 1;
    if (!d) return false;
    h.pendK = k + d; h.pendReason = reason; return true;
  };
  const doBuys0 = (sigK, k, priceAt) => {      // sigK: 신호가 난 달, k: 체결하는 달, priceAt: 체결가(월말 종가 또는 다음 달 첫날 종가)
    // 보유 종목에 추가 매수(opt.addFrac: 현금의 몇 %를 보유 종목에, opt.addGroup: all 전체 · win 수익 중인 것만 · lose 손실 중인 것만). 대상에게 같은 금액씩, 정수 주만. 대상이 없거나 못 사는 돈은 아래 신규 매수로 감
    if (opt.addFrac > 0 && holds.length) {
      const grp = opt.addGroup || 'all', elig = [];
      for (const h of holds) {
        const p0 = priceAt(h.px, { y: h.y }); if (!(p0 > 0)) continue;
        const pk = p0 * (h.us ? fxf(k) : 1), pnl = h.sh * pk / h.basis - 1;
        if (opt.addAlign && !opt.addAlign(h.px, opt.firstDay ? k - 1 : k)) continue;       // addAlign: 이평 정배열인 종목만(체결 시점에 이미 알던 달 기준: 첫날 체결이면 지난달 말)
        if (grp === 'win' && pnl <= (opt.addThr || 0)) continue; if (grp === 'lose' && pnl >= 0) continue;     // addThr: 수익이 이 비율을 넘는 종목만(0이면 수익 중이면 전부)
        elig.push({ h, pk, w: opt.addW === 'value' ? h.sh * pk : opt.addW === 'pnl' ? Math.max(pnl, 1e-6) : 1 });      // addW: 대상 종목 몫 — equal 같은 금액 · value 평가금 비례 · pnl 수익률 비례
      }
      if (elig.length) {
        const budget = cash * opt.addFrac, wsum = elig.reduce((a, e) => a + e.w, 0);
        for (const e of elig) {
          const per = budget * e.w / wsum;
          const fee = e.h.us ? usFee : C.kr.commission, lots = Math.floor(Math.min(per, cash) * (1 - fee) / e.pk);
          if (lots < 1) continue;
          const a = Math.min(lots * e.pk / (1 - fee), cash); e.h.sh += lots; e.h.basis += a; cash -= a;
        }
      }
    }
    const picks = pickFn(ymOf(sigK));
    // opt.fill: 점수 순위대로 후보(opt.cand)를 보며 1주도 못 사는 종목은 건너뛰고 다음 순위를 산다. 종목 수가 N에 못 미치면 있는 종목끼리 현금을 나눔
    const fill = !!(opt.fill && opt.cand), list = fill ? opt.cand(ymOf(sigK)) : picks;
    if (list.length) {
      const NN = opt.nFn ? opt.nFn(ymOf(sigK), list, stNow()) : (N || picks.length);
      const per0 = cash / NN;
      let slots = NN;
      const pickedCo = new Set();                           // 이번 구매에서 이미 고른 회사(opt.oneCo)
      if (opt.maxHold) slots = Math.max(0, Math.min(slots, opt.maxHold - holds.length));      // 총 보유 종목 상한: 상한을 넘기지 않는 만큼만 새로 삼(현금은 남겨 둠)
      for (let li = 0; li < list.length; li++) {
        if (fill && slots <= 0) break;
        const { r } = list[li];
        if (holds.some(h => h.y === r.y)) continue;           // 이미 가진 종목은 또 사지 않음(매수 후보에서 뺌)
        if (opt.banMonths && (banUntil.get(r.y) || 0) > k) continue;      // 판 뒤 banMonths달은 다시 안 삼
        if (opt.failP && hash01(r.y + '|' + k + '|' + (opt.failSeed || 1)) < opt.failP) continue;      // 주문 실패 시험: 확률로 이 종목은 못 사고 다음 순위로
        if (opt.oneCo !== false) { const ckf = opt.coKeyFn || coKey, ck = ckf(r.y); if (pickedCo.has(ck) || holds.some(h => ckf(h.y) === ck)) { coSkipN++; continue; } }      // 같은 회사(우선주·Class A/B 등)는 하나만
        let per = fill ? cash / Math.min(slots, opt.minDiv ? Math.max(list.length - li, opt.minDiv) : list.length - li) : per0;      // minDiv: 남은 후보가 적어도 최소 minDiv개 몫으로 나눔(나머지는 현금으로 둠)      // fill: 남은 현금 ÷ (남은 자리, 남은 후보 중 작은 쪽)
        if (opt.perFixed) { per = opt.perFixed; if (cash < per) { injected += per - cash; cash = per; } }      // 시험용: 후보마다 고정 금액(모자라면 바깥에서 넣은 것으로 침)
        if (fill && opt.wRank) { const nn = Math.min(slots, list.length - li); if (nn > 1) per = opt.wRank > 0 ? cash * 2 / (nn + 1) : cash * 2 / (nn * (nn + 1)); }   // wRank: 순위 비례 비중(+1: 앞순위에 더, −1: 뒷순위에 더(대조)). 남은 nn자리에 nn, nn−1, … 1 (또는 반대) 몫
        if (fill && opt.wFn) { const nn = Math.min(slots, list.length - li); if (nn > 1) { let sw = 0, w0 = 0; for (let q = li, c = 0; q < list.length && c < nn; q++, c++) { const ww = opt.wFn(list[q].r, k) || 1; sw += ww; if (q === li) w0 = ww; } per = cash * w0 / sw; } }      // wFn: 종목별 비중 가중치(남은 후보 몫에서 나눔)
        if (opt.firstFrac) per *= opt.firstFrac;                // 분할 매수: 첫 몫만 먼저
        const o = px(r.y), p = priceAt(o, r); if (p === undefined || !(p > 0)) { if (opt.firstDay) fdMiss++; continue; }
        if (opt.firstDay) { const hi = o.hi.get(k), lo = o.lo.get(k); if (hi > 0 && lo > 0 && (p > hi * 1.03 || p < lo * 0.97)) { fdMiss++; continue; } }      // 첫날 종가가 그달 월봉 저가~고가를 벗어나면(액면·감자 조정이 안 맞는 일봉 자료) 그 종목은 건너뛰고 다음 순위를 삼
        const us = r.x[US] === 1, fee = us ? usFee : C.kr.commission;
        if (opt.skipFn && opt.skipFn(r, o, p, k)) continue;       // 시험용 건너뛰기 조건(종목 범위 제한 등)
        if (opt.mktCap) { let tot = 0, usv = 0; for (const hh of holds) { const v0 = val(hh, k); tot += v0; if (hh.us) usv += v0; } const sh0 = tot > 0 ? usv / tot : 0; if ((us && sh0 > opt.mktCap) || (!us && 1 - sh0 > opt.mktCap)) continue; }      // 한 시장이 보유의 mktCap을 넘으면 그 시장은 안 삼
        const pKrw = p * (us ? fxf(k) : 1);                // 원화 환산 주가
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
        const bScore = list[li].s ?? ((scored[kA].get(ymOf(sigK)) || []).find(e => e.r.y === r.y)?.s ?? 0);        // 후보 자신의 점수(확인 매수는 돌파 시점 점수)
        if (opt.oneCo !== false) pickedCo.add((opt.coKeyFn || coKey)(r.y));
        holds.push({ px: o, y: r.y, us, etf: r.x[ETF] === 1, last: p, basis: a, sh, sellK: r.exoff === null ? null : mi(r.ym) + r.exoff,
          buyYm: ymOf(k), buyK: k, buyPx: p, buyScore: bScore, t2pend: !!opt.firstFrac,
          deadK: (opt.delistP && hash01(r.y + '|' + (opt.delistSeed || 1) + '|' + k) < opt.delistP) ? k + 1 + Math.floor(hash01(r.y + '#' + k) * 36) : 0,
          buyFeats: r.x });
        if (cur) { cur.buys.push({ y: r.y, us, sh, px: p, fx: us ? fxf(k) : null, amt: a, gross: a * (1 - fee), fee: a * fee, feeRate: fee, score: bScore }); cur.order.push(r.y); }
        cash -= a; slots--;
      }
    } else if (holds.length && cash > 0) {
      // 매수 신호 없을 때: 보유 종목에 균등 추가 매수 (reinvest 변형용 — simulate 호출 시 reinvest:true 옵션)
      if (opt.reinvest) {
        const per = cash / holds.length;
        for (const h of holds) {
          const p = h.px.m.get(k); if (!p) continue;
          const a = Math.min(per, cash), fee = h.us ? usFee : C.kr.commission;
          h.sh += a * (1 - fee) / (p * (h.us ? fxf(k) : 1)); h.basis += a; cash -= a;
        }
      }
    }
  };
  const doBuys = (sigK, k, priceAt) => {                   // 시험용 바깥 틀: 그달 쉬기(buyBlock) · 늦게 사기(buyDelay) · 현금 일부 남기기(cashKeep)
    if (opt.buyBlock && opt.buyBlock(k, ymOf(sigK), stNow())) return;
    if (opt.buyDelay) sigK -= opt.buyDelay;
    const kc = cash * (opt.cashKeepFn ? Math.max(0, Math.min(1, opt.cashKeepFn(k, stNow()) || 0)) : (opt.cashKeep || 0)); cash -= kc;
    const kl = opt.splitN > 1 ? Math.min(Math.max(0, cash), lockedAt(k)) : 0; cash -= kl;      // 나눠 넣기: 아직 차례가 안 된 매도 대금은 이번 구매에 안 씀
    try { doBuys0(sigK, k, priceAt); } finally { cash += kc + kl; }
  };
  let pend = null, fdMiss = 0, tlhN = 0, taxTotal = 0, coSkipN = 0, divTotal = 0, taxShortN = 0, taxShortAmt = 0, presellN = 0, presellAmt = 0;
  let eqIdx = 1, eqPeak = 1; const eqHist = [], cfs = [];               // 시험용 상태: 전략 수익곡선(시간가중)·최고점·현금흐름
  const stNow = () => { const n = rets.length; let r12 = 1; for (let i = Math.max(0, n - 12); i < n; i++) r12 *= 1 + rets[i].r; const L = opt.eqMaN || 10, a = eqHist.slice(-L), ma = a.length >= L ? a.reduce((s, x) => s + x, 0) / L : null; const rr12 = rets.slice(-12).map(x => x.r), mu12 = rr12.length ? rr12.reduce((s, x) => s + x, 0) / rr12.length : 0, vol12 = rr12.length >= 6 ? Math.sqrt(rr12.reduce((s, x) => s + (x - mu12) ** 2, 0) / rr12.length) * Math.sqrt(12) : null; return { dd: eqIdx / eqPeak - 1, ret12: r12 - 1, nM: n, vol12, eqBelow: ma != null && eqIdx < ma, eqIdx, eqHist }; };
  for (let k = START; k <= END; k++) {
    cur = led ? { k, dep, sells: [], buys: [], skipped: [], order: [], tax: 0 } : null;
    if (opt.cashRateFn && k > START) cash += cash * Math.max(0, opt.cashRateFn(k) || 0) / 12;
    if (opt.cashRetFn && k > START) cash *= 1 + (opt.cashRetFn(k, stNow()) || 0);                              // 놀고 있는 현금을 지수에 넣어 둠(그 달 지수 수익률)
    if (opt.sellFd) { const nk = []; for (const h of holds) { if (h.pendK != null && h.pendK <= k) { const pf = fdPx(h.y, k); if (pf > 0) h.last = pf; cash += sellCash(h, k, h.pendReason); } else nk.push(h); } holds = nk; }      // 미룬 판매를 이달 첫날 종가에 실행          // 현금 이자(월 단위, 세금 제외): 놀고 있는 현금에 연 이율/12를 더함
    if (opt.firstDay && k > START) {                                              // 지난달 신호 → 이번 달 첫날 종가에 체결(입금·세금 처리 전 현금)
      // 12월 첫날 구매: 그해 11월까지 실현한 미국 주식 이익에 나올 양도세를 미리 떼어 두고 남은 돈으로 산다(12월 말에 세금이 모자라 보유 종목을 억지로 팔지 않게). opt.taxReserve=false면 예전 방식
      const rsv = (opt.taxReserve !== false && (k - 1) % 12 === 11) ? Math.min(Math.max(0, cash), usTax(yOfK(k))) : 0;
      cash -= rsv; doBuys(k - 1, k, (o, r) => (opt.fdPxFn ? (opt.fdPxFn(r.y, k) || fdPx(r.y, k)) : opt.fdOpen ? fdOpen(r.y, k) : fdPx(r.y, k))); cash += rsv;
    }
    const keep = [], stM = stNow();
    const ctxM = { st: stM, nHold: holds.length, get nBelow() { if (this._nb == null) { this._nb = 0; for (const x of holds) { const m = ma10(x.px, k); if (m && x.last < m) this._nb++; } } return this._nb; } };
    for (const h of holds) {
      const p = h.px.m.get(k); if (p !== undefined) h.last = p;
      if (opt.divFn && !(opt.divSkipBuy && h.buyK === k)) {                       // 배당 시험: 그달 배당락이 있는 보유 종목의 배당을 (세후) 현금으로 받음 — 다음 달 구매에 재투자됨
        const d = opt.divFn(h.y, k);
        if (d > 0) { const net = h.sh * d * (h.us ? fxf(k) : 1) * (1 - (h.us ? (opt.divTaxUS || 0) : (opt.divTaxKR || 0))); cash += net; divTotal += net; }
      }
      h.peak = Math.max(h.peak || h.buyPx || 0, h.last || 0);
      if (h.pendK != null) { if (h.pendK <= k && !opt.sellFd) { cash += sellCash(h, k, h.pendReason); continue; } keep.push(h); continue; }
      if (opt.decideEvery && (k - START) % opt.decideEvery !== 0) { keep.push(h); continue; }               // 시험용: N개월에 한 번만 판매 판단
      if (opt.dailyFn) { const dr = opt.dailyFn(h, k); if (dr) { h.last = dr.px; if (dl(h, k, dr.rs)) { keep.push(h); continue; } cash += sellCash(h, k, dr.rs); continue; } }   // 일봉 판단(시험): 그달 안에서 일 단위 조건이 걸리면 그날 값으로 판매
      if (opt.skipBuyMonth && h.buyK === k) { keep.push(h); continue; }      // 산 달 말에는 판매 판단을 하지 않음(첫날 구매 방식에서 사자마자 파는 것을 막는 변형)
      if (!opt.grace && h.sellK !== null && h.sellK <= k) { if (dl(h, k, 'ma10')) { keep.push(h); continue; } cash += sellCash(h, k, 'ma10'); continue; }
      // 손절: 종가가 매수가 대비 opt.sl 비율 이하로 하락 시 즉시 매도
      if (opt.sl && h.buyPx) {
        const pKrw = h.last * (h.us ? fxf(k) : 1), buyKrw = h.buyPx * (h.us ? fxf(mi(h.buyYm)) : 1);
        if (pKrw <= buyKrw * (1 - opt.sl)) { if (dl(h, k, 'sl')) { keep.push(h); continue; } cash += sellCash(h, k, 'sl'); continue; }
      }
      if (opt.tp) {                                       // 익절: 종가 ≥ tp × 월10이평이면 매도
        if (h.tpSellK != null) {                          // 이미 트리거됨 → 예정 달에 매도
          if (h.tpSellK <= k) { if (dl(h, k, 'tp')) { keep.push(h); continue; } cash += sellCash(h, k, 'tp'); continue; }
        } else {
          const ma = ma10(h.px, k);
          if (ma && h.last >= opt.tp * ma) {
            if (opt.tpSame) { if (dl(h, k, 'tp')) { keep.push(h); continue; } cash += sellCash(h, k, 'tp'); continue; }
            h.tpSellK = k + 1;                            // 다음 달 종가에 매도
          }
        }
      }
      if (opt.tpTrail) {                                  // 트레일링 익절: tp배 위에 있으면 보유, 처음 아래로 떨어지면 매도
        const ma = ma10(h.px, k);
        if (ma) {
          if (h.last >= opt.tpTrail * ma) h.tpTrig = true;
          else if (h.tpTrig) { if (dl(h, k, 'tpTrail')) { keep.push(h); continue; } cash += sellCash(h, k, 'tpTrail'); continue; }
        }
      }
      // 매도 유예: 10이평 아래로 내려와도 바로 팔지 않고 N달 연속 아래일 때만 매도
      if (opt.grace) {                                    // grace 모드: sellK 무시하고 연속 이탈 카운트로 매도
        const ma = opt.exitMaFn ? opt.exitMaFn(h, k) : (opt.exitMaN ? maAtN(h.px, k, opt.exitMaN) : ma10(h.px, k));      // 판매 기준 이평(시험: 길이·종목별 함수)
        if (ma) {
          if (h.last < ma * (1 - (opt.exitBuf || 0))) {
            // opt.graceRate: 금리 조건부 유예 — 금리 인상 중(ff_chg12>0)이면 유예 없이 바로 매도
            let ff = opt.graceRate ? ((opt.rateKR && !h.us) ? krChg12(k) : ffChg12(k)) : null;   // rateKR: 한국 종목은 한국 금리로 판단(미국 종목은 미국 금리)
            if (opt.rateFn) { const v = opt.rateFn(k); ff = v === true ? 1 : v === false ? 0 : null; }   // rateFn(k): 금리가 오르는 중이면 true (모르면 null = 규칙 안 씀)
            const revNow = !!(opt.revFn && opt.revFn(h.px, k));     // 역배열 시험: 10이평 아래인데 역배열이면 유예 없이 즉시
            const g2 = opt.graceN2 ? opt.graceN2(h, k, ctxM) : undefined;      // 조건부 유예(시험): 종목 수익·지수 상태에 따라 유예 달 수를 바꿈
            const graceN = ((ff != null && ff > 0) || revNow) ? 1 : (g2 !== undefined ? g2 : opt.grace);  // 금리 인상 중·역배열→ 1달(=즉시), 아니면 N달
            h.graceCnt = (h.graceCnt || 0) + 1;
            if (h.graceCnt >= graceN) { if (dl(h, k, ff != null && ff > 0 ? 'ma10-금리인상' : revNow ? 'ma10-역배열' : 'ma10-유예만료')) { keep.push(h); continue; } cash += sellCash(h, k, ff != null && ff > 0 ? 'ma10-금리인상' : revNow ? 'ma10-역배열' : 'ma10-유예만료'); continue; }
          } else if (!opt.graceNoReset) h.graceCnt = 0;
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
            if (dl(h, k)) { keep.push(h); continue; } cash += sellCash(h, k); continue;             // 유예 소진 → 매도
          }
        } else { h.mlGrace = null; }                      // 이평 위로 복귀 → 카운터 초기화
      }
      if (opt.alignExit) {                                // 정배열 이탈 정리: 정배열이 깨진 보유 종목은 전부 판매(alignArm이면 한 번 정배열이 된 뒤에 깨졌을 때만)
        const al = opt.alignExit(h.px, k);
        if (al === true) h.armed = true;
        else if (al === false && (!opt.alignArm || h.armed)) { if (dl(h, k, 'align')) { keep.push(h); continue; } cash += sellCash(h, k, 'align'); continue; }
      }
      if (opt.exitFn) { const rs = opt.exitFn(h, k, { part: (fr, rsn) => sellPart(h, k, fr, rsn), st: stM, ctx: ctxM, cands: opt.cand ? opt.cand(ymOf(k)) : [], holds }); if (rs) { if (dl(h, k, rs)) { keep.push(h); continue; } cash += sellCash(h, k, rs); continue; } }      // 시험용 판매 규칙(시간 손절·고점 대비 하락·부분 익절 등)
      if (h.sh <= 0) continue;
      keep.push(h);
    }
    holds = keep;
    if (opt.trim && opt.trim.months.includes((k - 1) % 12 + 1) && holds.length >= 2) {      // 비중 줄이기: 한 종목이 한도를 넘으면 넘는 만큼 판매(cap = 전체 자산의 몫, 아니면 보유 평균의 (1+over)배)
      let hv = 0; for (const h of holds) hv += val(h, k);
      const lim = opt.trim.cap ? opt.trim.cap * (hv + cash) : hv / holds.length * (1 + (opt.trim.over || 0));
      for (const h of holds) { const v = val(h, k); if (v > lim * 1.0001) sellPart(h, k, 1 - lim / v, 'trim'); }
    }
    if (opt.tlh && opt.tlh.months.includes((k - 1) % 12 + 1)) {                // 손실 난 미국 종목 미리 팔기(세금 줄이기): 그해 미국 이익이 공제를 넘으면 세금이 0이 될 때까지 손실 큰 순으로 판매(always면 이익과 상관없이 손실 종목 전부)
      const Yt = yOfK(k), lossOf = h => val(h, k) * (h.us ? 1 - usFee : 1 - C.kr.commission) - h.basis;      // 팔면 얼마 손해인지(수수료 반영, 음수 = 손실)
      const L = holds.filter(h => (h.us || opt.tlh.all) && lossOf(h) < 0 && lossOf(h) <= -(opt.tlh.minLoss || 0) * h.basis).sort((a, b) => lossOf(a) - lossOf(b));
      for (const h of L) {
        if (!opt.tlh.always && (usGain[Yt] || 0) <= C.us.cg_exemption_krw) break;
        cash += sellCash(h, k, 'tlh'); holds = holds.filter(x => x !== h); tlhN++;
      }
    }
    if (opt.taxPresell && (k - 1) % 12 === 10) {        // 양도세 몫 미리 확보: 11월 말에 (이번 달 입금을 빼고) 현금이 올해 양도세보다 적으면 모자란 만큼 미리 판다 → 12월 말에 억지로 비율 판매하거나 12월·1월 구매를 못 하는 일을 막음
      const Yp = yOfK(k), exMa = h => (opt.exitMaFn ? opt.exitMaFn(h, k) : (opt.exitMaN ? maAtN(h.px, k, opt.exitMaN) : ma10(h.px, k))), relOf = h => { const m = exMa(h); return m ? h.last / m : 9; };
      const pri = h => ((h.graceCnt || 0) > 0 ? [0, relOf(h), 0] : [1, h.buyScore ?? 0, relOf(h)]);       // 1순위 이평 아래라 유예 중인 종목(많이 아래인 것부터), 2순위 점수가 낮은 것부터(같으면 이평에 가까운 것부터)
      while (holds.length && usTax(Yp) - cash > 0) {
        let best = null, bp = null; for (const h of holds) { const p = pri(h); if (!bp || p[0] < bp[0] || (p[0] === bp[0] && (p[1] < bp[1] || (p[1] === bp[1] && p[2] < bp[2])))) { best = h; bp = p; } }
        const got = sellCash(best, k, 'taxPresell'); cash += got; presellN++; presellAmt += got; holds = holds.filter(x => x !== best);
      }
    }
    let depK = (opt.depEvery ? ((k - START) % opt.depEvery === 0 ? dep * opt.depEvery : 0) : dep) + (opt.lump && k === START ? opt.lump : 0);
    if (opt.depFn) { let hv0 = 0; for (const h of holds) hv0 += val(h, k); depK = opt.depFn(k, stM, dep, cash + hv0, depK) || 0; }       // 시험용: 입금액을 상태에 따라(성장·낙폭 때 2배·가치평균·인출(음수))
    cfs.push([k, -depK]);
    if (depK < 0) { const need = -depK; if (cash >= need) cash -= need; else { let hv1 = 0; for (const h of holds) hv1 += val(h, k); const f = hv1 > 0 ? Math.min(1, (need - cash) / hv1) : 0; for (const h of holds) { h.sh *= 1 - f; h.basis *= 1 - f; } cash = Math.max(0, cash - need); } }
    else cash += depK;
    if (depK > 0) deposits++;                            // 입금을 먼저 받는다: 12월에는 이 돈으로 양도세를 먼저 내고 남은 돈으로 산다
    if ((k - 1) % 12 === 11) {                          // 12월 말: 그해 미국 주식 실현 손익에 양도세(기본공제 후)를 냄
      const Y = yOfK(k), tax = usTax(Y); usGain[Y] = 0; krGain[Y] = 0; taxTotal += tax;
      if (cur) cur.tax = tax;
      if (tax > 0) {
        if (cash >= tax) cash -= tax;
        else { taxShortN++; taxShortAmt += tax - cash; let hv = 0; for (const h of holds) hv += val(h, k); const f = hv > 0 ? Math.min(1, (tax - cash) / hv) : 0; for (const h of holds) h.sh *= 1 - f; cash = 0; }
      }
    }
    // (입금은 위에서 이미 받음)
    if (opt.firstFrac) for (const h of holds) if (h.t2pend && h.buyK === k) {              // 분할 매수 둘째 몫: 산 달 말에도 10이평 위면 같은 금액 더 삼
      h.t2pend = false; const ma2 = ma10(h.px, k);
      if (ma2 && h.last > ma2) { const fee2 = h.us ? usFee : C.kr.commission, pk2 = h.last * (h.us ? fxf(k) : 1), lots2 = Math.floor(Math.min(h.basis, cash) * (1 - fee2) / pk2); if (lots2 >= 1) { const a2 = lots2 * pk2 / (1 - fee2); h.sh += lots2; h.basis += a2; cash -= a2; } }
    }
    if (opt.addFn) for (const h of holds) {                                      // 시험용: 불타기·물타기 — addFn(h,k,st)이 처음 산 금액의 몇 배를 더 살지 돌려줌(월말 종가, 현금 안에서)
      if (h.buyK === k) continue; const f = opt.addFn(h, k, stM); if (!(f > 0) || !(cash > 0) || !(h.last > 0)) continue;
      if (!h.b0) h.b0 = h.basis; const fee2 = h.us ? usFee : C.kr.commission, pk2 = h.last * (h.us ? fxf(k) : 1), lots2 = Math.floor(Math.min(h.b0 * f, cash) * (1 - fee2) / pk2);
      if (lots2 >= 1) { const cost = lots2 * pk2 / (1 - fee2); h.sh += lots2; h.basis += cost; cash -= cost; }
    }
    if (!opt.firstDay) doBuys(k, k, (o) => o.m.get(k));
    else pend = k;
    let after = cash; for (const h of holds) after += val(h, k);
    if (prevAfter > 0) { const rr = (after - depK) / prevAfter - 1; rets.push({ k, r: rr }); eqIdx *= 1 + rr; eqPeak = Math.max(eqPeak, eqIdx); eqHist.push(eqIdx); }
    prevAfter = after;
    if (led) led.set(ymOf(k), Object.assign(cur, { cash, holdVal: after - cash, fx: fxf(k) }));
    // 보유 스냅샷 (opt.log)
    if (snapshots) snapshots.set(ymOf(k), holds.map(h => ({ y: h.y, buyYm: h.buyYm, buyPx: h.buyPx, curPx: h.last, basis: h.basis, sh: h.sh, score: h.buyScore, feats: h.buyFeats })));
  }
  if (opt.firstDay && pend !== null) { cur = null; doBuys(pend, mi(CUR), (o, r) => fdPx(r.y, mi(CUR))); }   // 이번 달 첫날 체결분은 장부에 안 넣음(아직 진행 중인 달)   // 마지막 신호의 체결(이번 달 첫날)
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
  return { rets, cfs, deposits, depAmt: dep, val: nowV, liq, trades, snapshots, ledger: led, fdMiss, tlhN, taxTotal, coSkipN, divTotal, injected, taxShortN, taxShortAmt, presellN, presellAmt };
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

// ── 이동평균 길이 비교용 가벼운 실행(MA_SWEEP=1): 신호·판매·지표를 MA_N달 이평으로 만든 events.csv(3_build.js MA_N=n)에서 점수 상위 4의 성과만 재서 data/masweep_<n><TAG>.json에 저장하고 끝냄
if (process.env.MA_SWEEP === '1') {
  const topL = ym => scored[kA].get(ym) || [], botL = ym => [...topL(ym)].reverse();
  const base = { lotSize: true, lotAll: true, fill: true, cand: topL, firstDay: true };
  const CF = [['즉시+tp2x', { tpTrail: 2 }], ['즉시', {}], ['유예2+금리+tp2x(현재)', { tpTrail: 2, grace: 2, graceRate: true }], ['유예2+금리', { grace: 2, graceRate: true }]];
  const Ys = Object.keys(summ(simulate(ym => topL(ym).slice(0, 4), 4, C1, { ...base })).yearly).map(Number).sort((a, b) => a - b);
  const gmY = (yr, ys) => ys.length ? Math.pow(ys.reduce((p, y) => p * (1 + (yr[y] ?? 0)), 1), 1 / ys.length) - 1 : null;
  const res = { ma: MAN, tag: process.env.MA_TAG || '', events: ALL.length, kr: ALL.filter(r => r.x[US] === 0).length, cfgs: [] };
  CF.forEach(([name, o], i) => {
    const sm = simulate(ym => topL(ym).slice(0, 4), 4, C1, { ...base, ...o, log: i === 0 });
    const m = summ(sm), e = {};
    e.name = name; e.cagr = m.cagr; e.mdd = m.mdd; e.early = gmY(m.yearly, Ys.filter(y => y <= 2019)); e.late = gmY(m.yearly, Ys.filter(y => y > 2019)); e.yearly = m.yearly;
    if (i === 0 && sm.trades) { const T = sm.trades.filter(t => t.sellYm); e.trades = T.length; e.win = T.filter(t => t.ret > 0).length / (T.length || 1); e.hold = T.reduce((a, t) => a + ((Math.floor(t.sellYm / 100) * 12 + t.sellYm % 100) - (Math.floor(t.buyYm / 100) * 12 + t.buyYm % 100)), 0) / (T.length || 1); }
    res.cfgs.push(e);
  });
  const o0 = { ...base, ...CF[0][1] };
  const mk = us => { const c = ym => topL(ym).filter(e => (e.r.x[US] === 1) === us); return summ(simulate(ym => c(ym).slice(0, 4), 4, C1, { ...o0, cand: c })).cagr; };
  res.kr = mk(false); res.us = mk(true);
  res.bottom = summ(simulate(ym => botL(ym).slice(0, 4), 4, C1, { ...o0, cand: botL })).cagr;
  const rr = []; for (let sd = 1; sd <= (+process.env.MA_SEEDS || 20); sd++) { const rnd = rng(sd); const sh = ym => { const a = [...(byYm.get(ym) || [])], r = rng(sd * 7 + (ym % 997)); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }; rr.push(summ(simulate(ym => sh(ym).slice(0, 4), 4, C1, { ...o0, cand: sh })).cagr); }
  rr.sort((a, b) => a - b); res.rand = { med: rr[Math.floor(rr.length / 2)], p90: rr[Math.floor(rr.length * 0.9)], min: rr[0], max: rr[rr.length - 1], n: rr.length, beat: rr.filter(v => v >= res.cfgs[0].cagr).length };
  fs.writeFileSync(path.join(DATA, `masweep_${MAN}${res.tag}.json`), JSON.stringify(res));
  console.log(`\nMA${MAN} 끝: 즉시+tp2x ${(res.cfgs[0].cagr * 100).toFixed(1)}%, 무작위 중앙값 ${(res.rand.med * 100).toFixed(1)}%`);
  process.exit(0);
}
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
  const FUNDC = names => F.map((f, j) => j).filter(j => F[j].startsWith('f_') && (!names || names.includes(F[j].slice(2))));
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
    ...(FUND.on ? [
      ['B 재무 지표 (미국만 있음, SEC 공시 시점 기준) — 비교 기준은 위 "gbm · fd 정답"', 'gbm · fd + 재무 전체', () => walkG({ lab: 'fd', cols: NOIDX.concat(FUNDC()) })],
      ['B 재무 지표 (미국만 있음, SEC 공시 시점 기준) — 비교 기준은 위 "gbm · fd 정답"', 'gbm · fd + 영업이익(흑자·마진·증가율)·순이익 흑자', () => walkG({ lab: 'fd', cols: NOIDX.concat(FUNDC(['oi_pos', 'oi_margin', 'oi_growth', 'ni_pos'])) })],
      ['B 재무 지표 (미국만 있음, SEC 공시 시점 기준) — 비교 기준은 위 "gbm · fd 정답"', 'gbm · fd + 현금·부채 비율', () => walkG({ lab: 'fd', cols: NOIDX.concat(FUNDC(['cash_ratio', 'debt_ratio'])) })],
      ['B 재무 지표 (미국만 있음, SEC 공시 시점 기준) — 비교 기준은 위 "gbm · fd 정답"', 'gbm · fd + 배당(지급·성향)', () => walkG({ lab: 'fd', cols: NOIDX.concat(FUNDC(['payout', 'pays_div'])) })],
      ['B 재무 지표 (미국만 있음, SEC 공시 시점 기준) — 비교 기준은 위 "gbm · fd 정답"', 'gbm · fd + 영업이익 흑자 여부만', () => walkG({ lab: 'fd', cols: NOIDX.concat(FUNDC(['oi_pos'])) })]
    ] : []),
    ['A2 씨앗 반복 (같은 조건에서 씨앗만 다름)', 'gbm · fd 정답, 씨앗 5개 평균 (기준)', () => walkG({ lab: 'fd', seeds: 5 })],
    ...(FUND.on ? [
      ['A2 씨앗 반복 (같은 조건에서 씨앗만 다름)', 'gbm · fd + 영업이익(흑자·마진·증가율)·순이익 흑자, 씨앗 5개 평균', () => walkG({ lab: 'fd', seeds: 5, cols: NOIDX.concat(FUNDC(['oi_pos', 'oi_margin', 'oi_growth', 'ni_pos'])) })],
      ['A2 씨앗 반복 (같은 조건에서 씨앗만 다름)', 'gbm · fd + 영업이익 마진·증가율만, 씨앗 5개 평균', () => walkG({ lab: 'fd', seeds: 5, cols: NOIDX.concat(FUNDC(['oi_margin', 'oi_growth'])) })]
    ] : []),
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
  if (process.env.S3_ONLY) { const re = new RegExp(process.env.S3_ONLY); for (let i = SPECS.length - 1; i >= 0; i--) if (!re.test(SPECS[i][1])) SPECS.splice(i, 1); }     // S3_ONLY="씨앗 5개" 처럼 이름에 맞는 변형만 돌림(검산 생략)
  SPECS.forEach(([g, name, mk], i) => {
    progress('3단계 실험', i / SPECS.length);
    const res = mk(), map = res instanceof Map ? res : res.map, skip = res instanceof Map ? null : res.skip;
    S3.rows.push({ g, name, ...evalMap(map, skip) });
    if (i === 0 && !process.env.S3_ONLY) {                          // 검산: 기준 변형이 기존 A 점수(scored[kA])와 같아야 함(같은 정답·같은 학습 → 모순 확인)
      let mx = 0, n = 0, miss = 0; scoredRidgeA.forEach((a, ym) => { const b = map.get(ym) || []; const m2 = new Map(b.map(e => [e.r, e.s])); a.forEach(e => { const v = m2.get(e.r); if (v === undefined) miss++; else if (!(Number.isNaN(v) && Number.isNaN(e.s))) mx = Math.max(mx, Math.abs(v - e.s)); n++; }); });
      S3.check = { max: mx, n, miss };
    }
  });
  progress('3단계 실험', 1); process.stdout.write('\n');
  const rr = FD.paired.fd; S3.ref = { med: quant(rr, 0.5), p90: quant(rr, 0.9) };
}
// ── 걸어가며 설정 고르기(STAGE4=0이면 건너뜀): "A4 tp2x트레일 금리유예2달"은 전체 기간을 보고 고른 설정이라 그 시점의 사람은 알 수 없었음.
//    후보 설정을 모두 돌려 연도별 수익을 구한 뒤, 해마다 "그 전해까지의 성과만"으로 설정을 골라 그해 수익을 이어 붙인 값 = 현실에서 얻을 수 있는 성과.
//    근사: 설정을 바꾸면 실제로는 보유·현금이 달라지지만, 각 설정이 자기 경로로 계속 달렸을 때의 연도별 수익을 이어 붙임. 점수 순위·첫날 체결·정수 주문·보유 제외는 모두 같게 둠.
const WF = { cfgs: [], res: null };
if (process.env.STAGE4 !== '0') {
  const NS = [2, 3, 4, 6, 10], TPS = [0, 1.5, 2, 3];
  const SELLS = [{ g: 0, r: false, n: '이탈 즉시' }, { g: 2, r: true, n: '유예2+금리' }, { g: 2, r: false, n: '유예2' }, { g: 3, r: true, n: '유예3+금리' }, { g: 3, r: false, n: '유예3' }];
  let ci = 0; const total = NS.length * TPS.length * SELLS.length;
  NS.forEach(N => TPS.forEach(tp => SELLS.forEach(sl => {
    progress('설정 걸어가며 고르기', ci++ / total);
    const opt = { lotSize: true, lotAll: true, fill: true, cand: cmpTopL, firstDay: true };
    if (tp) opt.tpTrail = tp; if (sl.g) { opt.grace = sl.g; opt.graceRate = sl.r; }
    const sm = summ(simulate(ym => cmpTopL(ym).slice(0, N), N, C1, opt));
    WF.cfgs.push({ N, tp, sl, name: `N${N} · ${tp ? 'tp' + tp + 'x' : '익절없음'} · ${sl.n}`, yearly: sm.yearly, cagr: sm.cagr });
  })));
  progress('설정 걸어가며 고르기', 1); process.stdout.write('\n');
  const Ys = YEARS_ALL, first = 3;                                       // 고를 때 최소 3년치 과거가 있어야 함
  const gm = (c, ys) => ys.length ? Math.pow(ys.reduce((p, y) => p * (1 + (c.yearly[y] ?? 0)), 1), 1 / ys.length) - 1 : -9;
  const CRIT = {
    '확장 연평균(과거 전부)': (c, ys) => gm(c, ys),
    '최근 5년 연평균': (c, ys) => gm(c, ys.slice(-5)),
    '평균 − 0.5×표준편차(과거 전부)': (c, ys) => { const v = ys.map(y => c.yearly[y] ?? 0), m = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length); return m - 0.5 * sd; }
  };
  const oosYears = Ys.slice(first);
  const find = (N, tp, g, r) => WF.cfgs.find(c => c.N === N && c.tp === tp && c.sl.g === g && c.sl.r === r);
  const fixed = find(4, 2, 2, true);
  WF.res = { oosYears, fixed, crit: {} };
  Object.entries(CRIT).forEach(([cn, fn]) => {
    const hist = []; let prod = 1;
    oosYears.forEach(Y => {
      const past = Ys.filter(y => y < Y);
      let best = null; WF.cfgs.forEach(c => { const v = fn(c, past); if (!best || v > best.v) best = { c, v }; });
      const r = best.c.yearly[Y] ?? 0; prod *= 1 + r; hist.push({ Y, name: best.c.name, r, pastScore: best.v });
    });
    WF.res.crit[cn] = { cagr: Math.pow(prod, 1 / oosYears.length) - 1, hist, distinct: new Set(hist.map(h => h.name)).size, changes: hist.filter((h, i) => i > 0 && h.name !== hist[i - 1].name).length };
  });
  WF.res.fixedCagr = gm(fixed, oosYears);
  WF.res.avgCfg = WF.cfgs.reduce((a, c) => a + gm(c, oosYears), 0) / WF.cfgs.length;
  WF.res.best = WF.cfgs.reduce((b, c) => (!b || gm(c, oosYears) > gm(b, oosYears)) ? c : b, null);
  WF.res.sorted = [...WF.cfgs].sort((a, b) => gm(b, oosYears) - gm(a, oosYears));
  WF.gm = gm;
}
// ── 점수 효과 보강 보고
// ── 종목을 무작위 절반씩 나눠 되풀이(STAGE5=0이면 건너뜀): 설정의 효과가 몇 개 대박 종목 때문인지, 어느 종목 묶음에서나 같은 방향인지 확인.
//    종목 키 해시로 절반을 뽑아(씨앗 b마다 다른 절반) 그 절반 안에서만 점수 상위 4를 사서, 익절 트레일·유예·금리 규칙의 효과(%p)를 구함. 효과의 평균·표준편차·양수인 비율을 봄.
const BS = { n: 0, eff: null };
if (process.env.STAGE5 !== '0') {
  const B = +process.env.BS_N || 30, hash = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
  const SELLS5 = [{ n: '이탈 즉시', g: 0, r: false }, { n: '유예2', g: 2, r: false }, { n: '유예2+금리', g: 2, r: true }, { n: '유예3+금리', g: 3, r: true }];
  const eff = { tp2: [], g2: [], g2r: [], g3r: [], rate2: [], base: [], cfgBest: [] };
  for (let b = 1; b <= B; b++) {
    progress('종목 절반 되풀이', (b - 1) / B);
    const candH = ym => cmpTopL(ym).filter(e => hash(e.r.y + '|' + b) < 0.5);
    const cg = {};
    [0, 2].forEach(tp => SELLS5.forEach(sl => {
      const opt = { lotSize: true, lotAll: true, fill: true, cand: candH, firstDay: true };
      if (tp) opt.tpTrail = tp; if (sl.g) { opt.grace = sl.g; opt.graceRate = sl.r; }
      cg[tp + '|' + sl.n] = summ(simulate(ym => candH(ym).slice(0, 4), 4, C1, opt)).cagr;
    }));
    const avgOver = f => SELLS5.reduce((a, sl) => a + f(sl), 0) / SELLS5.length;
    eff.tp2.push(avgOver(sl => cg['2|' + sl.n] - cg['0|' + sl.n]));
    [0, 2].forEach(tp => { });
    const tpAvg = sn => ((cg['0|' + sn] + cg['2|' + sn]) / 2);
    eff.g2.push(tpAvg('유예2') - tpAvg('이탈 즉시')); eff.g2r.push(tpAvg('유예2+금리') - tpAvg('이탈 즉시')); eff.g3r.push(tpAvg('유예3+금리') - tpAvg('이탈 즉시')); eff.rate2.push(tpAvg('유예2+금리') - tpAvg('유예2'));
    eff.base.push(cg['2|유예2+금리']);                                    // 지금 설정(N4·tp2x·유예2+금리)의 이 절반에서의 연평균
    const ents = Object.entries(cg).sort((x, y) => y[1] - x[1]); eff.cfgBest.push(ents[0][0]);
  }
  progress('종목 절반 되풀이', 1); process.stdout.write('\n');
  BS.n = B; BS.eff = eff;
}
// ── 금리 규칙 판단 기준 비교(STAGE6=0이면 건너뜀, data/rates.json 필요 = 2e_rates.js): "금리가 오르는 중이면 유예 없이 즉시 매도"의 오름 판단을 여러 방식으로.
//    금리 값은 모두 "그 달 마지막 날"에 이미 알던 값(하루 단위 FRED). 판매 판단이 월말이라 같은 달 값을 써도 미래 정보 아님. 현재 방식(FEDFUNDS 월평균 12개월 변화, 한 달 늦게)과 비교.
const RT6 = { rows: null };
if (process.env.STAGE6 !== '0' && fs.existsSync(path.join(DATA, 'rates.json'))) {
  const RT = JSON.parse(fs.readFileSync(path.join(DATA, 'rates.json'))), rt = k => RT[ymOf(k)] || {};
  const ch = (f, w) => k => { const a = rt(k)[f], b = rt(k - w)[f]; return a != null && b != null ? a - b : null; };
  const df = (a, b) => k => { const x = rt(k)[a], y = rt(k)[b]; return x != null && y != null ? x - y : null; };
  const gt = (g, t = 0) => k => { const v = g(k); return v == null ? null : v > t; };
  const or = (a, b) => k => { const x = a(k), y = b(k); return (x === true || y === true) ? true : (x === null && y === null ? null : false); };
  const VAR = [
    ['규칙 없음 (유예2만)', { graceRate: false }],
    ['현재: 월평균 금리 12개월 변화>0 (한 달 늦게)', { graceRate: true }],
    ['목표금리 3개월 변화>0', { rateFn: gt(ch('tgt', 3)) }], ['목표금리 6개월 변화>0', { rateFn: gt(ch('tgt', 6)) }], ['목표금리 12개월 변화>0', { rateFn: gt(ch('tgt', 12)) }],
    ['목표금리 12개월 +0.25%p 이상', { rateFn: gt(ch('tgt', 12), 0.24) }],
    ['실효금리(하루) 3개월 변화>0', { rateFn: gt(ch('dff', 3)) }], ['실효금리(하루) 6개월 변화>0', { rateFn: gt(ch('dff', 6)) }], ['실효금리(하루) 12개월 변화>0', { rateFn: gt(ch('dff', 12)) }],
    ['국채2년 − 실효금리 > 0 (시장이 인상 예상)', { rateFn: gt(df('dgs2', 'dff'), 0) }], ['국채2년 − 실효금리 > 0.25', { rateFn: gt(df('dgs2', 'dff'), 0.25) }], ['국채2년 − 실효금리 > 0.5', { rateFn: gt(df('dgs2', 'dff'), 0.5) }],
    ['국채1년 − 실효금리 > 0', { rateFn: gt(df('dgs1', 'dff'), 0) }], ['국채1년 − 실효금리 > 0.25', { rateFn: gt(df('dgs1', 'dff'), 0.25) }],
    ['국채10년 3개월 변화>0', { rateFn: gt(ch('dgs10', 3)) }], ['국채10년 6개월 변화>0', { rateFn: gt(ch('dgs10', 6)) }], ['국채10년 12개월 변화>0', { rateFn: gt(ch('dgs10', 12)) }],
    ['국채2년 12개월 변화>0', { rateFn: gt(ch('dgs2', 12)) }],
    ['목표금리 6개월 변화>0 또는 (2년물−실효>0.25)', { rateFn: or(gt(ch('tgt', 6)), gt(df('dgs2', 'dff'), 0.25)) }]
  ];
  const hash = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
  const B = +process.env.RT_HALVES || 12, topL6 = ym => scored[kA].get(ym) || [];
  const run6 = (v, cand) => summ(simulate(ym => cand(ym).slice(0, 4), 4, C1, { lotSize: true, lotAll: true, fill: true, cand, firstDay: true, tpTrail: 2, grace: 2, ...v[1] }));
  const rows = []; let vi = 0;
  VAR.forEach(v => { progress('금리 판단 비교', vi++ / VAR.length); rows.push({ name: v[0], full: run6(v, topL6), halves: [] }); });
  for (let b = 1; b <= B; b++) {
    progress('금리 판단 비교(절반)', (b - 1) / B);
    const cand = ym => topL6(ym).filter(e => hash(e.r.y + '|' + b) < 0.5);
    VAR.forEach((v, i) => rows[i].halves.push(run6(v, cand).cagr));
  }
  progress('금리 판단 비교(절반)', 1); process.stdout.write('\n');
  RT6.rows = rows;
}
// ── 추가 매수 비율 비교(STAGE7=0이면 건너뜀): 매달 현금(입금 + 판 돈)의 f%를 이미 가진 종목에 더 사고 나머지를 신규 종목에 씀. 대상: 보유 전체 · 수익 중만 · 손실 중만. f=0%가 지금 방식.
const AD = { rows: null };
if (process.env.STAGE7 !== '0') {
  const hash = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
  const B = +process.env.AD_HALVES || 8, topL7 = ym => scored[kA].get(ym) || [];
  const FR = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0], GR = [['all', '보유 전체'], ['win', '수익 중인 종목만'], ['lose', '손실 중인 종목만']];
  const VAR = [{ name: '지금 방식 (신규 매수 100%)', f: 0, g: 'all' }];
  GR.forEach(([g, gn]) => FR.forEach(f => VAR.push({ name: `${gn} ${Math.round(f * 100)}%`, f, g })));
  const run7 = (v, cand) => summ(simulate(ym => cand(ym).slice(0, 4), 4, C1, { lotSize: true, lotAll: true, fill: true, cand, firstDay: true, tpTrail: 2, grace: 2, graceRate: true, addFrac: v.f, addGroup: v.g }));
  const rows = VAR.map((v, i) => { progress('추가 매수 비교', i / VAR.length); return { v, full: run7(v, topL7), halves: [] }; });
  for (let b = 1; b <= B; b++) { progress('추가 매수 비교(절반)', (b - 1) / B); const cand = ym => topL7(ym).filter(e => hash(e.r.y + '|' + b) < 0.5); VAR.forEach((v, i) => rows[i].halves.push(run7(v, cand).cagr)); }
  progress('추가 매수 비교(절반)', 1); process.stdout.write('\n');
  AD.rows = rows;
}
// ── 추가 매수 심화(STAGE8=0이면 건너뜀): ① 수익 문턱(+0·10·25·50·100% 넘는 종목만) ② 대상 몫(같은 금액·평가금 비례·수익률 비례) ③ 다른 판매 규칙과 함께 ④ 종목 수 N과 함께(추가 매수 효과가 집중 때문인지 가림)
const AD2 = { sec: null };
if (process.env.STAGE8 !== '0') {
  const hash = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
  const B = +process.env.AD2_HALVES || 8, topL8 = ym => scored[kA].get(ym) || [];
  let rt2 = null; try { const RT = JSON.parse(fs.readFileSync(path.join(DATA, 'rates.json'))); const r = k => RT[ymOf(k)] || {}; rt2 = k => { const a = r(k).dgs2, b = r(k - 12).dgs2; return a != null && b != null ? a > b : null; }; } catch (e) {}
  const ADD = (f, thr, w) => ({ addFrac: f, addGroup: 'win', addThr: thr || 0, addW: w || 'equal' });
  const run8 = (v, cand) => summ(simulate(ym => cand(ym).slice(0, v.N || 4), v.N || 4, C1, { lotSize: true, lotAll: true, fill: true, cand, firstDay: true, tpTrail: 2, grace: 2, graceRate: true, ...(v.opt || {}) }));
  const S = [];                                                     // [구역, 이름, {N, opt}, 비교 기준 이름(없으면 첫 구역 기준)]
  const sec1 = '① 수익 문턱 (수익이 문턱을 넘는 종목에만 추가 매수, 같은 금액씩)', sec2 = '② 대상 몫 (수익 중인 종목에만)', sec3 = '③ 판매 규칙과 함께 (N=4)', sec4 = '④ 종목 수 N과 함께 (추가 매수 없음 vs 수익 중인 종목 100%)';
  S.push([sec1, '기준: 추가 매수 없음 (지금 방식)', {}, null]);
  [0, 0.1, 0.25, 0.5, 1].forEach(t => [0.5, 1].forEach(f => S.push([sec1, `수익 +${Math.round(t * 100)}% 넘는 종목 ${Math.round(f * 100)}%`, { opt: ADD(f, t) }, '기준: 추가 매수 없음 (지금 방식)'])));
  ['value', 'pnl'].forEach(w => [0.5, 1].forEach(f => S.push([sec2, `${w === 'value' ? '평가금 비례' : '수익률 비례'} ${Math.round(f * 100)}%`, { opt: ADD(f, 0, w) }, '기준: 추가 매수 없음 (지금 방식)'])));
  const sells = [['이탈 즉시', { grace: 0, graceRate: false }], ['유예2+금리(현재)', {}]];
  if (rt2) sells.push(['유예2+국채2년 12개월 변화', { rateFn: rt2 }]);
  sells.forEach(([n, o]) => { S.push([sec3, `${n} · 추가 매수 없음`, { opt: o }, null]); S.push([sec3, `${n} · 수익 중인 종목 100%`, { opt: { ...o, ...ADD(1) } }, `${n} · 추가 매수 없음`]); });
  [2, 3, 4, 6, 10].forEach(N => { S.push([sec4, `N=${N} · 추가 매수 없음`, { N }, null]); S.push([sec4, `N=${N} · 수익 중인 종목 100%`, { N, opt: ADD(1) }, `N=${N} · 추가 매수 없음`]); });
  const rows = S.map((x, i) => { progress('추가 매수 심화', i / S.length); return { sec: x[0], name: x[1], base: x[3], v: x[2], full: run8(x[2], topL8), halves: [] }; });
  for (let b = 1; b <= B; b++) { progress('추가 매수 심화(절반)', (b - 1) / B); const cand = ym => topL8(ym).filter(e => hash(e.r.y + '|' + b) < 0.5); rows.forEach(r => r.halves.push(run8(r.v, cand).cagr)); }
  progress('추가 매수 심화(절반)', 1); process.stdout.write('\n');
  AD2.sec = rows;
}
// ── 정배열인 보유 종목에만 추가 매수(STAGE9=0이면 건너뜀): 정배열 4가지 정의 × (정배열 전부 / 정배열이면서 수익 중) × 현금 50%·100%
const AD3 = { rows: null };
if (process.env.STAGE9 !== '0') {
  const hash = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
  const B = +process.env.AD3_HALVES || 8, topL9 = ym => scored[kA].get(ym) || [];
  const maAt = (o, k, n) => { let t = 0; for (let j = k; j > k - n; j--) { const p = o.m.get(j); if (p === undefined) return null; t += p; } return t / n; };
  const AL = {
    '종가>5>10>20이평': (o, k) => { const c = o.m.get(k), a = maAt(o, k, 5), b = maAt(o, k, 10), d = maAt(o, k, 20); return c != null && a != null && b != null && d != null && c > a && a > b && b > d; },
    '5>10>20이평': (o, k) => { const a = maAt(o, k, 5), b = maAt(o, k, 10), d = maAt(o, k, 20); return a != null && b != null && d != null && a > b && b > d; },
    '종가>10>24이평': (o, k) => { const c = o.m.get(k), b = maAt(o, k, 10), d = maAt(o, k, 24); return c != null && b != null && d != null && c > b && b > d; },
    '10>24이평+10이평 상승': (o, k) => { const b = maAt(o, k, 10), b1 = maAt(o, k - 1, 10), d = maAt(o, k, 24); return b != null && b1 != null && d != null && b > d && b > b1; }
  };
  const V = [['추가 매수 없음 (지금 방식)', {}], ['수익 중인 종목 100% (참고: 앞 시험 유력 후보)', { addFrac: 1, addGroup: 'win' }], ['수익 중인 종목 50% (참고)', { addFrac: 0.5, addGroup: 'win' }]];
  Object.entries(AL).forEach(([n, fn]) => [['all', '정배열 전부'], ['win', '정배열 + 수익 중']].forEach(([g, gn]) => [0.5, 1].forEach(f => V.push([`${n} · ${gn} ${f * 100}%`, { addFrac: f, addGroup: g, addAlign: fn }]))));
  const run9 = (o, cand) => summ(simulate(ym => cand(ym).slice(0, 4), 4, C1, { lotSize: true, lotAll: true, fill: true, cand, firstDay: true, tpTrail: 2, grace: 2, graceRate: true, ...o }));
  const rows = V.map((v, i) => { progress('정배열 추가 매수', i / V.length); return { name: v[0], o: v[1], full: run9(v[1], topL9), halves: [] }; });
  for (let b = 1; b <= B; b++) { progress('정배열 추가 매수(절반)', (b - 1) / B); const cand = ym => topL9(ym).filter(e => hash(e.r.y + '|' + b) < 0.5); rows.forEach(r => r.halves.push(run9(r.o, cand).cagr)); }
  progress('정배열 추가 매수(절반)', 1); process.stdout.write('\n');
  AD3.rows = rows;
}
// ── 정배열 심화(STAGE10=0이면 건너뜀): ① 정배열 + 수익 문턱(+10·25%)에만 추가 매수 ② 정배열이 깨진 종목은 전부 판매(깨진 즉시 / 한 번 정배열이 된 뒤 깨졌을 때만), 추가 매수와 함께·없이
const AD4 = { rows: null };
if (process.env.STAGE10 !== '0') {
  const hash = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
  const B = +process.env.AD4_HALVES || 8, topL10 = ym => scored[kA].get(ym) || [];
  const maAt = (o, k, n) => { let t = 0; for (let j = k; j > k - n; j--) { const p = o.m.get(j); if (p === undefined) return null; t += p; } return t / n; };
  const AL = {
    '종가>5>10>20이평': (o, k) => { const c = o.m.get(k), a = maAt(o, k, 5), b = maAt(o, k, 10), d = maAt(o, k, 20); return (c != null && a != null && b != null && d != null) ? (c > a && a > b && b > d) : null; },
    '5>10>20이평': (o, k) => { const a = maAt(o, k, 5), b = maAt(o, k, 10), d = maAt(o, k, 20); return (a != null && b != null && d != null) ? (a > b && b > d) : null; },
    '종가>10>24이평': (o, k) => { const c = o.m.get(k), b = maAt(o, k, 10), d = maAt(o, k, 24); return (c != null && b != null && d != null) ? (c > b && b > d) : null; },
    '10>24이평+10이평 상승': (o, k) => { const b = maAt(o, k, 10), b1 = maAt(o, k - 1, 10), d = maAt(o, k, 24); return (b != null && b1 != null && d != null) ? (b > d && b > b1) : null; }
  };
  const alOK = fn => (o, k) => fn(o, k) === true;                    // 추가 매수용: 모르면 아님
  const V = [['추가 매수 없음 (지금 방식)', {}], ['수익 중인 종목 100% (참고)', { addFrac: 1, addGroup: 'win' }]];
  const SEC1 = '① 정배열 + 수익 문턱', SEC2 = '② 정배열이 깨지면 전부 판매';
  Object.entries(AL).forEach(([n, fn]) => [0.1, 0.25].forEach(t => [0.5, 1].forEach(f => V.push([`${SEC1} | ${n} · 수익 +${t * 100}% 넘는 종목 ${f * 100}%`, { addFrac: f, addGroup: 'win', addThr: t, addAlign: alOK(fn) }]))));
  Object.entries(AL).forEach(([n, fn]) => [[true, '한 번 정배열이 된 뒤 깨지면'], [false, '정배열이 아니면 바로']].forEach(([arm, an]) => {
    V.push([`${SEC2} | ${n} · ${an} 판매 (추가 매수 없음)`, { alignExit: fn, alignArm: arm }]);
    V.push([`${SEC2} | ${n} · ${an} 판매 + 정배열 전부 100% 추가 매수`, { alignExit: fn, alignArm: arm, addFrac: 1, addGroup: 'all', addAlign: alOK(fn) }]);
  }));
  const run10 = (o, cand) => summ(simulate(ym => cand(ym).slice(0, 4), 4, C1, { lotSize: true, lotAll: true, fill: true, cand, firstDay: true, tpTrail: 2, grace: 2, graceRate: true, ...o }));
  const rows = V.map((v, i) => { progress('정배열 심화', i / V.length); return { name: v[0], o: v[1], full: run10(v[1], topL10), halves: [] }; });
  for (let b = 1; b <= B; b++) { progress('정배열 심화(절반)', (b - 1) / B); const cand = ym => topL10(ym).filter(e => hash(e.r.y + '|' + b) < 0.5); rows.forEach(r => r.halves.push(run10(r.o, cand).cagr)); }
  progress('정배열 심화(절반)', 1); process.stdout.write('\n');
  AD4.rows = rows;
}
// ── 초기 구매 방식 × 정배열 추가 매수 묶음(STAGE11=0이면 건너뜀): events.csv가 어떤 방식(돌파/이평 위/이평 위+정배열)으로 만든 것이든 같은 네 가지 규칙을 비교
//    V1 = "5>10>20 정배열이 아니면 바로 판매 + 정배열인 보유 종목 전부에 현금 100% 추가 매수"(사용자 요청 전략)
const AD5 = { rows: null };
if (process.env.STAGE11 !== '0') {
  const hash = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
  const B = +process.env.AD5_HALVES || 8, topL11 = ym => scored[kA].get(ym) || [];
  const maAt = (o, k, n) => { let t = 0; for (let j = k; j > k - n; j--) { const p = o.m.get(j); if (p === undefined) return null; t += p; } return t / n; };
  const al = (o, k) => { const a = maAt(o, k, 5), b = maAt(o, k, 10), d = maAt(o, k, 20); return (a != null && b != null && d != null) ? (a > b && b > d) : null; };
  const alOK = (o, k) => al(o, k) === true;
  const V = [['V0 지금 판매 규칙, 추가 매수 없음', {}], ['V1 정배열 아니면 바로 판매 + 정배열 전부 100% 추가 매수', { alignExit: al, alignArm: false, addFrac: 1, addGroup: 'all', addAlign: alOK }],
    ['V2 정배열 전부 100% 추가 매수만', { addFrac: 1, addGroup: 'all', addAlign: alOK }], ['V3 정배열 아니면 바로 판매만', { alignExit: al, alignArm: false }]];
  const run11 = (o, cand) => summ(simulate(ym => cand(ym).slice(0, 4), 4, C1, { lotSize: true, lotAll: true, fill: true, cand, firstDay: true, tpTrail: 2, grace: 2, graceRate: true, ...o }));
  const rows = V.map((v, i) => { progress('초기 구매 방식', i / V.length); const sm = simulate(ym => topL11(ym).slice(0, 4), 4, C1, { lotSize: true, lotAll: true, fill: true, cand: topL11, firstDay: true, tpTrail: 2, grace: 2, graceRate: true, log: true, ...v[1] }); const m = summ(sm), T = (sm.trades || []).filter(t => t.sellYm); return { name: v[0], o: v[1], full: m, trades: T.length, win: T.filter(t => t.ret > 0).length / (T.length || 1), halves: [] }; });
  for (let b = 1; b <= B; b++) { progress('초기 구매 방식(절반)', (b - 1) / B); const cand = ym => topL11(ym).filter(e => hash(e.r.y + '|' + b) < 0.5); rows.forEach(r => r.halves.push(run11(r.o, cand).cagr)); }
  progress('초기 구매 방식(절반)', 1); process.stdout.write('\n');
  AD5.rows = rows; AD5.events = ALL.length;
}
// ── 확인 매수(STAGE12=0이면 건너뜀): 10이평을 처음 돌파한 달에 "샀다고 가정"(가상 매수: 다음 달 첫날 종가)하고, 그 가상 수익이 문턱(0·10·20·30%) 이상이면서(옵션: 5>10>20 정배열) 가상 포지션이 아직 안 팔렸을 때 비로소 실제로 매수(그달 말 판단 → 다음 달 첫날).
//    가상 포지션이 먼저 팔리는 조건(익절 트레일 2배, 유예 2달·금리 규칙)에 걸리면 그 신호는 버림. 후보 점수는 돌파 시점 점수(그때 알던 값). 이후 판매·추가 매수는 V0(지금 규칙) 또는 V1(정배열 이탈 판매 + 정배열 전부 100% 추가 매수).
const AD6 = { rows: null };
if (process.env.STAGE12 !== '0') {
  const hash = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
  const B = +process.env.AD6_HALVES || 8, topL12 = ym => scored[kA].get(ym) || [];
  const maAt = (o, k, n) => { let t = 0; for (let j = k; j > k - n; j--) { const p = o.m.get(j); if (p === undefined) return null; t += p; } return t / n; };
  const al = (o, k) => { const a = maAt(o, k, 5), b = maAt(o, k, 10), d = maAt(o, k, 20); return (a != null && b != null && d != null) ? (a > b && b > d) : null; };
  const alOK = (o, k) => al(o, k) === true;
  const trigOf = (r, thr, needAlign) => {                            // 이 돌파 신호가 처음으로 "문턱 이상 + (정배열)"이 되는 달(월 인덱스), 없으면 null
    const o = px(r.y), t0 = mi(r.ym), p0 = fdPx(r.y, t0 + 1); if (!(p0 > 0)) return null;
    let tp = false, cnt = 0;
    for (let j = t0 + 1; j <= END; j++) {
      const p = o.m.get(j); if (p === undefined) return null;
      const ma = ma10(o, j);
      if (ma) {
        if (p >= 2 * ma) tp = true; else if (tp) return null;        // 가상 포지션이 익절 트레일로 팔림
        if (p < ma) { cnt++; const ff = ffChg12(j), n = (ff != null && ff > 0) ? 1 : 2; if (cnt >= n) return null; } else cnt = 0;   // 유예 2달(금리 오르면 즉시)로 팔림
      }
      if (p / p0 - 1 >= thr && (!needAlign || al(o, j) === true)) return j;
    }
    return null;
  };
  const buildMap = (thr, needAlign) => {
    const m = new Map();
    scored[kA].forEach(list => list.forEach(e => { const tk = trigOf(e.r, thr, needAlign); if (tk == null) return; const ym = ymOf(tk), r2 = Object.assign({}, e.r, { ym, exoff: null }), a = m.get(ym) || []; a.push({ r: r2, s: e.s }); m.set(ym, a); }));
    m.forEach(a => a.sort((x, y) => y.s - x.s)); return m;
  };
  const V1 = { alignExit: al, alignArm: false, addFrac: 1, addGroup: 'all', addAlign: alOK };
  const V = [{ name: '즉시 매수(돌파 달, 현재) · V0 지금 규칙', cand: topL12, o: {}, tag: 'I0' }, { name: '즉시 매수(돌파 달, 현재) · V1 정배열 묶음', cand: topL12, o: V1, tag: 'I1' }];
  let ci = 0; const combos = []; (process.env.AD6_THR ? process.env.AD6_THR.split(',').map(Number) : [0, 0.1, 0.2, 0.3]).forEach(t => (process.env.AD6_ALIGN === '1' ? [true] : [true, false]).forEach(a => combos.push([t, a])));   // AD6_THR=0.01,0.02,... 문턱 목록, AD6_ALIGN=1이면 정배열만
  combos.forEach(([t, a]) => { progress('확인 매수 후보 만들기', ci++ / combos.length); const mp = buildMap(t, a), cand = ym => mp.get(ym) || [], nm = `확인 매수(가상 수익 +${t * 100}% 이상${a ? ' + 5>10>20 정배열' : ''})`; V.push({ name: `${nm} · V0 지금 규칙`, cand, o: {}, n: [...mp.values()].reduce((x, l) => x + l.length, 0), tag: 'D0' }); V.push({ name: `${nm} · V1 정배열 묶음`, cand, o: V1, tag: 'D1' }); });
  const run12 = (v, cand) => summ(simulate(ym => cand(ym).slice(0, 4), 4, C1, { lotSize: true, lotAll: true, fill: true, cand, firstDay: true, tpTrail: 2, grace: 2, graceRate: true, ...v.o }));
  const rows = V.map((v, i) => { progress('확인 매수', i / V.length); const sm = simulate(ym => v.cand(ym).slice(0, 4), 4, C1, { lotSize: true, lotAll: true, fill: true, cand: v.cand, firstDay: true, tpTrail: 2, grace: 2, graceRate: true, log: true, ...v.o }); const m = summ(sm), T = (sm.trades || []).filter(t => t.sellYm); return { v, full: m, trades: T.length, win: T.filter(t => t.ret > 0).length / (T.length || 1), halves: [] }; });
  for (let b = 1; b <= B; b++) { progress('확인 매수(절반)', (b - 1) / B); rows.forEach(r => { const cand = ym => r.v.cand(ym).filter(e => hash(e.r.y + '|' + b) < 0.5); r.halves.push(run12(r.v, cand).cagr); }); }
  progress('확인 매수(절반)', 1); process.stdout.write('\n');
  AD6.rows = rows;
}
// ── 확인 매수 심화(STAGE13=0이면 건너뜀): ① 확인 매수 + 추가 매수 ② 정배열 정의 4가지 ③ 점수 기여(점수순 vs 무작위 vs 점수 낮은 순 vs 가상 수익순)
const AD7 = { sec: null };
if (process.env.STAGE13 !== '0') {
  const hash = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
  const B = +process.env.AD7_HALVES || 8, topL13 = ym => scored[kA].get(ym) || [];
  const maAt = (o, k, n) => { let t = 0; for (let j = k; j > k - n; j--) { const p = o.m.get(j); if (p === undefined) return null; t += p; } return t / n; };
  const AL = {
    '종가>5>10>20이평': (o, k) => { const c = o.m.get(k), a = maAt(o, k, 5), b = maAt(o, k, 10), d = maAt(o, k, 20); return (c != null && a != null && b != null && d != null) ? (c > a && a > b && b > d) : null; },
    '5>10>20이평': (o, k) => { const a = maAt(o, k, 5), b = maAt(o, k, 10), d = maAt(o, k, 20); return (a != null && b != null && d != null) ? (a > b && b > d) : null; },
    '종가>10>24이평': (o, k) => { const c = o.m.get(k), b = maAt(o, k, 10), d = maAt(o, k, 24); return (c != null && b != null && d != null) ? (c > b && b > d) : null; },
    '10>24이평+10이평 상승': (o, k) => { const b = maAt(o, k, 10), b1 = maAt(o, k - 1, 10), d = maAt(o, k, 24); return (b != null && b1 != null && d != null) ? (b > d && b > b1) : null; }
  };
  const A2 = AL['5>10>20이평'], alOK = fn => (o, k) => fn(o, k) === true;
  const trig = (r, thr, fn) => {                                      // 돌파 신호가 처음으로 "가상 수익 ≥ 문턱 + (정배열)"이 되는 달과 그때 가상 수익
    const o = px(r.y), t0 = mi(r.ym), p0 = fdPx(r.y, t0 + 1); if (!(p0 > 0)) return null;
    let tp = false, cnt = 0;
    for (let j = t0 + 1; j <= END; j++) {
      const p = o.m.get(j); if (p === undefined) return null;
      const ma = ma10(o, j);
      if (ma) { if (p >= 2 * ma) tp = true; else if (tp) return null; if (p < ma) { cnt++; const ff = ffChg12(j), n = (ff != null && ff > 0) ? 1 : 2; if (cnt >= n) return null; } else cnt = 0; }
      if (p / p0 - 1 >= thr && (!fn || fn(o, j) === true)) return { j, pnl: p / p0 - 1 };
    }
    return null;
  };
  const mapCache = new Map();
  const getMap = (thr, fnName) => {
    const key = thr + '|' + fnName; if (mapCache.has(key)) return mapCache.get(key);
    const fn = fnName === '없음' ? null : AL[fnName], m = new Map();
    scored[kA].forEach(list => list.forEach(e => { const t = trig(e.r, thr, fn); if (!t) return; const ym = ymOf(t.j), r2 = Object.assign({}, e.r, { ym, exoff: null }), a = m.get(ym) || []; a.push({ r: r2, s: e.s, pnl: t.pnl }); m.set(ym, a); }));
    m.forEach(a => a.sort((x, y) => y.s - x.s)); mapCache.set(key, m); return m;
  };
  const run13 = (o, cand, N) => summ(simulate(ym => cand(ym).slice(0, N || 4), N || 4, C1, { lotSize: true, lotAll: true, fill: true, cand, firstDay: true, tpTrail: 2, grace: 2, graceRate: true, ...o }));
  const SEC1 = '① 확인 매수 + 추가 매수', SEC2 = '② 정배열 정의', SEC3 = '③ 점수 기여';
  const V = [];
  [0, 0.1].forEach(t => {
    const mp = getMap(t, '5>10>20이평'), cand = ym => mp.get(ym) || [], tn = `확인 매수(가상 +${t * 100}% 이상 + 5>10>20)`;
    V.push({ sec: SEC1, name: `${tn} · 추가 매수 없음`, cand, o: {}, base: null });
    V.push({ sec: SEC1, name: `${tn} · 수익 중인 종목 100% 추가 매수`, cand, o: { addFrac: 1, addGroup: 'win' }, base: `${tn} · 추가 매수 없음` });
    V.push({ sec: SEC1, name: `${tn} · 정배열 전부 100% 추가 매수`, cand, o: { addFrac: 1, addGroup: 'all', addAlign: alOK(A2) }, base: `${tn} · 추가 매수 없음` });
    V.push({ sec: SEC1, name: `${tn} · 정배열+수익 +10% 넘는 종목 100% 추가 매수`, cand, o: { addFrac: 1, addGroup: 'win', addThr: 0.1, addAlign: alOK(A2) }, base: `${tn} · 추가 매수 없음` });
  });
  [0, 0.1].forEach(t => Object.keys(AL).forEach(n => { const mp = getMap(t, n), cand = ym => mp.get(ym) || []; V.push({ sec: SEC2, name: `가상 +${t * 100}% 이상 · ${n}`, cand, o: {}, base: t === 0 ? '가상 +0% 이상 · 5>10>20이평' : '가상 +10% 이상 · 5>10>20이평' }); }));
  const rows = V.map((v, i) => { progress('확인 매수 심화', i / V.length); return Object.assign(v, { full: run13(v.o, v.cand), halves: [] }); });
  for (let b = 1; b <= B; b++) { progress('확인 매수 심화(절반)', (b - 1) / B); rows.forEach(r => { const cand = ym => r.cand(ym).filter(e => hash(e.r.y + '|' + b) < 0.5); r.halves.push(run13(r.o, cand).cagr); }); }
  progress('확인 매수 심화(절반)', 1); process.stdout.write('\n');
  // ③ 점수 기여: 같은 후보 풀(확인 매수 가상 +0%·+10% + 5>10>20)에서 고르는 순서만 바꿈
  const s3 = [];
  [0, 0.1].forEach(t => {
    const mp = getMap(t, '5>10>20이평'), order = (f) => ym => f([...(mp.get(ym) || [])], ym);
    const byScore = order(a => a), bottom = order(a => a.reverse()), pnlHi = order(a => a.sort((x, y) => y.pnl - x.pnl)), pnlLo = order(a => a.sort((x, y) => x.pnl - y.pnl));
    const g = (cand) => run13({}, cand);
    const rnd = []; for (let sd = 1; sd <= (+process.env.AD7_SEEDS || 20); sd++) { const rr = ym => { const a = [...(mp.get(ym) || [])], r = rng(sd * 7 + (ym % 997)); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }; rnd.push(run13({}, rr).cagr); }
    rnd.sort((x, y) => x - y);
    s3.push({ t, score: g(byScore), bottom: g(bottom), pnlHi: g(pnlHi), pnlLo: g(pnlLo), rnd });
  });
  AD7.sec = { rows, s3, B };
}

// ── 확인 매수 후속 시험(STAGE14=0이면 건너뜀): 기준 = 가상 +10% + 5>10>20, tp2x 트레일 + 유예2 + 금리, 점수 상위 4
//   ① 판매 규칙(익절 배수 × 유예 × 금리; 가상 포지션도 같은 규칙) ② 보유 종목 수 N ③ 확인 기한(돌파 후 W달 안) ④ 손절선 ⑤ 변동성 문턱(가상 수익 ≥ k × 12개월 변동성)
//   ⑥ 점수 비례 비중(앞순위에 더) ⑦ 확인 시점 정보로 순서 바꾸기(재학습 없이 대용: 가상 수익·돌파 후 경과·돌파 후 고점 대비 위치)
const AD8 = { sec: null };
if (process.env.STAGE14 !== '0') {
  const hash = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
  const B = +process.env.AD8_HALVES || 8, iVol = fi('volat12');
  const maAt = (o, k, n) => { let t = 0; for (let j = k; j > k - n; j--) { const p = o.m.get(j); if (p === undefined) return null; t += p; } return t / n; };
  const aligned = (o, k) => { const a = maAt(o, k, 5), b = maAt(o, k, 10), d = maAt(o, k, 20); return (a != null && b != null && d != null) ? (a > b && b > d) : null; };
  const alignMode = (mode, o, k) => {                                // 정배열 변형(튜닝 시험용): full = 5>10>20(현재), s5_10 = 5>10만, p20 = 5>10 이고 종가>20이평, none = 안 봄
    const a = maAt(o, k, 5), b = maAt(o, k, 10), d = maAt(o, k, 20), c = o.m.get(k);
    if (mode === 'none') return true;
    if (a == null || b == null) return null;
    if (mode === 's5_10') return a > b;
    if (mode === 'p20') return d == null ? null : (a > b && c > d);
    return d == null ? null : (a > b && b > d);
  };
  let RT14 = null; try { RT14 = JSON.parse(fs.readFileSync(path.join(DATA, 'rates.json'))); } catch (e) {}
  const rtk = k => (RT14 && RT14[ymOf(k)]) || {};
  const chg = (key, m) => k => { const a = rtk(k)[key], b = rtk(k - m)[key]; return a != null && b != null ? a > b : null; };
  const RULE0 = { tp: 2, grace: 2, rate: true };                     // 지금 규칙
  // 풀 만들기: 돌파 신호 → (가상 포지션이 팔리기 전에) 처음으로 "가상 수익 ≥ 문턱 + 정배열"인 달에 후보. 문턱 = thr 또는 volK × 12개월 변동성
  const poolCache = new Map();
  const pool = (q) => {
    const rule = q.rule || RULE0, key = JSON.stringify([q.thr, q.volK, q.maxWait, rule, q.rateName, q.align, q.ck, q.rebuy]);
    if (poolCache.has(key)) return poolCache.get(key);
    const m = new Map(), rateVirt = rule.rateFn || (rule.rate ? (j => { const f = ffChg12(j); return f != null && f > 0 ? true : null; }) : null);
    scored[kA].forEach(list => list.forEach(e => {
      const r = e.r, o = px(r.y), t0 = mi(r.ym); let p0 = q.refClose ? o.m.get(t0) : (o.op.get(t0 + 1) || fdPx(r.y, t0 + 1)); if (!(p0 > 0)) return;
      if (q.sig && !q.sig(r, o, t0)) return;                              // 시험용: 돌파 신호 자체를 거르는 조건
      const thr = q.thrFn ? q.thrFn(r) : (q.volK ? Math.min(0.4, Math.max(0.03, q.volK * (r.x[iVol] || 0))) : q.thr);
      let tp = false, cnt = 0, hi = p0, held = false; const st = {};
      for (let j = t0 + 1; j <= END; j++) {
        const p = o.m.get(j); if (p === undefined) return;
        if (q.maxWait && j - t0 > q.maxWait) return;
        const ma = ma10(o, j);
        if (ma) {
          if (rule.tp) { if (p >= rule.tp * ma) tp = true; else if (tp) { if (q.rebuy) { p0 = p; tp = false; cnt = 0; hi = p; held = false; continue; } return; } }
          const mx = rule.exitMaN ? maAtN(o, j, rule.exitMaN) : ma;
          if (mx && p < mx * (1 - (rule.exitBuf || 0))) { if (!rule.grace) { if (q.rebuy) { p0 = p; tp = false; cnt = 0; hi = p; held = false; continue; } return; } cnt++; const up = rateVirt && rateVirt(j) === true, rv = !!(rule.revFn && rule.revFn(o, j)); if (cnt >= ((up || rv) ? 1 : rule.grace)) { if (q.rebuy) { p0 = p; tp = false; cnt = 0; hi = p; held = false; continue; } return; } } else cnt = 0;
        }
        if (p > hi) hi = p;
        if (held) continue;                                              // 재매수 시험: 산 동안(가상)에는 새 후보를 안 냄
        const cx = { o, j, p, p0, hi, t0, r, st }, okC = q.confirm ? q.confirm(cx) : (p / p0 - 1 >= thr);
        if (okC && (q.alignFn ? q.alignFn(o, j) === true : alignMode(q.align || 'full', o, j) === true) && (!q.cond || q.cond(cx))) {
          const ym = ymOf(j), r2 = Object.assign({}, r, { ym, exoff: null }), a = m.get(ym) || [];
          a.push({ r: r2, s: e.s, pnl: p / p0 - 1, wait: j - t0, pos: p / hi, sym: r.ym, cj: j }); m.set(ym, a); if (q.rebuy) { held = true; tp = false; cnt = 0; hi = p; continue; } return;
        }
      }
    }));
    m.forEach(a => a.sort((x, y) => y.s - x.s)); poolCache.set(key, m); return m;
  };
  const simOpt = (rule, extra) => ({ lotSize: true, lotAll: true, fill: true, firstDay: true, ...(rule.tp ? { tpTrail: rule.tp } : {}), ...(rule.grace ? { grace: rule.grace, graceRate: !!rule.rate } : {}), ...(rule.rateFn ? { rateFn: rule.rateFn, graceRate: true } : {}), ...(rule.revFn ? { revFn: rule.revFn } : {}), ...extra });
  const run14 = (v, filt) => {
    let cand = v.cand; if (filt) cand = ym => v.cand(ym).filter(filt);
    const o = simOpt(v.rule || RULE0, v.o || {}), N = v.N || 4;
    return summ(simulate(ym => cand(ym).slice(0, N), N, v.C || C1, { ...o, cand }, v.dep != null ? v.dep : DEP));
  };
  const rankOrder = (m, keys) => ym => { const a = [...(m.get(ym) || [])]; if (a.length < 2) return a; const sc = new Map(a.map(e => [e, 0])); keys.forEach(kf => { [...a].sort((x, y) => kf(y) - kf(x)).forEach((e, i) => sc.set(e, sc.get(e) + i)); }); return a.sort((x, y) => sc.get(x) - sc.get(y)); };
  const V = [], BASEN = '기준 · 가상 +10% + 정배열 · tp2x 유예2 금리 · 상위 4';
  const add = (sec, name, q, extra) => { const m = pool(q); V.push({ sec, name, cand: ym => m.get(ym) || [], ...extra }); return m; };
  const mBase = add('기준', BASEN, { thr: 0.1 }, {});
  // ① 판매 규칙
  const S1 = '① 판매 규칙(가상 포지션도 같은 규칙)';
  [0, 1.5, 2, 3].forEach(tp => [[0, false], [2, false], [2, true], [3, false], [3, true]].forEach(([g, rt]) => {
    if (tp === 2 && g === 2 && rt) return;
    const rule = { tp, grace: g, rate: rt }; add(S1, `익절 ${tp ? tp + '배 트레일' : '없음'} · ${g ? '유예 ' + g + '달' + (rt ? '+금리' : '') : '이탈 즉시'}`, { thr: 0.1, rule }, { rule });
  }));
  if (RT14) [['국채2년 12개월 변화>0', chg('dgs2', 12)], ['국채10년 6개월 변화>0', chg('dgs10', 6)], ['목표금리 12개월 변화>0', chg('tgt', 12)], ['목표금리 6개월 변화>0', chg('tgt', 6)]].forEach(([nm, fn]) => {
    const rule = { tp: 2, grace: 2, rate: true, rateFn: fn }; add(S1, `tp2x · 유예 2달 · 금리 판단 = ${nm}`, { thr: 0.1, rule, rateName: nm }, { rule });
  });
  // ② N
  [2, 3, 5, 6, 8, 10].forEach(n => add('② 보유 종목 수', `상위 ${n}`, { thr: 0.1 }, { N: n }));
  // ③ 확인 기한
  [2, 3, 4, 6, 9, 12].forEach(w => add('③ 확인 기한(돌파 후 W달 안에 확인될 때만)', `돌파 후 ${w}달 안`, { thr: 0.1, maxWait: w }, {}));
  // ④ 손절
  [0.1, 0.15, 0.2, 0.25, 0.3].forEach(sl => V.push({ sec: '④ 손절선(매수가 대비 월말 종가)', name: `−${sl * 100}% 손절`, cand: ym => mBase.get(ym) || [], o: { sl } }));
  // ⑤ 변동성 문턱
  [0.5, 1, 1.5, 2, 3].forEach(k => add('⑤ 변동성 문턱(가상 수익 ≥ k × 12개월 변동성, 3~40%로 제한)', `k = ${k}`, { volK: k }, {}));
  // ⑥ 점수 비례 비중
  V.push({ sec: '⑥ 비중(점수 순위 비례)', name: '앞순위에 더(4:3:2:1)', cand: ym => mBase.get(ym) || [], o: { wRank: 1 } });
  V.push({ sec: '⑥ 비중(점수 순위 비례)', name: '뒷순위에 더(1:2:3:4, 대조)', cand: ym => mBase.get(ym) || [], o: { wRank: -1 } });
  // ⑦ 순서 바꾸기
  const S7 = '⑦ 확인 시점 정보로 순서 바꾸기(같은 후보 풀)', sRank = e => e.s;
  [['점수 + 가상 수익 순위합', [sRank, e => e.pnl]], ['점수 + 돌파 후 경과 짧은 순', [sRank, e => -e.wait]], ['점수 + 돌파 후 고점 대비 위치(높은 순)', [sRank, e => e.pos]], ['점수 + 세 가지 모두', [sRank, e => e.pnl, e => -e.wait, e => e.pos]]]
    .forEach(([nm, keys]) => V.push({ sec: S7, name: nm, cand: rankOrder(mBase, keys) }));
  if (process.env.AD8_COMBO === '1' && RT14) {                          // 합치기 시험: 금리(국채10년 6개월) R · 확인 기한 W3/W4 · 앞순위 비중 P · 점수+가상 수익 순서 O
    V.length = 1; const SC = '합치기(각각 두 범위에서 플러스였던 것)', rule10 = { tp: 2, grace: 2, rate: true, rateFn: chg('dgs10', 6) }, rname = '국채10년 6개월';
    const mk = (nm, R, W, P, O) => { const q = { thr: 0.1, ...(R ? { rule: rule10, rateName: rname } : {}), ...(W ? { maxWait: W } : {}) }, m = pool(q); V.push({ sec: SC, name: nm, cand: O ? rankOrder(m, [sRank, e => e.pnl]) : ym => m.get(ym) || [], ...(R ? { rule: rule10 } : {}), ...(P ? { o: { wRank: 1 } } : {}) }); };
    mk('R 금리(국채10년 6개월)', 1, 0, 0, 0); mk('W3 확인 기한 3달', 0, 3, 0, 0); mk('W4 확인 기한 4달', 0, 4, 0, 0); mk('P 앞순위 비중', 0, 0, 1, 0); mk('O 점수+가상 수익 순서', 0, 0, 0, 1);
    mk('R + W3', 1, 3, 0, 0); mk('R + W4', 1, 4, 0, 0); mk('R + P', 1, 0, 1, 0); mk('W3 + P', 0, 3, 1, 0); mk('W4 + P', 0, 4, 1, 0);
    mk('R + W3 + P', 1, 3, 1, 0); mk('R + W4 + P', 1, 4, 1, 0); mk('R + W3 + P + O', 1, 3, 1, 1); mk('R + W4 + P + O', 1, 4, 1, 1);
  }
  if (process.env.AD8_REINV === '1' && RT14) {                          // 재투자 비중: 매도한 돈(입금 포함 현금)의 신규 매수 몫 x% (0~100, 5% 단위), 나머지는 보유 종목 추가 매수(수익 중인 종목 / 전부). 금리 판단 = 지금 채택(국채10년 6개월)
    V.length = 0; const rule10 = { tp: 2, grace: 2, rate: true, rateFn: chg('dgs10', 6) }, m = pool({ thr: 0.1, rule: rule10, rateName: '국채10년 6개월' }), cand = ym => m.get(ym) || [];
    V.push({ sec: '기준', name: '신규 100% (추가 매수 없음, 지금)', cand, rule: rule10 });
    [['win', '수익 중인 종목'], ['all', '보유 종목 전부']].forEach(([g, gn]) => { for (let x = 95; x >= 0; x -= 5) V.push({ sec: `재투자 비중 · 나머지는 ${gn}에 추가 매수`, name: `신규 ${x}% · 보유 ${100 - x}%`, cand, rule: rule10, o: { addFrac: (100 - x) / 100, addGroup: g, addThr: 0 } }); });
  }
  if (process.env.AD8_WF === '1' && RT14) {                             // 걸어가며 고르기(확인 매수 포함): 해마다 그 전 연도 성과만 보고 설정을 골라 그해 성과를 이어 붙임
    V.length = 0;
    const ENT = [['즉시 매수', null], ['확인 +3%', 0.03], ['확인 +5%', 0.05], ['확인 +10%', 0.1], ['확인 +15%', 0.15], ['확인 +20%', 0.2]];
    const RATES = [['금리 없음', null], ['기준금리12m(옛)', 'ff'], ['국채10년6m', chg('dgs10', 6)], ['국채2년12m', chg('dgs2', 12)], ['목표금리12m', chg('tgt', 12)]];
    const TPS = [0, 2, 3], GR = [0, 2, 3], NS = (process.env.AD8_WF_N || '4').split(',').map(Number), cfgs = []; let ci = 0; const total = NS.length * ENT.length * TPS.length * (1 + 2 * RATES.length);
    NS.forEach(N => ENT.forEach(([en, thr]) => TPS.forEach(tp => GR.forEach(g => (g ? RATES : [['-', null]]).forEach(([rn, rv]) => {
      progress('걸어가며 고르기(확인 매수 포함)', ci++ / total);
      const rule = { tp, grace: g, rate: rv === 'ff', ...(rv && rv !== 'ff' ? { rateFn: rv } : {}) };
      const m = thr ? pool({ thr, rule, rateName: rn }) : null, cand = thr ? (ym => m.get(ym) || []) : (ym => scored[kA].get(ym) || []);
      const sm = run14({ cand, rule, N }, null);
      cfgs.push({ en, thr, tp, g, rn, N, name: `N${N} · ${en} · ${tp ? 'tp' + tp + 'x' : '익절없음'} · ${g ? '유예' + g + '달 + ' + rn : '이탈 즉시'}`, yearly: sm.yearly, cagr: sm.cagr });
    })))));
    progress('걸어가며 고르기(확인 매수 포함)', 1); process.stdout.write('\n');
    const Ys = YEARS_ALL, first = 3, oosYears = Ys.slice(first), pc1 = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
    const gm = (c, ys) => ys.length ? Math.pow(ys.reduce((p, y) => p * (1 + (c.yearly[y] ?? 0)), 1), 1 / ys.length) - 1 : -9;
    const CRIT = { '확장 연평균(과거 전부)': (c, ys) => gm(c, ys), '최근 5년 연평균': (c, ys) => gm(c, ys.slice(-5)),
      '평균 − 0.5×표준편차': (c, ys) => { const v = ys.map(y => c.yearly[y] ?? 0), mu = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - mu) ** 2, 0) / v.length); return mu - 0.5 * sd; } };
    const SPACES = [['전체(즉시 + 확인 매수)', c => true], ['즉시 매수만(예전 방식의 설정 고르기)', c => !c.thr], ['확인 매수만', c => !!c.thr]];
    const find = (en, tp, g, rn) => cfgs.find(c => c.N === 4 && c.en === en && c.tp === tp && c.g === g && c.rn === rn);
    const fixed = find('확인 +10%', 2, 2, '국채10년6m'), old = find('즉시 매수', 2, 2, '기준금리12m(옛)');
    log(''); log(`## 걸어가며 고르기(확인 매수 포함): 해마다 그 전 연도 성과만 보고 설정을 골라 그해에 씀 (${oosYears[0]}~${oosYears[oosYears.length - 1]}, 후보 ${cfgs.length}가지, 점수 상위 4, 첫날 체결, 월 100만원)`);
    log(`고정: 지금 전략(확인 +10% · tp2x · 유예2+국채10년6m) ${pc1(gm(fixed, oosYears))} · 예전 전략(즉시 · tp2x · 유예2+기준금리12m) ${pc1(gm(old, oosYears))} · 후보 평균 ${pc1(cfgs.reduce((a, c) => a + gm(c, oosYears), 0) / cfgs.length)} · 사후 최고 ${pc1(Math.max(...cfgs.map(c => gm(c, oosYears))))} (${cfgs.reduce((b, c) => gm(c, oosYears) > gm(b, oosYears) ? c : b).name})`);
    log('고르는 방식 × 후보 범위                                   걸어가며 고른 연평균   고른 설정이 바뀐 횟수   고른 서로 다른 설정 수');
    SPACES.forEach(([sn, ok]) => Object.entries(CRIT).forEach(([cn, fn]) => {
      const pool_ = cfgs.filter(ok); let prod = 1; const hist = [];
      oosYears.forEach(Y => { const past = Ys.filter(y => y < Y); let best = null; pool_.forEach(c => { const v = fn(c, past); if (!best || v > best.v) best = { c, v }; }); const r = best.c.yearly[Y] ?? 0; prod *= 1 + r; hist.push({ Y, c: best.c, r }); });
      const chg_ = hist.filter((h, i) => i > 0 && h.c.name !== hist[i - 1].c.name).length, nconf = hist.filter(h => h.c.thr).length;
      log(`${(sn + ' · ' + cn).padEnd(58)} ${pc1(Math.pow(prod, 1 / oosYears.length) - 1).padStart(8)}   ${String(chg_).padStart(6)}   ${String(new Set(hist.map(h => h.c.name)).size).padStart(6)}   (확인 매수를 고른 해 ${nconf}/${hist.length})`);
      if (sn.startsWith('전체') && cn.startsWith('확장')) hist.forEach(h => log(`    ${h.Y}: ${h.c.name}  → 그해 ${pc1(h.r)}  (지금 전략 ${pc1(fixed.yearly[h.Y] ?? 0)}, 예전 전략 ${pc1(old.yearly[h.Y] ?? 0)})`));
    }));
  }
  if (process.env.AD8_SKIP === '1' && RT14) {                           // 산 달 말 판매 판단 건너뛰기 비교(현재 규칙 = 금리 국채10년6m, 확인 +10%)
    V.length = 0; const rule10 = { tp: 2, grace: 2, rate: true, rateFn: chg('dgs10', 6) }, m = pool({ thr: 0.1, rule: rule10, rateName: '국채10년 6개월' }), cand = ym => m.get(ym) || [];
    V.push({ sec: '기준', name: '현재: 산 달 말에도 판매 판단', cand, rule: rule10 });
    V.push({ sec: '산 달 말 판매 건너뛰기', name: '산 달 말에는 판매 안 함(다음 달 말부터 판단)', cand, rule: rule10, o: { skipBuyMonth: true } });
  }
  if (process.env.AD8_UNION === '1' && RT14) {                          // 후보 묶기: 확인 매수 후보 + 이번 달 돌파만 한 종목(즉시 매수 후보)을 함께 놓고 점수순 / 우선순위별로 비교 (판매 규칙·금리 판단은 현재 규칙)
    V.length = 0; const rule10 = { tp: 2, grace: 2, rate: true, rateFn: chg('dgs10', 6) }, mC = pool({ thr: 0.1, rule: rule10, rateName: '국채10년 6개월' });
    const conf = ym => mC.get(ym) || [], imm = ym => scored[kA].get(ym) || [];
    const dedupe = a => { const seen = new Set(), o = []; a.forEach(e => { if (seen.has(e.r.y)) return; seen.add(e.r.y); o.push(e); }); return o; };
    const byScore = a => a.slice().sort((x, y) => y.s - x.s);
    const SC = '후보 묶기';
    V.push({ sec: '기준', name: 'A 확인 매수만 (현재)', cand: conf, rule: rule10 });
    V.push({ sec: SC, name: 'B 이번 달 돌파만 한 종목만 (즉시 매수)', cand: imm, rule: rule10 });
    V.push({ sec: SC, name: 'C 둘 다 놓고 점수순', cand: ym => dedupe(byScore(conf(ym).concat(imm(ym)))), rule: rule10 });
    V.push({ sec: SC, name: 'D 확인 매수 먼저, 모자라면 돌파만 한 종목으로 채움', cand: ym => dedupe(byScore(conf(ym)).concat(byScore(imm(ym)))), rule: rule10 });
    V.push({ sec: SC, name: 'E 돌파만 한 종목 먼저, 모자라면 확인 매수로 채움', cand: ym => dedupe(byScore(imm(ym)).concat(byScore(conf(ym)))), rule: rule10 });
  }
  if (process.env.AD8_RISK === '1' && RT14) {                           // 지수 필터(코스피·S&P500이 그달 N개월 이평 아래면 신규 매수 쉼) · 총 보유 종목 상한 시험. 판매 규칙·금리 판단은 현재 규칙
    V.length = 0; const rule10 = { tp: 2, grace: 2, rate: true, rateFn: chg('dgs10', 6) }, mC = pool({ thr: 0.1, rule: rule10, rateName: '국채10년 6개월' }), conf = ym => mC.get(ym) || [];
    let BENCHJ = null; try { BENCHJ = JSON.parse(fs.readFileSync(path.join(DATA, 'bench.json'))); } catch (e) { console.log('※ data/bench.json 없음(8b_bench.js)'); }
    const idxClose = (key, k) => BENCHJ && BENCHJ[key] ? BENCHJ[key][ymOf(k)] : undefined;
    const idxUp = (key, ym, L) => { const k = mi(ym); let t = 0; for (let j = k; j > k - L; j--) { const c = idxClose(key, j); if (!(c > 0)) return true; t += c; } return idxClose(key, k) > t / L; };     // 자료가 없으면 쉬지 않음
    const keyOf = y => (/\.(KS|KQ)$/.test(y) ? 'ks' : 'sp');
    const filt = (mode, L) => ym => conf(ym).filter(e => mode === 'mkt' ? idxUp(keyOf(e.r.y), ym, L) : mode === 'ks' ? idxUp('ks', ym, L) : mode === 'sp' ? idxUp('sp', ym, L) : (idxUp('ks', ym, L) || idxUp('sp', ym, L)));
    V.push({ sec: '기준', name: '현재: 필터·상한 없음', cand: conf, rule: rule10 });
    if (BENCHJ) { [6, 10, 12].forEach(L => { V.push({ sec: '지수 필터(신규 매수만 쉼)', name: `종목 시장 지수(한국=코스피, 미국=S&P500)가 ${L}개월 이평 아래면 쉼`, cand: filt('mkt', L), rule: rule10 });
      }); V.push({ sec: '지수 필터(신규 매수만 쉼)', name: 'S&P500이 10개월 이평 아래면 전부 쉼', cand: filt('sp', 10), rule: rule10 });
      V.push({ sec: '지수 필터(신규 매수만 쉼)', name: '코스피가 10개월 이평 아래면 전부 쉼', cand: filt('ks', 10), rule: rule10 });
      V.push({ sec: '지수 필터(신규 매수만 쉼)', name: '코스피·S&P500 둘 다 10개월 이평 아래일 때만 쉼', cand: filt('both', 10), rule: rule10 }); }
    [6, 8, 10, 12, 16, 20].forEach(h => V.push({ sec: '총 보유 종목 상한', name: `보유 ${h}종목까지만`, cand: conf, rule: rule10, o: { maxHold: h } }));
  }
  if (process.env.AD8_CASH === '1' && RT14) {                           // 후보가 적은 달에 몰아 사지 않기(minDiv) · 현금 이자 반영(cashRateFn) — 판매 규칙·금리 판단은 현재 규칙
    V.length = 0; const rule10 = { tp: 2, grace: 2, rate: true, rateFn: chg('dgs10', 6) }, mC = pool({ thr: 0.1, rule: rule10, rateName: '국채10년 6개월' }), conf = ym => mC.get(ym) || [];
    V.push({ sec: '기준', name: '현재: 후보 수대로 나눠 삼 · 현금 이자 없음', cand: conf, rule: rule10 });
    [2, 3, 4].forEach(d => V.push({ sec: '후보가 적은 달 현금 유지', name: `후보가 적어도 최소 ${d}종목 몫으로 나눔(나머지 현금 유지)`, cand: conf, rule: rule10, o: { minDiv: d } }));
    [0.02, 0.03, 0.04].forEach(r => V.push({ sec: '현금 이자 반영(세금 제외)', name: `놀고 있는 현금에 연 ${r * 100}% 이자`, cand: conf, rule: rule10, o: { cashRateFn: () => r } }));
    V.push({ sec: '현금 이자 반영(세금 제외)', name: '놀고 있는 현금에 미국 3개월 단기국채 금리(그 달 값)', cand: conf, rule: rule10, o: { cashRateFn: k => { const v = rtk(k).dtb3; return v != null ? v / 100 : 0; } } });
    V.push({ sec: '현금 이자 반영(세금 제외)', name: '최소 4종목 몫 + 연 3% 이자', cand: conf, rule: rule10, o: { minDiv: 4, cashRateFn: () => 0.03 } });
  }
  if (process.env.AD8_TP === '1' && RT14) {                             // 익절 기준 시험: 2배(지금)·2.5·3·4배·없음 — 후보·유예·금리는 현재 규칙 그대로, 삼성전자·SK하이닉스 거래도 같이 찍음
    V.length = 0;
    [[2, 'A 지금: 익절 2배 트레일'], [2.5, 'T1 익절 2.5배 트레일'], [3, 'T2 익절 3배 트레일'], [4, 'T3 익절 4배 트레일'], [0, 'T4 익절 없음(10이평 이탈·금리만)']].forEach(([tp, name]) => {
      const rule = { tp, grace: 2, rate: true, rateFn: chg('dgs10', 6) }, m = pool({ thr: 0.1, rule, rateName: '국채10년 6개월' });
      V.push({ sec: '익절 기준', name, cand: ym => m.get(ym) || [], rule });
    });
    AD8.tune = true;
  }
  if (process.env.AD8_CO === '1' && RT14) {                             // 같은 회사(보통주·우선주, Class A/B 등)는 하나만 사는 시험 — 후보·판매 규칙은 현재 그대로
    V.length = 0; const rule10 = { tp: 2, grace: 2, rate: true, rateFn: chg('dgs10', 6) }, mC = pool({ thr: 0.1, rule: rule10, rateName: '국채10년 6개월' }), conf = ym => mC.get(ym) || [];
    V.push({ sec: '기준', name: 'A 예전: 같은 회사 여러 종목 허용', cand: conf, rule: rule10, o: { oneCo: false } });
    V.push({ sec: '같은 회사', name: 'C1 지금(기본): 같은 회사는 하나만(보유 중이어도 같은 회사는 안 삼)', cand: conf, rule: rule10 });
    AD8.co = true;
  }
  if (process.env.AD8_REV === '1' && RT14) {                            // 역배열 즉시 판매 시험: 10이평 아래로 내려왔는데 역배열이면 유예(2달) 없이 바로 판매 — 후보·익절·금리는 현재 규칙 그대로
    V.length = 0;
    const rv = {
      R1: (o, k) => { const a = maAt(o, k, 5), b = maAt(o, k, 10), d = maAt(o, k, 20); return a != null && b != null && d != null && a < b && b < d; },     // 5<10<20 완전 역배열
      R2: (o, k) => { const a = maAt(o, k, 5), b = maAt(o, k, 10); return a != null && b != null && a < b; },                                             // 5이평 < 10이평
      R3: (o, k) => { const d = maAt(o, k, 20), c = o.m.get(k); return d != null && c !== undefined && c < d; },                                         // 종가 < 20이평(20이평도 깨짐)
      R4: (o, k) => { const b = maAt(o, k, 10), d = maAt(o, k, 20); return b != null && d != null && b < d; }                                            // 10이평 < 20이평
    }, nm = { R1: 'R1 5<10<20 완전 역배열이면 즉시', R2: 'R2 5이평<10이평이면 즉시', R3: 'R3 종가<20이평이면 즉시', R4: 'R4 10이평<20이평이면 즉시' };
    const mk = (name, tag) => { const rule = { tp: 2, grace: 2, rate: true, rateFn: chg('dgs10', 6), ...(tag ? { rev: tag, revFn: rv[tag] } : {}) }, m = pool({ thr: 0.1, rule, rateName: '국채10년 6개월' }); V.push({ sec: '역배열 즉시 판매', name, cand: ym => m.get(ym) || [], rule }); };
    mk('A 지금: 10이평 아래 유예 2달(금리 상승이면 즉시)', null);
    ['R1', 'R2', 'R3', 'R4'].forEach(t => mk(nm[t], t));
    AD8.rev = true;
  }
  if (process.env.AD8_DIV === '1' && RT14) {                            // 배당 반영 시험(백테스트 전용): 보유 종목 배당(세후)을 현금으로 받아 재투자 — 후보·판매 규칙은 현재 그대로
    V.length = 0; const rule10 = { tp: 2, grace: 2, rate: true, rateFn: chg('dgs10', 6) }, mC = pool({ thr: 0.1, rule: rule10, rateName: '국채10년 6개월' }), conf = ym => mC.get(ym) || [];
    V.push({ sec: '배당 반영', name: 'A 지금: 배당 없음(가격만)', cand: conf, rule: rule10 });
    V.push({ sec: '배당 반영', name: 'D1 배당 세후(미국 15%·한국 15.4%), 구매 달 제외', cand: conf, rule: rule10, o: { divFn: divOf, divTaxUS: 0.15, divTaxKR: 0.154, divSkipBuy: true } });
    V.push({ sec: '배당 반영', name: 'D2 배당 세후, 구매 달 포함', cand: conf, rule: rule10, o: { divFn: divOf, divTaxUS: 0.15, divTaxKR: 0.154 } });
    V.push({ sec: '배당 반영', name: 'D3 배당 세전(위쪽 한계), 구매 달 포함', cand: conf, rule: rule10, o: { divFn: divOf } });
    AD8.div = true;
  }
  if (process.env.AD8_MIX === '1' && RT14) {                            // 한·미 비율 시험: 매달 4종목을 미국 n개 + 한국 4−n개로 정해서 삼(각 시장에서 점수 높은 순) — 후보·판매 규칙은 현재 그대로
    V.length = 0; const rule10 = { tp: 2, grace: 2, rate: true, rateFn: chg('dgs10', 6) }, mC = pool({ thr: 0.1, rule: rule10, rateName: '국채10년 6개월' }), conf = ym => mC.get(ym) || [];
    const isKR = e => /\.(KS|KQ)$/.test(e.r.y);
    const mix = (nUS, nKR, fill) => ym => {                             // 미국 상위 nUS + 한국 상위 nKR(점수 순). fill=true면 한쪽이 모자랄 때 나머지 후보를 점수 순으로 이어 붙임
      const all = conf(ym), us = all.filter(e => !isKR(e)).slice(0, nUS), kr = all.filter(isKR).slice(0, nKR), pick = [...us, ...kr].sort((a, b) => b.s - a.s);
      return fill ? [...pick, ...all.filter(e => !pick.includes(e))] : pick;
    };
    V.push({ sec: '한·미 비율', name: 'A 지금: 시장 구분 없이 점수 상위 4', cand: conf, rule: rule10 });
    [[4, 0], [3, 1], [2, 2], [1, 3], [0, 4]].forEach(([u, k]) => V.push({ sec: '한·미 비율', name: `M 미국 ${u} · 한국 ${k} (모자라면 있는 만큼만)`, cand: mix(u, k, false), rule: rule10 }));
    [[4, 0], [3, 1], [2, 2], [1, 3], [0, 4]].forEach(([u, k]) => V.push({ sec: '한·미 비율', name: `F 미국 ${u} · 한국 ${k} (모자라면 점수 순으로 채움)`, cand: mix(u, k, true), rule: rule10 }));
    AD8.mix = true;
  }
  if (process.env.AD9 && RT14) {                                       // AD9: 시험 목록 전체 묶음(ad9.js). AD9=1~10(쉼표로 여러 개) 또는 all
    V.length = 0;
    const rescore = (o = {}) => {                                      // 점수 모델 'A'를 조건을 바꿔 다시 학습해 점수 지도(월 → 점수 순 목록)를 만듦(위 학습 루프와 같은 방식)
      //   o.trainFn(Y) 학습 자료 · o.subsample · o.recentDup · o.lamMul 벌점 배수 · o.topCols 기여 큰 지표만 · o.fitFn(Z,t,ym,lam) 다른 선형 학습 · o.modelFn(Z,t,ym,w,P) → 점수 함수(비선형)
      //   o.monthStd 그달 안에서 표준화 · o.splitBy(r) 그룹별로 따로 학습 · o.xFn(r) 지표 덧붙이기(+ o.extraCols) · o.signs {열번호:+1|-1} 부호 제약 · o.keep 해마다 모델 보관
      const out = new Map(), M = MODELS[KA0], lamM = M.lam * (o.lamMul || 1), colsAll = o.xFn && o.extraCols ? M.cols.concat(o.extraCols) : M.cols;
      const xOf = r => (o.xFn ? o.xFn(r) : r.x);
      const stdBy = (Z, grp) => { const g = new Map(); grp.forEach((k2, i) => { (g.get(k2) || g.set(k2, []).get(k2)).push(i); }); const R = Z.map(z2 => z2.slice()); g.forEach(idx => { if (idx.length < 3) return; for (let c = 0; c < Z[0].length; c++) { let m = 0; idx.forEach(i => { m += Z[i][c]; }); m /= idx.length; let v = 0; idx.forEach(i => { v += (Z[i][c] - m) ** 2; }); const sd = Math.sqrt(v / idx.length) || 1; idx.forEach(i => { R[i][c] = (Z[i][c] - m) / sd; }); } }); return R; };
      years.forEach(Y => {
        let tr0 = o.trainFn ? o.trainFn(Y) : trainSet(ALL, Y);
        const te = ALL.filter(r => Math.floor(r.ym / 100) === Y);
        if (tr0.length < 500 || !te.length) return;
        if (o.subsample) tr0 = tr0.filter((r, i) => hash01(o.subsample.seed + '|' + i) < o.subsample.frac);
        if (o.recentDup) { const lo = (Y - o.recentDup) * 100; tr0 = tr0.concat(tr0.filter(r => r.ym > lo)); }
        const tr = tr0.map(r => ({ x: xOf(r), t: clipT(r.t), ym: r.ym, y: r.y }));
        const fitCols = (trr, cols) => { const P = prep(trr, cols); let Z = trr.map(r => z(r, P)); if (o.monthStd) Z = stdBy(Z, trr.map(r => r.ym)); return { P, Z, w: fitRidge(Z, trr.map(r => r.t), lamM) }; };
        const fitSet = (trr) => {
          let m = fitCols(trr, colsAll);
          if (o.topCols) { const idx = m.P.map((p, i) => [Math.abs(m.w[i + 1]), i]).sort((a, c) => c[0] - a[0]).slice(0, o.topCols).map(a => m.P[a[1]].j); m = fitCols(trr, idx); }
          if (o.signs) { for (let rd = 0; rd < 3; rd++) { const keepC = m.P.filter((p, i) => !(o.signs[p.j] && m.w[i + 1] * o.signs[p.j] < 0)).map(p => p.j); if (keepC.length === m.P.length || keepC.length < 3) break; m = fitCols(trr, keepC); } }
          const t = trr.map(r => r.t);
          if (o.fitFn) m.w = o.fitFn(m.Z, t, trr.map(r => r.ym), M.lam);
          m.f = o.modelFn ? o.modelFn(m.Z, t, trr.map(r => r.ym), m.w, m.P, trr) : ((zx) => score(m.w, zx));
          return m;
        };
        const scoreRows = (m, rows) => { let Zt = rows.map(r => z({ x: xOf(r) }, m.P)); if (o.monthStd) Zt = stdBy(Zt, rows.map(r => r.ym)); return Zt.map((zx, i) => m.f(zx, xOf(rows[i]))); };
        const gm = fitSet(tr);
        if (o.keep) o.keep[Y] = { w: gm.w, P: gm.P };
        if (o.splitBy) {
          const groups = new Map(); tr.forEach(r => { const k2 = o.splitBy(r); (groups.get(k2) || groups.set(k2, []).get(k2)).push(r); });
          const models = new Map(); groups.forEach((rows, k2) => { if (rows.length >= 400) models.set(k2, fitSet(rows)); });
          const byKey = new Map(); te.forEach(r => { const k2 = o.splitBy(r); (byKey.get(k2) || byKey.set(k2, []).get(k2)).push(r); });
          byKey.forEach((rows, k2) => { const m = models.get(k2) || gm, sc2 = scoreRows(m, rows); rows.forEach((r, i) => { const a = out.get(r.ym) || []; a.push({ r, s: sc2[i] }); out.set(r.ym, a); }); });
        } else { const sc2 = scoreRows(gm, te); te.forEach((r, i) => { const a = out.get(r.ym) || []; a.push({ r, s: sc2[i] }); out.set(r.ym, a); }); }
      });
      out.forEach(a => a.sort((x, y) => y.s - x.s));
      return out;
    };
    require('./ad9').build({ V, AD8, pool, simulate, simOpt, run14, summ, C1, DEP, mi, ymOf, px, fx, fdPx, ma10, maAtN, F, fi, US, TURN, ETF, hash01, rateJ, MACRO, scored, kA, byYm, CO_NAME, coKey, chg, rtk, RT14,
      YEARS_ALL, log, cagrOver, START_Y, END, CUR, rescore, ALL, dailyOf, score, z, prep, fitRidge, MK: require('./data').MK, divOf, fs, path, DATA, RAW, START }, process.env.AD9);
  }
  if (process.env.AD8_ETF === '1' && RT14) {                            // ETF 제외 시험: 후보에서 ETF를 빼고(다음 순위 종목을 삼) 현재 규칙 그대로 / 대조: ETF만
    V.length = 0; const rule10 = { tp: 2, grace: 2, rate: true, rateFn: chg('dgs10', 6) }, mC = pool({ thr: 0.1, rule: rule10, rateName: '국채10년 6개월' });
    const mk = f => ym => (mC.get(ym) || []).filter(f);
    V.push({ sec: '기준', name: 'A 지금: ETF 포함', cand: mk(() => true), rule: rule10 });
    V.push({ sec: 'ETF', name: 'E1 ETF 제외(개별 종목만)', cand: mk(e => e.r.x[ETF] !== 1), rule: rule10 });
    V.push({ sec: 'ETF', name: 'E2 대조: ETF만', cand: mk(e => e.r.x[ETF] === 1), rule: rule10 });
  }
  if (process.env.AD8_TLH2 === '1' && RT14) {                           // 손실이 20% 이상 난 종목만 1월부터(매달) 정리하는 시험: 세금 목적(이익이 공제 넘을 때만) vs 손절(이익 상관없이), 미국만 vs 한국+미국
    V.length = 0; const rule10 = { tp: 2, grace: 2, rate: true, rateFn: chg('dgs10', 6) }, mC = pool({ thr: 0.1, rule: rule10, rateName: '국채10년 6개월' }), conf = ym => mC.get(ym) || [];
    const add = (sec, name, tlh) => V.push({ sec, name, cand: conf, rule: rule10, o: tlh ? { tlh } : {} });
    const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    add('기준', 'A 지금: 손실 종목 미리 팔지 않음', null);
    add('세금 목적: 미국만, 그해 이익이 공제 넘을 때만 · 1~12월 매달 말', 'U1 손실 ≥10% 인 종목', { months: ALL, minLoss: 0.1 });
    add('세금 목적: 미국만, 그해 이익이 공제 넘을 때만 · 1~12월 매달 말', 'U2 손실 ≥20% 인 종목', { months: ALL, minLoss: 0.2 });
    add('세금 목적: 미국만, 그해 이익이 공제 넘을 때만 · 1~12월 매달 말', 'U3 손실 ≥30% 인 종목', { months: ALL, minLoss: 0.3 });
    add('세금 목적: 미국만, 그해 이익이 공제 넘을 때만 · 1~12월 매달 말', 'U4 손실 ≥20% 인 종목, 11월 말만', { months: [11], minLoss: 0.2 });
    add('손절: 이익과 상관없이 · 1~12월 매달 말', 'S1 미국만, 손실 ≥20%', { months: ALL, minLoss: 0.2, always: true });
    add('손절: 이익과 상관없이 · 1~12월 매달 말', 'S2 미국만, 손실 ≥30%', { months: ALL, minLoss: 0.3, always: true });
    add('손절: 이익과 상관없이 · 1~12월 매달 말', 'S3 한국+미국, 손실 ≥20%', { months: ALL, minLoss: 0.2, always: true, all: true });
    add('손절: 이익과 상관없이 · 1~12월 매달 말', 'S4 한국+미국, 손실 ≥30%', { months: ALL, minLoss: 0.3, always: true, all: true });
    AD8.tlh = true;
  }
  if (process.env.AD8_TLH === '1' && RT14) {                            // 세금 줄이려고 손실 난 미국 종목 미리 팔기 시험(11월·12월 말) — 판매 규칙·후보는 현재 규칙 그대로
    V.length = 0; const rule10 = { tp: 2, grace: 2, rate: true, rateFn: chg('dgs10', 6) }, mC = pool({ thr: 0.1, rule: rule10, rateName: '국채10년 6개월' }), conf = ym => mC.get(ym) || [];
    const add = (sec, name, tlh) => V.push({ sec, name, cand: conf, rule: rule10, o: tlh ? { tlh } : {} });
    add('기준', 'A 지금: 손실 종목 미리 팔지 않음', null);
    add('세금 줄이기(이익이 공제 넘을 때만)', 'T1 11월 말: 손실 난 미국 종목을 세금이 0이 될 때까지 판매', { months: [11] });
    add('세금 줄이기(이익이 공제 넘을 때만)', 'T2 12월 말(세금 계산 직전)', { months: [12] });
    add('세금 줄이기(이익이 공제 넘을 때만)', 'T3 11월 말 + 12월 말', { months: [11, 12] });
    add('세금 줄이기(이익이 공제 넘을 때만)', 'T4 10월 말', { months: [10] });
    add('대조(이익과 상관없이 손실 종목 전부)', 'C1 11월 말 손실 난 미국 종목 모두 판매', { months: [11], always: true });
    add('대조(이익과 상관없이 손실 종목 전부)', 'C2 12월 말 손실 난 미국 종목 모두 판매', { months: [12], always: true });
    AD8.tlh = true;
  }
  if (process.env.AD8_TUNE === '1' && RT14) {                           // 궁금증 시험: 삼성전자·SK하이닉스(2025)를 잡도록 정배열 완화·순위 기준·보유 수를 바꿔 보고 성과와 두 종목 매수 여부를 봄
    V.length = 0; const rule10 = { tp: 2, grace: 2, rate: true, rateFn: chg('dgs10', 6) };
    const P = al => pool({ thr: 0.1, rule: rule10, rateName: '국채10년 6개월', align: al });
    const byScore = m => ym => m.get(ym) || [];
    const byPnl = m => ym => [...(m.get(ym) || [])].sort((x, y) => y.pnl - x.pnl);
    const byRank = m => rankOrder(m, [e => e.s, e => e.pnl]);
    const add = (sec, name, al, ord, N) => { const m = P(al); V.push({ sec, name, cand: ord(m), rule: rule10, ...(N ? { N } : {}) }); };
    add('기준', 'A 지금: 5>10>20 정배열 · 점수 순 · 4종목', 'full', byScore);
    add('정배열 완화', 'B1 5>10 이평만 (점수 순)', 's5_10', byScore);
    add('정배열 완화', 'B2 5>10 이고 종가>20이평 (점수 순)', 'p20', byScore);
    add('정배열 완화', 'B3 정배열 안 봄 (점수 순)', 'none', byScore);
    add('순위 기준', 'C1 정배열 그대로 · 가상 수익 큰 순', 'full', byPnl);
    add('순위 기준', 'C2 정배열 그대로 · 점수+가상 수익 순위합', 'full', byRank);
    add('조합', 'D1 5>10만 · 가상 수익 큰 순', 's5_10', byPnl);
    add('조합', 'D2 5>10만 · 점수+가상 수익 순위합', 's5_10', byRank);
    add('조합', 'D3 정배열 안 봄 · 가상 수익 큰 순', 'none', byPnl);
    add('보유 수', 'E1 정배열 그대로 · 점수 순 · 6종목', 'full', byScore, 6);
    add('보유 수', 'E2 5>10만 · 점수 순 · 6종목', 's5_10', byScore, 6);
    add('보유 수', 'E3 5>10만 · 점수+가상 수익 순위합 · 6종목', 's5_10', byRank, 6);
    add('두 종목 잡기(보유 수 늘리기)', 'F1 정배열 안 봄 · 가상 수익 큰 순 · 6종목', 'none', byPnl, 6);
    add('두 종목 잡기(보유 수 늘리기)', 'F2 정배열 안 봄 · 가상 수익 큰 순 · 8종목', 'none', byPnl, 8);
    add('두 종목 잡기(보유 수 늘리기)', 'F3 5>10만 · 가상 수익 큰 순 · 8종목', 's5_10', byPnl, 8);
    add('두 종목 잡기(보유 수 늘리기)', 'F4 정배열 안 봄 · 가상 수익 큰 순 · 12종목', 'none', byPnl, 12);
    AD8.tune = true;
  }
  const base = V[0];
  const safe = (v, f, dflt) => { try { return f(); } catch (e) { v.err = v.err || String((e && e.message) || e).slice(0, 70); return dflt; } };      // 한 시험이 오류여도 나머지는 계속
  V.forEach((v, i) => { progress('후속 시험', i / V.length); v.full = safe(v, () => run14(v), { cagr: NaN, yearly: {}, mdd: NaN, val: NaN }); v.halves = []; });
  for (let b = 1; b <= B; b++) { progress('후속 시험(절반)', (b - 1) / B); V.forEach(v => v.halves.push(v.err ? NaN : safe(v, () => run14(v, e => hash(e.r.y + '|' + b) < 0.5).cagr, NaN))); }
  V.forEach(v => { if (v.err) v.name += ' [오류: ' + v.err + ']'; });
  progress('후속 시험(절반)', 1); process.stdout.write('\n');
  if (AD8.tune) {                                                         // 두 종목(삼성전자·SK하이닉스)이 2025년에 실제로 매수되는지
    const WATCH = [['005930.KS', '삼성전자'], ['000660.KS', 'SK하이닉스']];
    log(''); log('## 삼성전자·SK하이닉스 매수 여부 (변형별, 첫날 구매 · 2024년 이후 거래: 구매 달 → 판매 달 · 수익)');
    V.forEach(v => {
      const o = simOpt(v.rule || RULE0, v.o || {}), N = v.N || 4, cand = v.cand;
      const sm = simulate(ym => cand(ym).slice(0, N), N, C1, { ...o, cand, log: true });
      const parts = WATCH.map(([y, nm]) => { const T = (sm.trades || []).filter(t => t.y === y && +String(t.buyYm).slice(0, 4) >= 2024).map(t => `${t.buyYm}→${t.sellYm || '보유중'} ${t.ret == null ? '' : (t.ret >= 0 ? '+' : '') + (t.ret * 100).toFixed(0) + '%'}`); return `${nm}: ${T.length ? T.join(', ') : '매수 없음'}`; });
      log(`${v.name.slice(0, 42).padEnd(42)} | ${parts.join(' | ')}`);
      const rk = WATCH.map(([y, nm]) => { const o2 = []; [202504, 202505, 202506, 202507, 202508, 202509].forEach(ym => { const L = cand(ym) || [], i = L.findIndex(e => e.r && e.r.y === y); if (i >= 0) o2.push(`${ym}:${i + 1}위/${L.length}`); }); return `${nm} 후보 순위(2025): ${o2.length ? o2.join(' ') : '후보에 안 듦'}`; });
      log(`${''.padEnd(42)} · ${rk.join(' | ')}`);
    });
  }
  if (process.env.AD8_TP === '1') {                                       // 2배 vs 2.5배: 어떤 거래·어떤 해에서 차이가 나는지, 큰 차이 종목을 하나씩 빼면 어떻게 되는지
    const A = V[0], T1 = V[1], pct = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(0) + '%', pc1 = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%', pp = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%p';
    const tr = v => { const o = simOpt(v.rule, v.o || {}); return (simulate(ym => v.cand(ym).slice(0, 4), 4, C1, { ...o, cand: v.cand, log: true }).trades || []); };
    const tA = tr(A), tB = tr(T1), key = t => t.y + '|' + t.buyYm, mB = new Map(tB.map(t => [key(t), t]));
    const diff = [];
    tA.forEach(t => { const u = mB.get(key(t)); if (u && (u.sellYm !== t.sellYm || Math.abs((u.ret || 0) - (t.ret || 0)) > 1e-9)) diff.push({ y: t.y, buy: t.buyYm, sA: t.sellYm, sB: u.sellYm, rA: t.ret, rB: u.ret }); });
    log(''); log(`## 익절 2배 vs 2.5배 — 거래별 차이 (같은 구매인데 판매 달·수익이 달라진 거래 ${diff.length}건, 전체 ${tA.length}거래)`);
    log('종목          구매      2배: 판매 달 · 수익        2.5배: 판매 달 · 수익      수익 차이');
    diff.sort((a, b) => Math.abs((b.rB || 0) - (b.rA || 0)) - Math.abs((a.rB || 0) - (a.rA || 0))).forEach(d => log(`${String(d.y).padEnd(12)} ${d.buy}   ${String(d.sA || '보유중').padEnd(7)} ${pct(d.rA || 0).padStart(6)}        ${String(d.sB || '보유중').padEnd(7)} ${pct(d.rB || 0).padStart(6)}        ${pct((d.rB || 0) - (d.rA || 0)).padStart(6)}`));
    const onlyA = tA.filter(t => !mB.has(key(t))).length, onlyB = tB.length - (tA.length - onlyA);
    log(`(구매 자체가 달라진 거래: 2배에만 ${onlyA}건 · 2.5배에만 ${onlyB}건 — 판매 시점이 달라 현금·후보 순서가 바뀐 영향)`);
    log(''); log('## 해마다 수익률 (2배 → 2.5배)');
    Object.keys(A.full.yearly).sort().forEach(y => { const a = A.full.yearly[y], b = T1.full.yearly[y]; if (Math.abs(a - b) > 1e-9) log(`${y}  ${pc1(a).padStart(8)} → ${pc1(b).padStart(8)}   ${pp(b - a)}`); });
    log(`(위에 없는 해는 두 방식이 똑같음)`);
    const top = []; diff.forEach(d => { if (!top.includes(d.y)) top.push(d.y); });
    log(''); log('## 큰 차이 종목을 하나씩 뺐을 때 (전체 연평균: 2배 → 2.5배 · 차이)');
    const base0 = A.full.cagr, base1 = T1.full.cagr; log(`(뺀 것 없음)                ${pc1(base0).padStart(8)} → ${pc1(base1).padStart(8)}   ${pp(base1 - base0)}`);
    top.slice(0, 6).forEach(y => { const f = e => e.r.y !== y, a = run14(A, f).cagr, b = run14(T1, f).cagr; log(`${String(y).padEnd(24)} ${pc1(a).padStart(8)} → ${pc1(b).padStart(8)}   ${pp(b - a)}`); });
    const f6 = e => !top.slice(0, 3).includes(e.r.y), a3 = run14(A, f6).cagr, b3 = run14(T1, f6).cagr; log(`위 3종목 모두 뺌             ${pc1(a3).padStart(8)} → ${pc1(b3).padStart(8)}   ${pp(b3 - a3)}`);
  }
  if (AD8.rev) {                                                          // 변형별 판매 사유 건수·평균 수익(역배열 즉시 판매가 얼마나 일어났는지)
    log(''); log('## 역배열 즉시 판매 시험 — 변형별 판매 사유: 건수 · 평균 수익 (전체 기간, 월 100만원)');
    V.forEach(v => {
      const o = simOpt(v.rule, v.o || {}), sm = simulate(ym => v.cand(ym).slice(0, 4), 4, C1, { ...o, cand: v.cand, log: true }), by = {};
      (sm.trades || []).forEach(t => { if (t.ret == null) return; const k = t.reason || 'ma10'; (by[k] = by[k] || []).push(t.ret); });
      const f = k => by[k] ? `${by[k].length}건 ${(by[k].reduce((a, b) => a + b, 0) / by[k].length * 100 >= 0 ? '+' : '') + (by[k].reduce((a, b) => a + b, 0) / by[k].length * 100).toFixed(1)}%` : '0건';
      log(`${v.name.slice(0, 40).padEnd(40)} | 역배열 ${f('ma10-역배열')} | 유예만료 ${f('ma10-유예만료')} | 금리인상 ${f('ma10-금리인상')} | 익절 ${f('tpTrail')}`);
    });
  }
  if (AD8.div) {                                                          // 변형별 받은 배당 합계·최종 평가액·종목별 배당
    log(''); log('## 배당 반영 시험 — 받은 배당 합계(세후) · 최종 평가액 · 배당 받은 거래 비율 (전체 기간, 월 100만원)');
    const man = x => Math.round(x / 10000).toLocaleString() + '만원';
    V.forEach(v => {
      const o = simOpt(v.rule, v.o || {}), sm = simulate(ym => v.cand(ym).slice(0, 4), 4, C1, { ...o, cand: v.cand, log: true });
      log(`${v.name.slice(0, 44).padEnd(44)} | 받은 배당 ${man(sm.divTotal || 0).padStart(9)} | 최종 평가액 ${man(sm.val).padStart(11)}`);
    });
  }
  if (AD8.mix) {                                                          // 변형별 실제 산 한국·미국 종목 수와 평균 수익
    log(''); log('## 한·미 비율 시험 — 변형별 실제 구매 거래 수 · 평균 수익(한국·미국) · 최종 평가액 (전체 기간, 월 100만원)');
    const man = x => Math.round(x / 10000).toLocaleString() + '만원', isKR2 = y => /\.(KS|KQ)$/.test(y);
    V.forEach(v => {
      const o = simOpt(v.rule, v.o || {}), N = v.N || 4, cand = v.cand, sm = simulate(ym => cand(ym).slice(0, N), N, C1, { ...o, cand, log: true });
      const tr = (sm.trades || []).filter(t => t.ret != null), k = tr.filter(t => isKR2(t.y)), u = tr.filter(t => !isKR2(t.y)), av = a => a.length ? (a.reduce((x, t) => x + t.ret, 0) / a.length * 100).toFixed(1) + '%' : '-';
      log(`${v.name.slice(0, 44).padEnd(44)} | 한국 ${String(k.length).padStart(3)}건 ${av(k).padStart(7)} | 미국 ${String(u.length).padStart(3)}건 ${av(u).padStart(7)} | 최종 ${man(sm.val).padStart(11)}`);
    });
  }
  if (AD8.co) {                                                           // 같은 회사라서 건너뛴 후보 수
    const o = simOpt(V[1].rule, V[1].o), sm = simulate(ym => V[1].cand(ym).slice(0, 4), 4, C1, { ...o, cand: V[1].cand, log: true });
    log(''); log(`## 같은 회사 하나만 — 건너뛴 후보 ${sm.coSkipN}번 (전체 기간)`);
    const byM = new Map(); (sm.trades || []).forEach(t => { const k = t.buyYm + '|' + coKey(t.y); byM.set(k, (byM.get(k) || 0) + 1); });
    const o0 = simOpt(V[0].rule, V[0].o || {}), s0 = simulate(ym => V[0].cand(ym).slice(0, 4), 4, C1, { ...o0, cand: V[0].cand, log: true }), b0 = new Map();
    (s0.trades || []).forEach(t => { const k = t.buyYm + '|' + coKey(t.y); b0.set(k, (b0.get(k) || 0) + 1); });
    const dup = [...b0.entries()].filter(([, n]) => n > 1); log(`기준(A)에서 같은 달 같은 회사 종목을 2개 이상 산 경우: ${dup.length}건 ${dup.slice(0, 8).map(([k, n]) => k + '×' + n).join(', ')}`);
  }
  if (AD8.tlh) {                                                          // 변형별 세금 합계·손절 판매 건수
    log(''); log('## 세금 줄이기 시험 — 변형별 낸 양도세 합계 · 손실 종목 미리 판 건수 (전체 기간, 월 100만원)');
    V.forEach(v => { const o = simOpt(v.rule, v.o || {}), sm = simulate(ym => v.cand(ym).slice(0, 4), 4, C1, { ...o, cand: v.cand }); log(`${v.name.slice(0, 44).padEnd(44)} | 양도세 합계 ${Math.round(sm.taxTotal).toLocaleString().padStart(12)}원 | 손실 종목 판매 ${String(sm.tlhN).padStart(3)}건`); });
  }
  AD8.sec = { V, base };
}
if (AD8.sec) {
  const { V, base } = AD8.sec, pc1 = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%', pp = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%p';
  const early = YEARS_ALL.filter(y => y <= 2019), late = YEARS_ALL.filter(y => y > 2019), mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  let cur = '';
  V.forEach(r => {
    if (r.sec !== cur) { cur = r.sec; log(''); log(`## 확인 매수 후속 ${cur} (점수 상위 ${r.N || 4} 기본, 첫날 체결, 월 100만원)`); log('방식                                                       전체    앞쪽    뒤쪽    낙폭    기준 대비(평균 · 표준편차 · 이긴 비율)'); }
    const d = r.halves.map((h, i) => h - base.halves[i]), sd = Math.sqrt(mean(d.map(x => (x - mean(d)) ** 2)));
    log(`${r.name.padEnd(52)} ${pc1(r.full.cagr).padStart(7)} ${pc1(cagrOver(r.full.yearly, early)).padStart(7)} ${pc1(cagrOver(r.full.yearly, late)).padStart(7)} ${pc1(r.full.mdd).padStart(7)}    ${r === base ? '(기준)' : `${pp(mean(d)).padStart(7)} · ${(sd * 100).toFixed(1)}%p · ${(d.filter(x => x > 0).length / d.length * 100).toFixed(0)}%`}`);
  });
}
if (AD8.ad9post) AD8.ad9post();                                        // AD9 묶음의 검증·기준선 보고(ad9.js)
// ── 걸어가며 설정 고르기 보고
// ── 확인 매수 심화 보고
if (AD7.sec) {
  const { rows: Rr, s3 } = AD7.sec, pc1 = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%', pp = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%p';
  const early = YEARS_ALL.filter(y => y <= 2019), late = YEARS_ALL.filter(y => y > 2019), mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  let cur = '';
  Rr.forEach(r => {
    if (r.sec !== cur) { cur = r.sec; log(''); log(`## 확인 매수 심화 ${cur} (점수 상위 4, 첫날 체결, 월 100만원)`); log('방식                                                              전체    앞쪽    뒤쪽    낙폭    기준 대비(평균 · 표준편차 · 이긴 비율)'); }
    const b = r.base ? Rr.find(x => x.name === r.base) : null; let eff = '(기준)';
    if (b && b !== r) { const d = r.halves.map((h, i) => h - b.halves[i]), sd = Math.sqrt(mean(d.map(x => (x - mean(d)) ** 2))); eff = `${pp(mean(d)).padStart(7)} · ${(sd * 100).toFixed(1)}%p · ${(d.filter(x => x > 0).length / d.length * 100).toFixed(0)}%   vs ${b.name}`; }
    log(`${r.name.padEnd(56)} ${pc1(r.full.cagr).padStart(7)} ${pc1(cagrOver(r.full.yearly, early)).padStart(7)} ${pc1(cagrOver(r.full.yearly, late)).padStart(7)} ${pc1(r.full.mdd).padStart(7)}    ${eff}`);
  });
  log(''); log('## 확인 매수 심화 ③ 점수 기여: 같은 후보 풀(확인 매수 + 5>10>20)에서 고르는 순서만 바꿈 (지금 규칙 V0, 상위 4)');
  log('가상 수익 문턱   점수 높은 순   점수 낮은 순   가상 수익 큰 순   가상 수익 작은 순   무작위 중앙값(하위10%~상위10%)   점수순보다 높은 무작위');
  s3.forEach(x => { const q = p => x.rnd[Math.min(x.rnd.length - 1, Math.floor(p * (x.rnd.length - 1)))], beat = x.rnd.filter(v => v >= x.score.cagr).length; log(`+${x.t * 100}% 이상        ${pc1(x.score.cagr).padStart(8)}      ${pc1(x.bottom.cagr).padStart(8)}      ${pc1(x.pnlHi.cagr).padStart(8)}        ${pc1(x.pnlLo.cagr).padStart(8)}        ${pc1(q(0.5)).padStart(7)} (${pc1(q(0.1))} ~ ${pc1(q(0.9))})        ${beat}/${x.rnd.length}`); });
}
// ── 확인 매수 보고
if (AD6.rows) {
  const Rr = AD6.rows, I0 = Rr[0], I1 = Rr[1], pc1 = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%', pp = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%p';
  const early = YEARS_ALL.filter(y => y <= 2019), late = YEARS_ALL.filter(y => y > 2019), mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  log(''); log('## 확인 매수: 돌파 달에 샀다고 가정 → 가상 수익이 문턱 이상(+정배열)일 때 실제 매수 (점수 상위 4, 첫날 체결, 월 100만원)');
  log('방식                                                          전체    앞쪽    뒤쪽    낙폭    거래수 승률    즉시 매수 같은 규칙 대비(평균 · 표준편차 · 이긴 비율)');
  Rr.forEach(r => {
    const b = r.v.tag === 'D1' ? I1 : I0, d = r.halves.map((h, i) => h - b.halves[i]), sd = Math.sqrt(mean(d.map(x => (x - mean(d)) ** 2)));
    log(`${r.v.name.padEnd(54)} ${pc1(r.full.cagr).padStart(7)} ${pc1(cagrOver(r.full.yearly, early)).padStart(7)} ${pc1(cagrOver(r.full.yearly, late)).padStart(7)} ${pc1(r.full.mdd).padStart(7)}   ${String(r.trades).padStart(5)} ${(r.win * 100).toFixed(0)}%    ${(r === I0 || r === I1) ? '(기준)' : `${pp(mean(d)).padStart(7)} · ${(sd * 100).toFixed(1)}%p · ${(d.filter(x => x > 0).length / d.length * 100).toFixed(0)}%`}`);
  });
}
// ── 초기 구매 방식 × 정배열 추가 매수 보고
if (AD5.rows) {
  const Rr = AD5.rows, base = Rr[0], pc1 = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%', pp = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%p';
  const early = YEARS_ALL.filter(y => y <= 2019), late = YEARS_ALL.filter(y => y > 2019), mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  log(''); log(`## 초기 구매 방식 × 정배열 추가 매수 (신호 방식 ENTRY=${process.env.ENTRY || 'cross'}, 신호 ${AD5.events}건; 점수 상위 4, 첫날 체결, 월 100만원)`);
  log('규칙                                                  전체    앞쪽    뒤쪽    낙폭    거래수 승률    같은 방식 V0 대비(평균 · 표준편차 · 이긴 비율)');
  Rr.forEach(r => {
    const d = r.halves.map((h, i) => h - base.halves[i]), sd = Math.sqrt(mean(d.map(x => (x - mean(d)) ** 2)));
    log(`${r.name.padEnd(48)} ${pc1(r.full.cagr).padStart(7)} ${pc1(cagrOver(r.full.yearly, early)).padStart(7)} ${pc1(cagrOver(r.full.yearly, late)).padStart(7)} ${pc1(r.full.mdd).padStart(7)}   ${String(r.trades).padStart(5)} ${(r.win * 100).toFixed(0)}%    ${r === base ? '(기준)' : `${pp(mean(d)).padStart(7)} · ${(sd * 100).toFixed(1)}%p · ${(d.filter(x => x > 0).length / d.length * 100).toFixed(0)}%`}`);
  });
}
// ── 정배열 심화 보고
if (AD4.rows) {
  const Rr = AD4.rows, base = Rr[0], pc1 = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%', pp = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%p';
  const early = YEARS_ALL.filter(y => y <= 2019), late = YEARS_ALL.filter(y => y > 2019), mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  let cur = '';
  Rr.forEach(r => {
    const parts = r.name.split(' | '), sec = parts.length > 1 ? parts[0] : '기준', nm = parts.length > 1 ? parts[1] : parts[0];
    if (sec !== cur) { cur = sec; log(''); log(`## 정배열 심화 ${sec} (점수 상위 4, 유예2+금리+tp2x, 첫날 체결, 월 100만원)`); log('방식                                                       전체    앞쪽    뒤쪽    낙폭    지금 방식 대비(평균 · 표준편차 · 이긴 비율)'); }
    const d = r.halves.map((h, i) => h - base.halves[i]), sd = Math.sqrt(mean(d.map(x => (x - mean(d)) ** 2)));
    log(`${nm.padEnd(54)} ${pc1(r.full.cagr).padStart(7)} ${pc1(cagrOver(r.full.yearly, early)).padStart(7)} ${pc1(cagrOver(r.full.yearly, late)).padStart(7)} ${pc1(r.full.mdd).padStart(7)}    ${r === base ? '(기준)' : `${pp(mean(d)).padStart(7)} · ${(sd * 100).toFixed(1)}%p · ${(d.filter(x => x > 0).length / d.length * 100).toFixed(0)}%`}`);
  });
}
// ── 정배열 추가 매수 보고
if (AD3.rows) {
  const Rr = AD3.rows, base = Rr[0], ref = Rr[1], pc1 = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%', pp = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%p';
  const early = YEARS_ALL.filter(y => y <= 2019), late = YEARS_ALL.filter(y => y > 2019), mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  log(''); log('## 정배열인 보유 종목에만 추가 매수 (점수 상위 4, 유예2+금리+tp2x, 첫날 체결, 월 100만원; 나머지는 신규 매수. 정배열은 체결 시점에 이미 알던 달 기준)');
  log('방식                                              전체    앞쪽    뒤쪽    낙폭    지금 방식 대비(평균 · 표준편차 · 이긴 비율)       수익 중 100% 대비(평균 · 이긴 비율)');
  Rr.forEach(r => {
    const d = r.halves.map((h, i) => h - base.halves[i]), sd = Math.sqrt(mean(d.map(x => (x - mean(d)) ** 2))), d2 = r.halves.map((h, i) => h - ref.halves[i]);
    log(`${r.name.padEnd(46)} ${pc1(r.full.cagr).padStart(7)} ${pc1(cagrOver(r.full.yearly, early)).padStart(7)} ${pc1(cagrOver(r.full.yearly, late)).padStart(7)} ${pc1(r.full.mdd).padStart(7)}    ${r === base ? '(기준)'.padEnd(34) : `${pp(mean(d)).padStart(7)} · ${(sd * 100).toFixed(1)}%p · ${(d.filter(x => x > 0).length / d.length * 100).toFixed(0)}%`.padEnd(34)}  ${r === base || r === ref ? '' : `${pp(mean(d2)).padStart(7)} · ${(d2.filter(x => x > 0).length / d2.length * 100).toFixed(0)}%`}`);
  });
}
// ── 추가 매수 심화 보고
if (AD2.sec) {
  const Rr = AD2.sec, pc1 = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%', pp = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%p';
  const early = YEARS_ALL.filter(y => y <= 2019), late = YEARS_ALL.filter(y => y > 2019), mean = a => a.reduce((x, y) => x + y, 0) / a.length, first = Rr[0];
  let cur = '';
  Rr.forEach(r => {
    if (r.sec !== cur) { cur = r.sec; log(''); log(`## 추가 매수 심화 ${cur}`); log('방식                                   전체    앞쪽    뒤쪽    낙폭    기준 대비 효과(종목 절반 되풀이 평균 · 표준편차 · 이긴 비율)'); }
    const b = r.base ? Rr.find(x => x.name === r.base) : null;
    let eff = '(기준)';
    if (b) { const d = r.halves.map((h, i) => h - b.halves[i]), sd = Math.sqrt(mean(d.map(x => (x - mean(d)) ** 2))); eff = `${pp(mean(d)).padStart(7)} · ${(sd * 100).toFixed(1)}%p · ${(d.filter(x => x > 0).length / d.length * 100).toFixed(0)}%   vs ${b.name}`; }
    log(`${r.name.padEnd(36)} ${pc1(r.full.cagr).padStart(7)} ${pc1(cagrOver(r.full.yearly, early)).padStart(7)} ${pc1(cagrOver(r.full.yearly, late)).padStart(7)} ${pc1(r.full.mdd).padStart(7)}    ${eff}`);
  });
  log('※ ④에서 "수익 중인 종목 100%"의 이득이 N이 작을수록 줄거나 사라지면 이득의 원천은 집중(분산 감소)이고, N과 무관하게 남으면 "오른 종목에 더 넣기" 자체의 효과.');
}
// ── 추가 매수 비율 보고
if (AD.rows) {
  const Rr = AD.rows, base = Rr[0], pc1 = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%', pp = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%p';
  const early = YEARS_ALL.filter(y => y <= 2019), late = YEARS_ALL.filter(y => y > 2019), mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  log(''); log('## 현금(입금 + 판 돈)을 보유 종목에 추가 매수하면? (점수 상위 4, 유예2+금리+tp2x, 첫날 체결, 월 100만원; 나머지는 신규 매수)');
  log('방식                              전체    앞쪽    뒤쪽    낙폭    지금 방식 대비 효과(종목 절반 되풀이 평균 · 표준편차 · 이긴 비율)');
  Rr.forEach(r => {
    const d = r.halves.map((h, i) => h - base.halves[i]), sd = Math.sqrt(mean(d.map(x => (x - mean(d)) ** 2)));
    log(`${r.v.name.padEnd(30)} ${pc1(r.full.cagr).padStart(7)} ${pc1(cagrOver(r.full.yearly, early)).padStart(7)} ${pc1(cagrOver(r.full.yearly, late)).padStart(7)} ${pc1(r.full.mdd).padStart(7)}    ${r === base ? '(기준)' : `${pp(mean(d)).padStart(7)} · ${(sd * 100).toFixed(1)}%p · ${(d.filter(x => x > 0).length / d.length * 100).toFixed(0)}%`}`);
  });
  log('※ 추가 매수는 보유 종목 수를 늘리지 않아 분산이 줄고 낙폭이 커질 수 있음. 평균이 표준편차보다 크고 이긴 비율이 90% 이상이며 앞·뒤 연도가 같은 방향일 때만 믿을 것. 두 종목 범위(시총·거래대금)에서 같은 방향인지 볼 것.');
}
// ── 금리 판단 기준 보고
if (RT6.rows) {
  const Rr = RT6.rows, none = Rr[0], pc1 = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%', pp = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%p';
  const early = YEARS_ALL.filter(y => y <= 2019), late = YEARS_ALL.filter(y => y > 2019), mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  log(''); log('## 금리 규칙의 "오르는 중" 판단 기준 비교 (점수 상위 4, 유예2 + tp2x, 첫날 체결, 월 100만원; 금리가 오르는 중이면 유예 없이 즉시 매도)');
  log('기준                                          전체    앞쪽    뒤쪽    낙폭    규칙 없음 대비 효과(종목 절반 되풀이 평균 · 표준편차 · 이긴 비율)');
  Rr.forEach(r => {
    const d = r.halves.map((h, i) => h - none.halves[i]);
    const sd = Math.sqrt(mean(d.map(x => (x - mean(d)) ** 2)));
    log(`${r.name.padEnd(44)} ${pc1(r.full.cagr).padStart(7)} ${pc1(cagrOver(r.full.yearly, early)).padStart(7)} ${pc1(cagrOver(r.full.yearly, late)).padStart(7)} ${pc1(r.full.mdd).padStart(7)}    ${r === none ? '(기준)' : `${pp(mean(d)).padStart(7)} · ${(sd * 100).toFixed(1)}%p · ${(d.filter(x => x > 0).length / d.length * 100).toFixed(0)}%`}`);
  });
  log('※ 효과의 평균이 표준편차보다 크고 이긴 비율이 90% 이상이어야 믿을 만함. 같은 데이터로 20가지 가까이 비교한 것이라 최고값은 과장됨. 두 종목 범위(시총·거래대금)에서 같은 방향인지 볼 것.');
}
// ── 종목 절반 되풀이 보고
if (BS.eff) {
  const E = BS.eff, mean = a => a.reduce((x, y) => x + y, 0) / a.length, sd = a => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); }, med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const pp = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%p';
  log(''); log(`## 종목을 무작위 절반씩 나눠 ${BS.n}번 되풀이 (점수 상위 4, 첫날 체결, 월 100만원): 설정 효과가 어느 종목 묶음에서나 같은 방향인가?`);
  log('요소                              평균        중앙값      표준편차    양수인 비율 (절반 중)');
  [['익절 트레일 2배 − 없음 (매도 방식 4가지 평균)', E.tp2], ['유예2 − 이탈 즉시', E.g2], ['유예2+금리 − 이탈 즉시', E.g2r], ['유예3+금리 − 이탈 즉시', E.g3r], ['금리 규칙 (유예2+금리 − 유예2)', E.rate2]].forEach(([n, a]) => log(`${n.padEnd(40)} ${pp(mean(a)).padStart(8)}  ${pp(med(a)).padStart(8)}  ${pp(sd(a)).padStart(8)}   ${(a.filter(v => v > 0).length / a.length * 100).toFixed(0)}%`));
  log(`지금 설정(N4·tp2x·유예2+금리)의 절반별 연평균: 평균 ${(mean(E.base) * 100).toFixed(1)}% · 최소 ${(Math.min(...E.base) * 100).toFixed(1)}% · 최대 ${(Math.max(...E.base) * 100).toFixed(1)}%`);
  const cnt = {}; E.cfgBest.forEach(c => { cnt[c] = (cnt[c] || 0) + 1; });
  log('절반마다 가장 좋았던 설정(8가지 중): ' + Object.entries(cnt).sort((x, y) => y[1] - x[1]).map(([c, n]) => `${c.replace('0|', '익절없음 ').replace('2|', 'tp2x ')} ${n}번`).join(' · '));
  log('※ 표준편차가 평균보다 크고 양수 비율이 50~70%이면 그 요소의 효과는 "어느 종목이 들어 있느냐"에 달린 것(믿기 어려움). 90% 이상 한 방향이어야 안정적.');
}
if (WF.res) {
  const R0 = WF.res, pc1 = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%', gm = WF.gm, early = YEARS_ALL.filter(y => y <= 2019), late = YEARS_ALL.filter(y => y > 2019);
  log(''); log(`## 설정을 해마다 "그 전까지의 성과"로 고르면 (현실에서 가능한 방법). 고르는 해: ${R0.oosYears[0]}~${R0.oosYears[R0.oosYears.length - 1]} (최소 3년 과거 필요)`);
  log(`후보 ${WF.cfgs.length}가지 = 종목 수 N 2·3·4·6·10 × 익절 트레일 없음·1.5·2·3배 × 매도(이탈 즉시·유예2·유예3, 금리 규칙 있음/없음). 점수 상위 N, 첫날 체결, 정수 주문, 보유 종목 제외, 월 100만원.`);
  log('방법                                         연평균(같은 기간)   고른 설정 수   바꾼 횟수');
  Object.entries(R0.crit).forEach(([cn, r]) => log(`걸어가며 고르기 · ${cn.padEnd(30)} ${pc1(r.cagr).padStart(8)}        ${String(r.distinct).padStart(4)}          ${String(r.changes).padStart(4)}`));
  log(`지금 쓰는 고정 설정 (${R0.fixed.name})                  ${pc1(R0.fixedCagr).padStart(8)}   ← 전체 기간을 보고 고른 설정이라 사후적`);
  log(`후보 전체 평균(아무 설정이나 골랐을 때)             ${pc1(R0.avgCfg).padStart(8)}`);
  log(`사후 최고 (${R0.best.name})                       ${pc1(gm(R0.best, R0.oosYears)).padStart(8)}   ← 현실에서는 알 수 없음`);
  const k0 = Object.keys(R0.crit)[0];
  log(`\n해마다 고른 설정과 그해 실제 수익 (${k0})`);
  R0.crit[k0].hist.forEach(h => log(`  ${h.Y}  ${h.name.padEnd(34)} 그해 ${pc1(h.r).padStart(8)}   (과거 점수 ${pc1(h.pastScore)})`));
  log('\n후보 중 같은 기간 연평균 상위 8 / 하위 5');
  R0.sorted.slice(0, 8).forEach(c => log(`  ${c.name.padEnd(36)} ${pc1(gm(c, R0.oosYears)).padStart(8)}  (앞쪽 ${pc1(gm(c, early.filter(y => R0.oosYears.includes(y)))).padStart(7)} · 뒤쪽 ${pc1(gm(c, late)).padStart(7)})`));
  R0.sorted.slice(-5).forEach(c => log(`  ${c.name.padEnd(36)} ${pc1(gm(c, R0.oosYears)).padStart(8)}`));
  // 요소별 효과: 한 요소를 바꿀 때 나머지는 모든 조합으로 평균(같은 조합끼리 짝지어 뺀 값)
  log('\n요소별 효과 (나머지 요소는 모든 조합으로 맞춘 짝끼리 비교, 같은 기간 연평균 차이 %p · 앞쪽/뒤쪽 · 이긴 짝 비율)');
  const grp = (label, keyFn, baseKey, others) => {
    const keys = [...new Set(WF.cfgs.map(keyFn))];
    keys.filter(k => k !== baseKey).forEach(k => {
      const d = [], de = [], dl = [];
      WF.cfgs.filter(c => keyFn(c) === k).forEach(c => {
        const b = WF.cfgs.find(x => keyFn(x) === baseKey && others(x) === others(c)); if (!b) return;
        d.push(gm(c, R0.oosYears) - gm(b, R0.oosYears)); de.push(gm(c, early.filter(y => R0.oosYears.includes(y))) - gm(b, early.filter(y => R0.oosYears.includes(y)))); dl.push(gm(c, late) - gm(b, late));
      });
      const av = a => a.reduce((x, y) => x + y, 0) / a.length;
      log(`  ${label} ${String(k).padEnd(12)} − ${String(baseKey).padEnd(10)} ${(av(d) * 100).toFixed(1).padStart(6)}%p   (${(av(de) * 100).toFixed(1)} / ${(av(dl) * 100).toFixed(1)})   이긴 짝 ${(d.filter(v => v > 0).length / d.length * 100).toFixed(0)}%`);
    });
  };
  grp('익절 트레일', c => c.tp ? c.tp + 'x' : '없음', '없음', c => c.N + '|' + c.sl.n);
  grp('매도 방식  ', c => c.sl.n, '이탈 즉시', c => c.N + '|' + c.tp);
  const rateNo = c => c.sl.g ? c.sl.g : 0;
  log('  (금리 규칙) 유예2: 금리 있음 − 없음 / 유예3: 금리 있음 − 없음');
  [2, 3].forEach(g => { const d = []; WF.cfgs.filter(c => c.sl.g === g && c.sl.r).forEach(c => { const b = find2(c, g); if (b) d.push(gm(c, R0.oosYears) - gm(b, R0.oosYears)); }); log(`    유예${g}: ${(d.reduce((a, b) => a + b, 0) / d.length * 100).toFixed(1)}%p  이긴 짝 ${(d.filter(v => v > 0).length / d.length * 100).toFixed(0)}%`); });
  function find2(c, g) { return WF.cfgs.find(x => x.N === c.N && x.tp === c.tp && x.sl.g === g && !x.sl.r); }
  const byN = [2, 3, 4, 6, 10].map(N => { const a = WF.cfgs.filter(c => c.N === N).map(c => gm(c, R0.oosYears)); return `N${N} ${pc1(a.reduce((x, y) => x + y, 0) / a.length)}`; });
  log('  종목 수별 후보 평균 연평균: ' + byN.join(' · '));
  log('※ 해석: "걸어가며 고르기"가 "고정 설정"보다 낮으면 지금 설정의 성과는 사후적으로 좋아 보인 것. 요소별 효과가 앞쪽·뒤쪽에서 같은 방향이고 이긴 짝 비율이 높을 때만 그 요소를 믿을 것.');
}
// ── 3단계 보고
if (S3.rows.length) {
  const o0 = S3.rows[0], pc1 = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%', f2 = x => Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(3) : '   -  ';
  log(''); log('## 3단계: 정답·학습 방식을 바꾼 점수 모델 비교 (점수 상위 4, 첫날 체결, 판매 규칙 tp2x트레일+금리유예2달, 정수 주문, 월 100만원, 비용·세금 반영)');
  log(`검산: 기준 변형(orig)이 기존 A 모델 점수와 최대 ${S3.check ? S3.check.max.toExponential(1) : '?'} 차이 (${S3.check ? S3.check.n : 0}건 중 빠진 것 ${S3.check ? S3.check.miss : '?'}건) — 둘 다 0이어야 같은 학습·같은 정답`);
  if (FUND.on) log(`재무 지표(SEC): 미국 신호 ${FUND.us}건 중 ${FUND.cover}건(${(FUND.cover / FUND.us * 100).toFixed(0)}%)에 값이 있음. 한국은 자료가 없어 빈 값(점수 계산에서 평균으로 대체). 값은 신호 달 말까지 공시된 것만 사용.`);
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

// ── 매매일지(trades.json): 확인 매수(돌파 달에 샀다고 가정한 가상 수익 +10% 이상 + 5>10>20 정배열일 때 다음 달 첫날 구매) + tp2x트레일·금리유예2달 판매, 월 100만원
//    JOURNAL_STRAT=breakout 이면 예전 방식(돌파 달 월말 구매)으로 만듦. 확인 매수 후보의 점수는 돌파 시점 점수(그때 알던 값). 가상 포지션의 진입가 = 돌파 다음 달 시가(사이트가 월봉만으로 같은 판단을 하도록)
progress('매매일지', 0);
const JOURNAL_STRAT = process.env.JOURNAL_STRAT || 'confirm', CONF_THR = +process.env.CONF_THR || 0.1;
const maAtJ = (o, k, n) => { let t = 0; for (let j = k; j > k - n; j--) { const p = o.m.get(j); if (p === undefined) return null; t += p; } return t / n; };
const alignJ = (o, k) => { const a = maAtJ(o, k, 5), b = maAtJ(o, k, 10), d = maAtJ(o, k, 20); return (a != null && b != null && d != null) ? (a > b && b > d) : null; };
function confirmTrig(r) {                                            // 돌파 신호가 처음으로 "가상 수익 ≥ 문턱 + 정배열"이 되는 달(월 인덱스)과 가상 수익. 가상 포지션이 먼저 팔리면(익절 트레일·유예·금리) null
  const o = px(r.y), t0 = mi(r.ym), p0 = o.op.get(t0 + 1) || fdPx(r.y, t0 + 1); if (!(p0 > 0)) return null;
  let tp = false, cnt = 0;
  for (let j = t0 + 1; j <= END; j++) {
    const p = o.m.get(j); if (p === undefined) return null;
    const ma = ma10(o, j);
    if (ma) { if (p >= 2 * ma) tp = true; else if (tp) return null; if (p < ma) { cnt++; const n = rateJ(j) === true ? 1 : 2; if (cnt >= n) return null; } else cnt = 0; }
    if (p / p0 - 1 >= CONF_THR && alignJ(o, j) === true) return { j, pnl: p / p0 - 1, p0 };
  }
  return null;
}
const confirmMap = new Map();
if (JOURNAL_STRAT === 'confirm') {
  scored[kA].forEach(list => list.forEach(e => { const t = confirmTrig(e.r); if (!t) return; const ym = ymOf(t.j), r2 = Object.assign({}, e.r, { ym, exoff: null }), a = confirmMap.get(ym) || []; a.push({ r: r2, s: e.s, pnl: t.pnl, brk: e.r.ym }); confirmMap.set(ym, a); }));
  confirmMap.forEach(a => a.sort((x, y) => y.s - x.s));
}
// 수급 규칙(2026-11-27 채택, 묶음 35~38): 확인 달에 외국인·기관이 같은 방향(둘 다 순매수 또는 둘 다 순매도)인 한국 종목은 후보에서 뺌. 자료 없음은 그대로. 끄려면 JOURNAL_FLOW=0
const JOURNAL_FLOW = process.env.JOURNAL_FLOW !== '0', FLOW = JOURNAL_FLOW ? require('./flow').load(DATA) : null, flowOut = new Map();
const flowSame = (y, ym) => FLOW && /\.(KS|KQ)$/.test(y) ? FLOW.same(y.slice(0, 6), ym) : null;
if (FLOW) confirmMap.forEach((a, ym) => { const kept = a.filter(e => flowSame(e.r.y, ym) !== true); if (kept.length < a.length) flowOut.set(ym, a.length - kept.length); confirmMap.set(ym, kept); });
if (FLOW) { let tot = 0, nvM = 0; flowOut.forEach(v => { tot += v; }); confirmMap.forEach((a, ym) => { if (FLOW.src(ym) === 'naver') nvM++; }); console.log(`\n수급 규칙: 외국인·기관 같은 방향인 한국 후보 ${tot}건 제외(${flowOut.size}개월) · 네이버 자료로 판단한 달 ${nvM}개`); }
const jCand = JOURNAL_STRAT === 'confirm' ? (ym => confirmMap.get(ym) || []) : (ym => scored[kA].get(ym) || []);
const JOURNAL_EXIT_MA = process.env.JOURNAL_EXIT_MA || 'kr6us10';        // 판매 기준 이평: kr6us10 = 한국 6이평 · 미국 10이평(2026-11-27 채택, 익절 트레일·후보 풀은 10이평 그대로), ma10 = 예전 방식
const journalExitMa = JOURNAL_EXIT_MA === 'kr6us10' ? { exitMaFn: (h, k) => maAtJ(h.px, k, /\.(KS|KQ)$/.test(h.y) ? 6 : 10) } : {};
const JOURNAL_PRESELL = process.env.JOURNAL_PRESELL !== '0';               // 양도세 몫 미리 확보(2026-11-28 채택, 묶음 49): 11월 말 입금 전 현금이 올해 양도세보다 적으면 미리 팖. 끄려면 JOURNAL_PRESELL=0
const journalSim = simulate(ym => jCand(ym).slice(0, 4), 4, C1, { tpTrail: 2, grace: 2, graceRate: true, rateFn: rateJ, ...journalExitMa, taxPresell: JOURNAL_PRESELL, lotSize: true, lotAll: true, fill: true, cand: jCand, firstDay: JOURNAL_STRAT === 'confirm', log: true });   // 실제 주문 가능한 정수 주(한국·미국), 못 사면 다음 점수 순위를 사고, 추천이 모자라면 있는 만큼 나눔
const listData = JSON.parse(fs.readFileSync(path.join(DATA, 'lists.json')));
const nameMap = new Map(listData.map(s => [s.y, { name: s.name, market: s.mk, code: s.code }]));
const journal = {
  meta: { flowRule: JOURNAL_FLOW, taxPresell: JOURNAL_PRESELL, strategy: JOURNAL_STRAT === 'confirm' ? '10이평 돌파 후 +10% 이상 + 5>10>20 정배열 매수' + (JOURNAL_FLOW ? '(외국인·기관 같은 방향인 한국 종목 제외)' : '') + ' · tp2x트레일 · 한국 6이평/미국 10이평 이탈 금리유예2달 · 다음 달 첫날 구매' : 'A4 tp2x트레일+금리유예2달', firstDay: JOURNAL_STRAT === 'confirm', dep: 1000000, made: new Date().toISOString() },
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
  const candsOf = (ymKey, k) => jCand(ymKey).slice(0, CAND_N).map(e => { const o = px(e.r.y), p = JOURNAL_STRAT === 'confirm' ? (fdPx(e.r.y, k + 1) ?? undefined) : o.m.get(k); return p === undefined ? null : { y: e.r.y, name: nm(e.r.y), us: e.r.x[US] === 1, etf: e.r.x[ETF] === 1, px: p, score: +e.s.toFixed(4), brk: e.brk || null }; }).filter(Boolean);   // confirm이면 px = 다음 달 첫날 종가(그 달 말에 확정된 후보를 다음 달 첫날 삼)
  for (const [ym, m] of (journalSim.ledger || new Map())) {
    months[ym] = {
      dep: m.dep, tax: r0(m.tax), cash: r0(m.cash), holdVal: r0(m.holdVal), fx: +m.fx.toFixed(2),
      rateUp: rateJ(m.k) === true,                    // 그달 기준금리 상승 중(판매 유예를 건너뛰는 조건): 시작 시점을 바꿔 다시 계산할 때 판매 시점을 구하는 데 씀
      cands: candsOf(ym, m.k),                            // 그달 점수 상위 후보 12개: 못 사면 다음 순위로 채우는 계산(시작 시점 바꾸기)에 씀
      buys: m.buys.map(x => ({ y: x.y, name: nm(x.y), us: x.us, sh: x.sh, px: x.px, amt: r0(x.amt), gross: r0(x.gross), fee: r0(x.fee), feeRate: x.feeRate,
        fxUsed: x.fx == null ? null : +x.fx.toFixed(2), score: +x.score.toFixed(4) })),
      sells: m.sells.map(x => ({ y: x.y, name: nm(x.y), us: x.us, sh: x.sh, px: x.px, amt: r0(x.amt), basis: r0(x.basis), gross: r0(x.gross), fee: r0(x.fee),
        feeRate: x.feeRate, tax: r0(x.tax), taxRate: x.taxRate, fxUsed: x.fx == null ? null : +x.fx.toFixed(2), ret: +x.ret.toFixed(4), reason: x.reason, buyYm: x.buyYm })),
      skipped: m.skipped.map(x => ({ y: x.y, name: nm(x.y), us: x.us, px: x.px, one: r0(x.pKrw), per: r0(x.per) })),
      order: m.order || []
    };
  }
  fs.writeFileSync(path.join(DATA, 'ledger.json'), JSON.stringify({ meta: { excludeHeld: true, firstDay: JOURNAL_STRAT === 'confirm', strategy: JOURNAL_STRAT, dep: DEP, made: new Date().toISOString(), orders: '정수 주(한국·미국), 못 사면 다음 점수 순위, 추천이 모자라면 있는 만큼 나눔' }, months }));
  require('./8_bars.js');                                  // 매매일지 차트용 월봉(bars.json): 거래한 종목 + 장부의 후보 종목
}                                      // 매매일지 차트용 월봉(bars.json)
