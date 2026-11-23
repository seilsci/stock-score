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
            '전달종가', '전달10이평', '신호', '기준일', '개월수', '차트'];

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
  return [s.market, s.code, s.name, s.type, s.cap, s.capUnit, round_(cur), round_(ma), n > 1 ? round_(prev) : '',
          round_(pma), sig, mon[n - 1].date, n, chart];
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
