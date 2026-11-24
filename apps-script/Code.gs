/**
 * 주식 점수 — 월봉 10이평 돌파 신호 (Apps Script)
 *
 * 매수: 전달 종가 ≤ 전달 10이평  그리고  이번 달 최근 종가 > 이번 달 10이평
 * 유예: 이번 달 처음 10이평 아래로 내려옴(하향 돌파 1개월째). 다음 달에도 아래면 매도
 * 매도: 하향 돌파 후 2개월째까지 계속 10이평 아래(전전달 위 → 전달·이번 달 아래).
 *       단, 미국 기준금리가 1년 전보다 올라 있으면(FEDFUNDS 전월 - 13개월 전 > 0) 유예 없이 하향 돌파 즉시 매도
 * 10이평 = 최근 10개월 월말 종가 평균(이번 달은 최근 종가를 그 달 종가로 씀)
 *
 * 대상: 코스피 시총 상위 300(ETF·ETN·우선주 포함, 채권·금리·레버리지·인버스형은 제외) + 코스닥 상위 200 + 미국 상위 500
 * 데이터: 한국 = 네이버 시총 순위 + 야후 월봉(15:30 종가, 없으면 네이버)
 *         미국 = 네이버 시총 순위·월봉(막히면 야후)
 *
 * 처음 한 번: setup 실행 → 탭 만들기 + 매일 자동 갱신 예약
 */

var CFG = {
  KOSPI_N: 300,
  KOSDAQ_N: 200,
  US_N: 500,
  MONTHS: 10,          // 이동평균 개월 수
  CHART_N: 45,         // 차트용으로 저장하는 개월 수(화면 36개월 + 10이평 계산용 9개월)
  BATCH: 40,           // 한 번에 동시에 받는 개수(100으로 올렸더니 야후 31.6→37.0초, 네이버 31.8→47.5초로 오히려 느려져 40으로 되돌림)
  UA: { 'User-Agent': 'Mozilla/5.0' }
};

var HEAD = ['시장', '코드', '이름', '종류', '시총', '시총단위', '최근종가', '10이평',
            '전달종가', '전달10이평', '신호', '기준일', '개월수', '차트', '점수'];

/* ───────── 처음 한 번 실행 ───────── */
function setup() {
  var ss = SpreadsheetApp.getActive();
  ['한국', '미국', '로그'].forEach(function (n) {
    if (!ss.getSheetByName(n)) ss.insertSheet(n);
  });
  var s1 = ss.getSheetByName('시트1');
  if (s1 && ss.getSheets().length > 1 && s1.getLastRow() === 0) ss.deleteSheet(s1);

  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  // 한국: 장 마감(15:30) 뒤
  ScriptApp.newTrigger('updateKR').timeBased().everyDays(1).atHour(17).nearMinute(5)
    .inTimezone('Asia/Seoul').create();
  // 미국: 마감(뉴욕 16:00 = 한국 05:00~06:00) 뒤
  ScriptApp.newTrigger('updateUS').timeBased().everyDays(1).atHour(7).nearMinute(5)
    .inTimezone('Asia/Seoul').create();
  log_('setup', '탭·자동 갱신 예약 완료');
}

/* ───────── 한 번에 갱신: 이 함수 하나만 실행하면 한국·미국 둘 다 갱신 ───────── */
function updateAll() {
  var t0 = new Date();
  updateKR();
  updateUS();
  log_('updateAll', '합계 ' + Math.round((new Date() - t0) / 1000) + '초');
}

// 단계별 걸린 시간 기록(로그 탭에 한 줄로 남김) — 어디서 시간이 걸리는지 보려는 용도
function newTimer_() {
  var start = new Date(), parts = [];
  return {
    lap: function (label, t0) { parts.push(label + ' ' + ((new Date() - t0) / 1000).toFixed(1)); },
    note: function (txt) { if (txt) parts.push(txt); },
    text: function () { return '[' + parts.join(' / ') + ' / 총 ' + ((new Date() - start) / 1000).toFixed(1) + '초]'; }
  };
}

