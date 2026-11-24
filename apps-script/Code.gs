/**
 * 주식 점수 — 월봉 10이평 돌파 신호 (Apps Script)
 *
 * 매수: 전달 종가 ≤ 전달 10이평  그리고  이번 달 최근 종가 > 이번 달 10이평
 * 매도: 전달 종가 ≥ 전달 10이평  그리고  이번 달 최근 종가 < 이번 달 10이평
 * 10이평 = 최근 10개월 월말 종가 평균(이번 달은 최근 종가를 그 달 종가로 씀)
 *
 * 대상: 코스피 시총 상위 300(ETF·ETN·우선주 포함) + 코스닥 상위 200 + 미국 상위 500
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
  BATCH: 40,           // 한 번에 동시에 받는 개수
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

/* ───────── 한국 ───────── */
function updateKR() {
  var t0 = Date.now();
  var list = naverTop_('KOSPI', CFG.KOSPI_N).concat(naverTop_('KOSDAQ', CFG.KOSDAQ_N));
  // 월봉은 야후 먼저: 15:30 정규장 종가. 네이버 가격엔 16:00~18:00 시간외 단일가가 섞임
  var bodies = fetchAll_(list.map(function (s) {
    return 'https://query1.finance.yahoo.com/v8/finance/chart/' + s.code + (s.market === 'KOSPI' ? '.KS' : '.KQ') +
           '?range=' + (CFG.CHART_N + 2) + 'mo&interval=1mo';
  }));
  var rows = [], retry = [];
  list.forEach(function (s, i) {
    var mon = parseYahooMonthly_(bodies[i]);
    if (mon && mon.length > CFG.MONTHS) rows.push(makeRow_(s, mon)); else retry.push(s);
  });
  // 야후에 없거나 막히면 네이버 월봉
  var fail = 0;
  if (retry.length) {
    var b2 = fetchAll_(retry.map(function (s) {
      return 'https://fchart.stock.naver.com/sise.nhn?symbol=' + s.code +
             '&timeframe=month&count=' + (CFG.CHART_N + 2) + '&requestType=0';
    }));
    retry.forEach(function (s, i) {
      var mon = parseNaverMonthly_(b2[i]);
      if (mon) rows.push(makeRow_(s, mon)); else fail++;
    });
  }
  rows.sort(function (a, b) { return b[4] - a[4]; });
  writeRows_('한국', rows);
  log_('updateKR', rows.length + '종목, 네이버 대체 ' + (retry.length - fail) + ', 실패 ' + fail + ', ' +
       Math.round((Date.now() - t0) / 1000) + '초');
}