/* ───────── 한국 ───────── */
function updateKR() {
  var t0 = new Date(), T = newTimer_(), t;
  t = new Date();
  var list = naverTop_('KOSPI', CFG.KOSPI_N).concat(naverTop_('KOSDAQ', CFG.KOSDAQ_N));
  T.lap('목록', t);
  // 월봉은 야후 먼저: 15:30 정규장 종가. 네이버 가격엔 16:00~18:00 시간외 단일가가 섞임
  t = new Date();
  var bodies = fetchAll_(list.map(function (s) {
    return 'https://query1.finance.yahoo.com/v8/finance/chart/' + s.code + (s.market === 'KOSPI' ? '.KS' : '.KQ') +
           '?range=' + (CFG.CHART_N + 2) + 'mo&interval=1mo';
  }));
  T.lap('야후받기', t);
  t = new Date();
  var rows = [], retry = [];
  list.forEach(function (s, i) {
    var mon = parseYahooMonthly_(bodies[i]);
    if (mon && mon.length > CFG.MONTHS) rows.push(makeRow_(s, mon)); else retry.push(s);
  });
  T.lap('계산·점수', t);
  // 야후에 없거나 막히면 네이버 월봉
  var fail = 0;
  if (retry.length) {
    t = new Date();
    var b2 = fetchAll_(retry.map(function (s) {
      return 'https://fchart.stock.naver.com/sise.nhn?symbol=' + s.code +
             '&timeframe=month&count=' + (CFG.CHART_N + 2) + '&requestType=0';
    }));
    T.lap('네이버대체(' + retry.length + '개)', t);
    t = new Date();
    retry.forEach(function (s, i) {
      var mon = parseNaverMonthly_(b2[i]);
      if (mon) rows.push(makeRow_(s, mon)); else fail++;
    });
    T.lap('대체계산', t);
  }
  rows.sort(function (a, b) { return b[4] - a[4]; });
  t = new Date();
  var wd = writeRows_('한국', rows);
  T.lap('시트쓰기', t); T.note(wd);
  log_('updateKR', rows.length + '종목, 네이버 대체 ' + (retry.length - fail) + ', 실패 ' + fail + ', ' +
       Math.round((Date.now() - t0) / 1000) + '초 ' + T.text());
}

// 제외 종목: 채권·금리(CD·KOFR)·머니마켓·단기채 등 가격이 거의 안 움직이는 상품, 레버리지·인버스(음의 복리)
// tools/learn/1_lists.js의 EXCLUDE와 같은 규칙으로 유지할 것
var EXCLUDE_RE = /채권|국채|통안채|금리|머니마켓|레버리지|인버스|곱버스|\b[23]X\b/;

function naverTop_(market, n) {
  var out = [];
  for (var page = 1; out.length < n; page++) {
    var url = 'https://m.stock.naver.com/api/stocks/marketValue/' + market +
              '?page=' + page + '&pageSize=100';
    var d = JSON.parse(UrlFetchApp.fetch(url, { headers: CFG.UA }).getContentText());
    if (!d.stocks || !d.stocks.length) break;
    d.stocks.forEach(function (x) {
      if (out.length < n && !EXCLUDE_RE.test(x.stockName)) out.push({
        market: market, code: x.itemCode, name: x.stockName, type: x.stockEndType,
        cap: num_(x.marketValue), capUnit: '억원'
      });
    });
  }
  return out;
}

// <item data="20261123|시가|고가|저가|종가|거래량" />
function parseNaverMonthly_(xml) {
  if (!xml) return null;
  var re = /data="(\d{8})\|([\d.]+)\|([\d.]+)\|([\d.]+)\|([\d.]+)\|(\d*)/g, m, mon = [];
  while ((m = re.exec(xml))) {
    var d = m[1];
    mon.push({ ym: d.slice(0, 6), date: d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6),
               open: +m[2], high: +m[3], low: +m[4], close: +m[5], vol: +m[6] || 0 });
  }
  return mon.length ? mon : null;
}

/* ───────── 미국 ───────── */
// 네이버 해외주식(나스닥·뉴욕·아멕스) 시총 순위 → 네이버 월봉(막히면 야후 월봉)
function updateUS() {
  var t0 = new Date(), T = newTimer_(), t;
  t = new Date();
  var list = naverUSTop_(CFG.US_N);
  T.lap('목록', t);
  var now = new Date(), y = now.getFullYear(), m = now.getMonth() + 1;
  var start = (y - 4) + pad_(m) + '010000', end = (y + 1) + '01010000';
  t = new Date();
  var bodies = fetchAll_(list.map(function (s) {
    return 'https://api.stock.naver.com/chart/foreign/item/' + encodeURIComponent(s.reuters) +
           '/month?startDateTime=' + start + '&endDateTime=' + end;
  }));
  T.lap('네이버받기', t);
  t = new Date();
  var rows = [], retry = [];
  list.forEach(function (s, i) {
    var mon = parseNaverUSMonthly_(bodies[i], s.date);
    if (mon) rows.push(makeRow_(s, mon)); else retry.push(s);
  });
  T.lap('계산·점수', t);
  var fail = 0;
  if (retry.length) {
    t = new Date();
    var b2 = fetchAll_(retry.map(function (s) {
      return 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(s.yahoo) +
             '?range=' + (CFG.CHART_N + 2) + 'mo&interval=1mo';
    }));
    T.lap('야후대체(' + retry.length + '개)', t);
    t = new Date();
    retry.forEach(function (s, i) {
      var mon = parseYahooMonthly_(b2[i]);
      if (mon) rows.push(makeRow_(s, mon)); else fail++;
    });
    T.lap('대체계산', t);
  }
  rows.sort(function (a, b) { return b[4] - a[4]; });
  t = new Date();
  var wd = writeRows_('미국', rows);
  T.lap('시트쓰기', t); T.note(wd);
  log_('updateUS', rows.length + '종목, 야후 대체 ' + (retry.length - fail) + ', 실패 ' + fail + ', ' +
       Math.round((Date.now() - t0) / 1000) + '초 ' + T.text());
}

function naverUSTop_(n) {
  var urls = [];
  [['NASDAQ', 5], ['NYSE', 5], ['AMEX', 1]].forEach(function (e) {
    for (var p = 1; p <= e[1]; p++)
      urls.push('https://api.stock.naver.com/stock/exchange/' + e[0] + '/marketValue?page=' + p + '&pageSize=100');
  });
  var all = [];
  fetchAll_(urls).forEach(function (txt) {
    if (!txt) return;
    (JSON.parse(txt).stocks || []).forEach(function (x) {
      var cap = num_(x.marketValue);                       // 단위: 천 달러
      if (cap > 0) all.push({
        market: 'US', code: x.symbolCode, reuters: x.reutersCode,
        yahoo: String(x.symbolCode).replace(/\s+/g, '-'),
        name: x.stockName, type: x.stockEndType || 'stock',
        cap: Math.round(cap / 1e5), capUnit: '억달러',
        date: String(x.localTradedAt || '').slice(0, 10)
      });
    });
  });
  all.sort(function (a, b) { return b.cap - a.cap; });
  return all.slice(0, n);
}