function naverTop_(market, n) {
  var out = [];
  for (var page = 1; out.length < n; page++) {
    var url = 'https://m.stock.naver.com/api/stocks/marketValue/' + market +
              '?page=' + page + '&pageSize=100';
    var d = JSON.parse(UrlFetchApp.fetch(url, { headers: CFG.UA }).getContentText());
    if (!d.stocks || !d.stocks.length) break;
    d.stocks.forEach(function (x) {
      if (out.length < n) out.push({
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
  var t0 = Date.now();
  var list = naverUSTop_(CFG.US_N);
  var now = new Date(), y = now.getFullYear(), m = now.getMonth() + 1;
  var start = (y - 4) + pad_(m) + '010000', end = (y + 1) + '01010000';
  var bodies = fetchAll_(list.map(function (s) {
    return 'https://api.stock.naver.com/chart/foreign/item/' + encodeURIComponent(s.reuters) +
           '/month?startDateTime=' + start + '&endDateTime=' + end;
  }));
  var rows = [], retry = [];
  list.forEach(function (s, i) {
    var mon = parseNaverUSMonthly_(bodies[i], s.date);
    if (mon) rows.push(makeRow_(s, mon)); else retry.push(s);
  });
  var fail = 0;
  if (retry.length) {
    var b2 = fetchAll_(retry.map(function (s) {
      return 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(s.yahoo) +
             '?range=' + (CFG.CHART_N + 2) + 'mo&interval=1mo';
    }));
    retry.forEach(function (s, i) {
      var mon = parseYahooMonthly_(b2[i]);
      if (mon) rows.push(makeRow_(s, mon)); else fail++;
    });
  }
  rows.sort(function (a, b) { return b[4] - a[4]; });
  writeRows_('미국', rows);
  log_('updateUS', rows.length + '종목, 야후 대체 ' + (retry.length - fail) + ', 실패 ' + fail + ', ' +
       Math.round((Date.now() - t0) / 1000) + '초');
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
  var W = getWeights_();
  if (!W || mon.length < 25) return '';
  var n = mon.length, c = mon.map(function (x) { return x.close; });
  var ma = c.map(function (x, i) { return i >= 9 ? avg_(c.slice(i - 9, i + 1)) : null; });
  var above = c.map(function (x, i) { return ma[i] == null ? null : x > ma[i]; });
  var i = n - 1;
  var v = mon.map(function (x) { return x.vol || 0; });
  var vAvg = avg_(v.slice(i - 12, i)) || 1;
  var v3 = avg_(v.slice(i - 2, i + 1)), v12 = avg_(v.slice(i - 14, i - 3)) || 1;
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
  // 표준화 + 가중 합 → 점수
  var raw = W.b;
  W.feats.forEach(function (f) {
    var v = feats[f.f];
    if (v == null || isNaN(v)) v = f.m;
    var cl = Math.min(f.hi, Math.max(f.lo, v));
    raw += ((cl - f.m) / f.sd) * f.w;
  });
  // raw → 0~100 (pct 배열로 백분위 변환)
  var pct = W.pct;
  if (!pct || !pct.length) return '';
  var lo = 0, hi = pct.length - 1;
  while (lo < hi) { var mid = (lo + hi) >> 1; if (pct[mid] < raw) lo = mid + 1; else hi = mid; }
  return Math.round(lo / (pct.length - 1) * 100);
}

/* ───────── 신호 계산 ───────── */
function makeRow_(s, mon) {
  var n = mon.length, M = CFG.MONTHS, c = mon.map(function (x) { return x.close; });
  var cur = c[n - 1], prev = c[n - 2];
  var ma = n >= M ? avg_(c.slice(n - M)) : '';
  var pma = n >= M + 1 ? avg_(c.slice(n - M - 1, n - 1)) : '';
  var sig = '';
  if (ma !== '' && pma !== '') {
    if (prev <= pma && cur > ma) sig = '매수';
    else if (prev >= pma && cur < ma) sig = '매도';
    else sig = cur > ma ? '위' : '아래';
  }
  // 매수·매도 종목만 차트용 월봉 저장: [[YYYYMM, 시가, 고가, 저가, 종가, 거래량], ...]
  var chart = '';
  if (sig === '매수' || sig === '매도') {
    chart = JSON.stringify(mon.slice(-CFG.CHART_N).map(function (x) {
      return [+x.ym, round_(x.open), round_(x.high), round_(x.low), round_(x.close), Math.round(x.vol || 0)];
    }));
  }
  // 매수 신호 종목만 점수 계산
  var scoreVal = sig === '매수' ? scoreMonthly_(mon, s) : '';
  return [s.market, s.code, s.name, s.type, s.cap, s.capUnit, round_(cur), round_(ma), n > 1 ? round_(prev) : '',
          round_(pma), sig, mon[n - 1].date, n, chart, scoreVal];
}

/* ───────── 사이트용 ───────── */
// ?all=1 이면 모든 종목, 아니면 매수·매도 신호만
function doGet(e) {
  var all = e && e.parameter && e.parameter.all;
  var ss = SpreadsheetApp.getActive(), out = { updated: {}, rows: [] };
  ['한국', '미국'].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (!sh || sh.getLastRow() < 2) return;
    out.updated[n] = sh.getRange('R1').getValue();
    var v = sh.getRange(2, 1, sh.getLastRow() - 1, HEAD.length).getValues();
    v.forEach(function (r) {
      if (!all && r[10] !== '매수' && r[10] !== '매도') return;
      var o = {};
      HEAD.forEach(function (h, i) { o[h] = r[i] instanceof Date ? fmtDate_(r[i]) : r[i]; });
      if (o['차트']) { try { o['차트'] = JSON.parse(o['차트']); } catch (err) { o['차트'] = null; } }
      out.rows.push(o);
    });
  });
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
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

function writeRows_(name, rows) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name) || SpreadsheetApp.getActive().insertSheet(name);
  sh.clearContents();
  // 코드(005930)·기준일·갱신 시각이 숫자·날짜로 바뀌지 않게 텍스트로
  ['B:D', 'F:F', 'K:L', 'N:N', 'Q1:R1'].forEach(function (a) { sh.getRange(a).setNumberFormat('@'); });
  sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]);
  if (rows.length) sh.getRange(2, 1, rows.length, HEAD.length).setValues(rows);
  sh.getRange('Q1').setValue('갱신');
  sh.getRange('R1').setValue(Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm'));
  sh.setFrozenRows(1);
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