// [{localDate:"20261101", closePrice:342.56, ...}] — 이번 달 봉 = 최근 종가
function parseNaverUSMonthly_(txt, lastDate) {
  try {
    var d = JSON.parse(txt);
    if (!d || !d.length) return null;
    return d.map(function (x, i) {
      var ld = String(x.localDate);
      return { ym: ld.slice(0, 6), close: +x.closePrice, open: +x.openPrice, high: +x.highPrice,
               low: +x.lowPrice, vol: +x.accumulatedTradingVolume || 0,
               date: i === d.length - 1 && lastDate ? lastDate : ld.slice(0, 4) + '-' + ld.slice(4, 6) };
    });
  } catch (e) { return null; }
}

function parseYahooMonthly_(txt) {
  try {
    var r = JSON.parse(txt).chart.result[0];
    // 월봉 시각은 뉴욕 자정이라 서머타임 때 gmtoffset(겨울 기준)으로 바꾸면 전날로 밀림 → 6시간 더함
    var off = (r.meta.gmtoffset || 0) + 6 * 3600, ts = r.timestamp, q = r.indicators.quote[0], c = q.close;
    var by = {}, keys = [];
    for (var i = 0; i < ts.length; i++) {
      if (c[i] == null) continue;
      var d = new Date((ts[i] + off) * 1000);
      var ym = '' + d.getUTCFullYear() + pad_(d.getUTCMonth() + 1);
      if (!by[ym]) keys.push(ym);
      // 같은 달이 두 번 오면(월봉 + 오늘 하루치) 합침: 종가는 뒤의 값, 시가는 앞의 값,
      // 고가·저가는 최대·최소(0은 빈 값), 거래량은 큰 쪽
      var o = q.open[i] || null, h = q.high[i] || null, l = q.low[i] || null, v = q.volume[i] || 0, p = by[ym];
      by[ym] = p ? { close: c[i], open: p.open || o,
                     high: Math.max(p.high || 0, h || 0) || null,
                     low: Math.min(p.low || Infinity, l || Infinity) === Infinity ? null : Math.min(p.low || Infinity, l || Infinity),
                     vol: Math.max(p.vol, v) }
                 : { close: c[i], open: o, high: h, low: l, vol: v };
    }
    var last = new Date(((r.meta.regularMarketTime || ts[ts.length - 1]) + off) * 1000);
    var lastYm = '' + last.getUTCFullYear() + pad_(last.getUTCMonth() + 1);
    if (r.meta.regularMarketPrice && by[lastYm] != null) by[lastYm].close = r.meta.regularMarketPrice;
    var lastDate = last.getUTCFullYear() + '-' + pad_(last.getUTCMonth() + 1) + '-' + pad_(last.getUTCDate());
    return keys.map(function (k) {
      var b = by[k];
      return { ym: k, date: k === lastYm ? lastDate : k.slice(0, 4) + '-' + k.slice(4),
               close: b.close, open: b.open, high: b.high, low: b.low, vol: b.vol };
    });
  } catch (e) { return null; }
}

/* ───────── 점수 계산 (weights.json 기반, GitHub raw에서 받음) ───────── */
var WEIGHTS_URL = 'https://raw.githubusercontent.com/seilsci/stock-score/main/tools/learn/result/weights.json';
var GBM_URL = 'https://raw.githubusercontent.com/seilsci/stock-score/main/tools/learn/result/gbm.json';
var GBM = null, GBM_TRIED = false;
// 트리 점수 모델(gbm.json). 올라와 있으면 이것으로 점수를 내고, 못 받으면 아래 선형 모델(weights.json)로 계산
function getGbm_() {
  if (GBM || GBM_TRIED) return GBM;
  GBM_TRIED = true;
  try {
    var r = UrlFetchApp.fetch(GBM_URL, { headers: CFG.UA, muteHttpExceptions: true });
    if (r.getResponseCode() === 200) GBM = JSON.parse(r.getContentText());
  } catch (e) { GBM = null; }
  return GBM;
}
var WEIGHTS = null;
function getWeights_() {
  if (WEIGHTS) return WEIGHTS;
  try {
    WEIGHTS = JSON.parse(UrlFetchApp.fetch(WEIGHTS_URL, { headers: CFG.UA }).getContentText());
  } catch (e) { WEIGHTS = null; }
  return WEIGHTS;
}
// 월봉 배열 → 학습 지표 → 점수 (0~100)
function scoreMonthly_(mon, s) {
  var W = getWeights_(), GM = getGbm_();
  if ((!W && !GM) || mon.length < 25) return '';
  var n = mon.length, c = mon.map(function (x) { return x.close; });
  var ma = c.map(function (x, i) { return i >= 9 ? avg_(c.slice(i - 9, i + 1)) : null; });
  var above = c.map(function (x, i) { return ma[i] == null ? null : x > ma[i]; });
  var i = n - 1;
  var v = mon.map(function (x) { return x.vol || 0; });
  var vAvg = avg_(v.slice(i - 12, i)) || 1;
  var v3 = avg_(v.slice(i - 2, i + 1)), v12 = avg_(v.slice(i - 14, i - 2)) || 1;
  var hi24 = Math.max.apply(null, mon.slice(i - 24, i).map(function (x) { return x.high; }));
  var hi36 = Math.max.apply(null, mon.slice(Math.max(0, i - 36), i).map(function (x) { return x.high; }));
  var lr = []; for (var k = i - 11; k <= i; k++) lr.push(Math.log(c[k] / c[k - 1]));
  var mm = avg_(lr), volat = Math.sqrt(lr.reduce(function (t, x) { return t + (x - mm) * (x - mm); }, 0) / 12);
  var ma12 = avg_(c.slice(i - 11, i + 1)), ma24 = avg_(c.slice(i - 23, i + 1));
  var ma60 = n >= 60 ? avg_(c.slice(i - 59, i + 1)) : ma12;
  var last = mon[i], prev = mon[i - 1];
  var cross = 0, ab = 0, below = 0;
  for (var k = i - 24; k < i; k++) { if (above[k] !== above[k - 1]) cross++; if (above[k]) ab++; }
  for (var k = i - 1; k >= 0 && above[k] === false; k--) below++;
  var hl = (last.high - last.low) || 1;
  var up = 0, mu = 0;
  for (var k = i - 5; k <= i; k++) { if (c[k] > c[k - 1]) up++; if (ma[k] > ma[k - 1]) mu++; }
  var pf = 0;
  for (var k = Math.max(11, i - 36); k < i - 1; k++)
    if (c[k - 1] <= ma[k - 1] && c[k] > ma[k]) { for (var j = k + 1; j <= Math.min(k + 3, i - 1); j++) if (!above[j]) { pf++; break; } }
  var feats = {
    gap: c[i] / ma[i] - 1, slope1: ma[i] / ma[i - 1] - 1, slope3: ma[i] / ma[i - 3] - 1,
    cross24: cross, below: below, above24: ab / 24, c_ma12: c[i] / ma12 - 1, ma10_ma24: ma[i] / ma24 - 1,
    vol: Math.log((last.vol + 1) / (vAvg + 1)), vol3: Math.log((v3 + 1) / (v12 + 1)),
    body: (c[i] - last.open) / last.open, upwick: (last.high - Math.max(last.open, c[i])) / hl,
    lowwick: (Math.min(last.open, c[i]) - last.low) / hl, range: hl / last.open,
    ret1: c[i] / c[i - 1] - 1, ret3: c[i] / c[i - 3] - 1, ret12: c[i] / c[i - 12] - 1,
    high24: c[i] / hi24 - 1, dd36: c[i] / hi36 - 1, volat12: volat,
    idx_above: 0, idx_slope: 0, idx_ret12: 0,
    us: s.market === 'US' ? 1 : 0, etf: s.type === 'stock' ? 0 : 1,
    turn: Math.log10(avg_(v.slice(i - 12, i)) * c[i] + 1), up6: up, slope6: ma[i] / ma[i - 6] - 1,
    c_ma60: c[i] / ma60 - 1, hi12_break: c[i] >= Math.max.apply(null, mon.slice(i - 12, i).map(function (x) { return x.high; })) ? 1 : 0,
    vol_max36: last.vol / (Math.max.apply(null, v.slice(Math.max(0, i - 36), i)) || 1),
    prev_fail: pf, ma_up6: mu, close_pos: (c[i] - last.low) / hl, gap_prev: c[i - 1] / ma[i - 1] - 1
  };
  // 트리 모델: 지표를 모델 범위로 자르고(빈 값은 평균) 모든 나무의 값을 더함 → 점수(분위)
  var raw, pct;
  if (GM) {
    var x = GM.feats.map(function (p) { var v = feats[p.f]; if (v == null || isNaN(v)) return p.m; return Math.min(p.hi, Math.max(p.lo, v)); });
    raw = GM.init;
    for (var ti = 0; ti < GM.trees.length; ti++) {
      var T = GM.trees[ti], nd = 0;
      while (T.f[nd] >= 0) nd = x[T.f[nd]] <= T.t[nd] ? T.l[nd] : T.r[nd];
      raw += T.v[nd];
    }
    pct = GM.pct;
  } else {
    // 선형 모델: 표준화 + 가중 합
    raw = W.b;
    W.feats.forEach(function (f) {
      var v = feats[f.f];
      if (v == null || isNaN(v)) v = f.m;
      var cl = Math.min(f.hi, Math.max(f.lo, v));
      raw += ((cl - f.m) / f.sd) * f.w;
    });
    pct = W.pct;
  }
  // raw → 0~100 (pct 배열로 백분위 변환)
  if (!pct || !pct.length) return '';
  var lo = 0, hi = pct.length - 1;
  while (lo < hi) { var mid = (lo + hi) >> 1; if (pct[mid] < raw) lo = mid + 1; else hi = mid; }
  return Math.round(lo / (pct.length - 1) * 100);
}

/* ───────── 신호 계산 ───────── */
// 미국 기준금리(FEDFUNDS)가 오르는 중인지: (전월 값) - (13개월 전 값) > 0, 매도 유예를 건너뛰는 조건. 못 받으면 false
var FF = null;
function rateUp_() {
  if (FF === null) {
    FF = {};
    try {
      UrlFetchApp.fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=FEDFUNDS', { headers: CFG.UA })
        .getContentText().split('\n').slice(1).forEach(function (l) {
          var p = l.trim().split(',');
          if (p.length > 1 && p[1] && p[1] !== '.') FF[p[0].slice(0, 7)] = +p[1];
        });
    } catch (e) { FF = {}; }
  }
  var now = new Date(Utilities.formatDate(new Date(), 'Asia/Seoul', "yyyy-MM-dd'T'12:00:00"));
  var key = function (back) {
    var d = new Date(now.getFullYear(), now.getMonth() - back, 1);
    return d.getFullYear() + '-' + pad_(d.getMonth() + 1);
  };
  var a = FF[key(1)], b = FF[key(13)];
  return a !== undefined && b !== undefined && a - b > 0;
}

function makeRow_(s, mon) {
  var n = mon.length, M = CFG.MONTHS, c = mon.map(function (x) { return x.close; });
  var cur = c[n - 1], prev = c[n - 2];
  var ma = n >= M ? avg_(c.slice(n - M)) : '';
  var pma = n >= M + 1 ? avg_(c.slice(n - M - 1, n - 1)) : '';
  var pma2 = n >= M + 2 ? avg_(c.slice(n - M - 2, n - 2)) : '';
  var sig = '';
  if (ma !== '' && pma !== '') {
    var below = cur < ma;
    var justCrossed = below && prev >= pma;                                   // 이번 달 처음 아래로
    var second = below && prev < pma && pma2 !== '' && c[n - 3] >= pma2;      // 전달 처음 아래로 → 이번 달 2개월째
    if (prev <= pma && cur > ma) sig = '매수';
    else if (second || (justCrossed && rateUp_())) sig = '매도';
    else if (justCrossed) sig = '유예';
    else sig = cur > ma ? '위' : '아래';
  }
  // 매수·매도·유예 종목만 차트용 월봉 저장: [[YYYYMM, 시가, 고가, 저가, 종가, 거래량], ...]
  // 점수 계산에 쓴 월봉 전체를 보내야 사이트의 "점수 설명"이 시트 점수와 똑같이 계산됨
  var chart = '';
  if (sig === '매수' || sig === '매도' || sig === '유예') {
    chart = JSON.stringify(mon.map(function (x) {
      return [+x.ym, round_(x.open), round_(x.high), round_(x.low), round_(x.close), Math.round(x.vol || 0)];
    }));
  }
  // 매수 신호 종목만 점수 계산
  var scoreVal = sig === '매수' ? scoreMonthly_(mon, s) : '';
  return [s.market, s.code, s.name, s.type, s.cap, s.capUnit, round_(cur), round_(ma), n > 1 ? round_(prev) : '',
          round_(pma), sig, mon[n - 1].date, n, chart, scoreVal];
}

/* ───────── 사이트용 ───────── */
// 응답 캐시: 갱신(updateKR·updateUS)할 때 지우고, 그 사이에는 저장해 둔 응답을 바로 돌려줌(느린 시트 읽기 생략)
var CACHE_CHUNK = 30000;                       // 캐시 한 칸 크기(글자). 한 칸 100KB 제한 때문에 나눠 저장
function cacheGet_(key) {
  var c = CacheService.getScriptCache(), n = +c.get(key + ':n');
  if (!n) return null;
  var keys = []; for (var i = 0; i < n; i++) keys.push(key + ':' + i);
  var got = c.getAll(keys), out = [];
  for (var j = 0; j < n; j++) { if (got[keys[j]] == null) return null; out.push(got[keys[j]]); }
  return out.join('');
}
function cachePut_(key, text) {
  try {
    var c = CacheService.getScriptCache(), put = {}, n = Math.ceil(text.length / CACHE_CHUNK);
    for (var i = 0; i < n; i++) put[key + ':' + i] = text.slice(i * CACHE_CHUNK, (i + 1) * CACHE_CHUNK);
    put[key + ':n'] = String(n);
    c.putAll(put, 21600);                       // 최대 6시간(갱신 때 지워짐)
  } catch (e) {}
}
function cacheClear_() {
  var c = CacheService.getScriptCache();
  ['sig', 'all'].forEach(function (k) {
    var key = 'doGet:' + k, n = +c.get(key + ':n'), keys = [key + ':n'];
    for (var i = 0; i < n; i++) keys.push(key + ':' + i);
    c.removeAll(keys);
  });
}

// ?all=1 이면 모든 종목, 아니면 매수·매도·유예 신호만
function doGet(e) {
  var all = e && e.parameter && e.parameter.all;
  var key = 'doGet:' + (all ? 'all' : 'sig');
  var hit = cacheGet_(key);
  if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
  var ss = SpreadsheetApp.getActive(), out = { updated: {}, rows: [], rateUp: rateUp_() };   // rateUp: 미국 기준금리 상승 중인지(매매일지의 매도 예정 계산용)
  ['한국', '미국'].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (!sh || sh.getLastRow() < 2) return;
    out.updated[n] = sh.getRange('R1').getValue();
    var v = sh.getRange(2, 1, sh.getLastRow() - 1, HEAD.length).getValues();
    v.forEach(function (r) {
      if (!all && r[10] !== '매수' && r[10] !== '매도' && r[10] !== '유예') return;
      var o = {};
      HEAD.forEach(function (h, i) { o[h] = r[i] instanceof Date ? fmtDate_(r[i]) : r[i]; });
      if (o['차트']) { try { o['차트'] = JSON.parse(o['차트']); } catch (err) { o['차트'] = null; } }
      out.rows.push(o);
    });
  });
  var text = JSON.stringify(out);
  cachePut_(key, text);
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

/* ───────── 도구 ───────── */
function fetchAll_(urls) {
  var out = [];
  for (var i = 0; i < urls.length; i += CFG.BATCH) {
    var reqs = urls.slice(i, i + CFG.BATCH).map(function (u) {
      return { url: u, headers: CFG.UA, muteHttpExceptions: true };
    });
    UrlFetchApp.fetchAll(reqs).forEach(function (r) {
      out.push(r.getResponseCode() === 200 ? r.getContentText() : null);
    });
  }
  return out;
}

// 시트에 쓰기: Sheets API(고급 서비스)로 지우기 1회 + 쓰기 1회, 안 되면 SpreadsheetApp 방식으로 대체. 단계별 시간을 문자열로 돌려줌
function writeRows_(name, rows) {
  var ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName(name) || ss.insertSheet(name);
  var tm = [], t, sec = function (t0) { return ((new Date() - t0) / 1000).toFixed(1); };
  var stamp = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
  var values = [HEAD].concat(rows);
  var fresh = sh.getLastRow() === 0;             // 새 탭일 때만 서식·고정행 지정(서식은 지우기로 지워지지 않음)
  if (fresh) {
    t = new Date();
    // 코드(005930)·기준일·갱신 시각이 숫자·날짜로 바뀌지 않게 텍스트로
    ['B:D', 'F:F', 'K:L', 'N:N', 'Q1:R1'].forEach(function (a) { sh.getRange(a).setNumberFormat('@'); });
    sh.setFrozenRows(1);
    tm.push('서식 ' + sec(t));
  }
  var done = false;
  try {
    var id = ss.getId(), q = "'" + name + "'";
    t = new Date();
    Sheets.Spreadsheets.Values.batchClear({ ranges: [q] }, id);
    tm.push('API지우기 ' + sec(t));
    t = new Date();
    Sheets.Spreadsheets.Values.batchUpdate({
      valueInputOption: 'RAW',                   // 코드 '005930'이 숫자로 바뀌지 않게 입력 그대로
      data: [{ range: q + '!A1', majorDimension: 'ROWS', values: values },
             { range: q + '!Q1:R1', majorDimension: 'ROWS', values: [['갱신', stamp]] }]
    }, id);
    tm.push('API쓰기 ' + sec(t));
    done = true;
  } catch (e) { tm.push('API안됨→기존방식'); }
  if (!done) {
    t = new Date(); sh.clearContents(); tm.push('지우기 ' + sec(t));
    t = new Date(); sh.getRange(1, 1, values.length, HEAD.length).setValues(values); tm.push('쓰기 ' + sec(t));
    t = new Date(); sh.getRange('Q1:R1').setValues([['갱신', stamp]]); tm.push('갱신시각 ' + sec(t));
  }
  t = new Date(); cacheClear_(); tm.push('캐시 ' + sec(t));   // 새 데이터가 들어왔으니 저장해 둔 응답을 지움
  return '(' + tm.join(', ') + ')';
}

function log_(what, msg) {
  var sh = SpreadsheetApp.getActive().getSheetByName('로그');
  if (sh) sh.appendRow([Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss'), what, msg]);
}

function num_(s) { return +String(s).replace(/[^0-9.\-]/g, '') || 0; }
function avg_(a) { var t = 0; a.forEach(function (x) { t += x; }); return t / a.length; }
function round_(x) { return x === '' || x == null ? '' : Math.round(x * 100) / 100; }
function pad_(n) { return (n < 10 ? '0' : '') + n; }
function fmtDate_(d) { return Utilities.formatDate(d, 'Asia/Seoul', 'yyyy-MM-dd HH:mm'); }
