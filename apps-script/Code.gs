/**
 * 주식 점수 — 월봉 10이평 돌파 신호 (Apps Script)
 *
 * 매수: 전달 종가 ≤ 전달 10이평  그리고  이번 달 최근 종가 > 이번 달 10이평
 * 매도: 전달 종가 ≥ 전달 10이평  그리고  이번 달 최근 종가 < 이번 달 10이평
 * 10이평 = 최근 10개월 월말 종가 평균(이번 달은 최근 종가를 그 달 종가로 씀)
 *
 * 대상: 코스피 시총 상위 300(ETF·ETN·우선주 포함) + 코스닥 상위 200 + 미국 상위 500
 * 데이터: 네이버 증권(한국), 나스닥·야후 파이낸스(미국)
 *
 * 처음 한 번: setup 실행 → 탭 만들기 + 매일 자동 갱신 예약
 */

var CFG = {
  KOSPI_N: 300,
  KOSDAQ_N: 200,
  US_N: 500,
  MONTHS: 10,          // 이동평균 개월 수
  BATCH: 40,           // 한 번에 동시에 받는 개수
  UA: { 'User-Agent': 'Mozilla/5.0' }
};

var HEAD = ['시장', '코드', '이름', '종류', '시총', '시총단위', '최근종가', '10이평',
            '전달종가', '전달10이평', '신호', '기준일', '개월수'];

/* ───────── 처음 한 번 실행 ───────── */
function setup() {
  var ss = SpreadsheetApp.getActive();
  ['한국', '미국', '로그'].forEach(function (n) {
    if (!ss.getSheetByName(n)) ss.insertSheet(n);
  });
  var s1 = ss.getSheetByName('시트1');
  if (s1 && ss.getSheets().length > 1 && s1.getLastRow() === 0) ss.deleteSheet(s1);

  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  // 한국: 장 마감(15:30) 후 네이버 종가 반영(16:30) 뒤
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
  var urls = list.map(function (s) {
    return 'https://fchart.stock.naver.com/sise.nhn?symbol=' + s.code +
           '&timeframe=month&count=' + (CFG.MONTHS + 3) + '&requestType=0';
  });
  var bodies = fetchAll_(urls);
  var rows = [], fail = 0;
  list.forEach(function (s, i) {
    var mon = parseNaverMonthly_(bodies[i]);
    if (!mon) { fail++; return; }
    rows.push(makeRow_(s, mon));
  });
  writeRows_('한국', rows);
  log_('updateKR', rows.length + '종목, 실패 ' + fail + ', ' + Math.round((Date.now() - t0) / 1000) + '초');
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
  var re = /data="(\d{8})\|[^|]*\|[^|]*\|[^|]*\|([\d.]+)\|/g, m, mon = [];
  while ((m = re.exec(xml))) {
    var d = m[1];
    mon.push({ ym: d.slice(0, 6), date: d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6), close: +m[2] });
  }
  return mon.length ? mon : null;
}

/* ───────── 미국 ───────── */
function updateUS() {
  var t0 = Date.now();
  var list = nasdaqTop_(CFG.US_N);
  var urls = list.map(function (s) {
    return 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(s.yahoo) +
           '?range=' + (CFG.MONTHS + 3) + 'mo&interval=1mo';
  });
  var bodies = fetchAll_(urls);
  var rows = [], retry = [];
  list.forEach(function (s, i) {
    var mon = parseYahooMonthly_(bodies[i]);
    if (mon) rows.push(makeRow_(s, mon)); else retry.push(s);
  });
  // 야후가 막히면 나스닥 일봉으로 대신
  var fail = 0;
  if (retry.length) {
    var from = Utilities.formatDate(new Date(Date.now() - 400 * 864e5), 'America/New_York', 'yyyy-MM-dd');
    var to = Utilities.formatDate(new Date(), 'America/New_York', 'yyyy-MM-dd');
    var b2 = fetchAll_(retry.map(function (s) {
      return 'https://api.nasdaq.com/api/quote/' + encodeURIComponent(s.code) +
             '/historical?assetclass=stocks&fromdate=' + from + '&todate=' + to + '&limit=400';
    }));
    retry.forEach(function (s, i) {
      var mon = parseNasdaqDaily_(b2[i]);
      if (mon) rows.push(makeRow_(s, mon)); else fail++;
    });
  }
  rows.sort(function (a, b) { return b[4] - a[4]; });
  writeRows_('미국', rows);
  log_('updateUS', rows.length + '종목, 나스닥 대체 ' + (retry.length - fail) + ', 실패 ' + fail + ', ' +
       Math.round((Date.now() - t0) / 1000) + '초');
}

function nasdaqTop_(n) {
  var url = 'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=' + (n + 50) +
            '&offset=0&sortcolumn=marketCap&sortorder=desc';
  var d = JSON.parse(UrlFetchApp.fetch(url, { headers: CFG.UA }).getContentText());
  var out = [];
  d.data.table.rows.forEach(function (x) {
    var cap = num_(x.marketCap);
    if (out.length < n && cap > 0) out.push({
      market: 'US', code: x.symbol, yahoo: x.symbol.replace('/', '-'), name: x.name,
      type: 'stock', cap: Math.round(cap / 1e8), capUnit: '억달러'
    });
  });
  return out;
}

function parseYahooMonthly_(txt) {
  try {
    var r = JSON.parse(txt).chart.result[0];
    // 월봉 시각은 뉴욕 자정이라 서머타임 때 gmtoffset(겨울 기준)으로 바꾸면 전날로 밀림 → 6시간 더함
    var off = (r.meta.gmtoffset || 0) + 6 * 3600, ts = r.timestamp, c = r.indicators.quote[0].close;
    var by = {}, keys = [];
    for (var i = 0; i < ts.length; i++) {
      if (c[i] == null) continue;
      var d = new Date((ts[i] + off) * 1000);
      var ym = '' + d.getUTCFullYear() + pad_(d.getUTCMonth() + 1);
      if (!by[ym]) keys.push(ym);
      by[ym] = c[i];                          // 같은 달이 두 번 오면 뒤의 값(최근 종가)
    }
    var last = new Date(((r.meta.regularMarketTime || ts[ts.length - 1]) + off) * 1000);
    var lastYm = '' + last.getUTCFullYear() + pad_(last.getUTCMonth() + 1);
    if (r.meta.regularMarketPrice && by[lastYm] != null) by[lastYm] = r.meta.regularMarketPrice;
    var lastDate = last.getUTCFullYear() + '-' + pad_(last.getUTCMonth() + 1) + '-' + pad_(last.getUTCDate());
    return keys.map(function (k) {
      return { ym: k, date: k === lastYm ? lastDate : k.slice(0, 4) + '-' + k.slice(4), close: by[k] };
    });
  } catch (e) { return null; }
}

function parseNasdaqDaily_(txt) {
  try {
    var rows = JSON.parse(txt).data.tradesTable.rows;   // 최신이 먼저
    var by = {}, keys = [];
    for (var i = rows.length - 1; i >= 0; i--) {
      var p = rows[i].date.split('/');                     // MM/DD/YYYY
      var ym = p[2] + p[0];
      if (!by[ym]) keys.push(ym);
      by[ym] = { close: num_(rows[i].close), date: p[2] + '-' + p[0] + '-' + p[1] };
    }
    return keys.map(function (k) { return { ym: k, date: by[k].date, close: by[k].close }; });
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
  return [s.market, s.code, s.name, s.type, s.cap, s.capUnit, round_(cur), round_(ma), n > 1 ? round_(prev) : '',
          round_(pma), sig, mon[n - 1].date, n];
}

/* ───────── 사이트용 ───────── */
// ?all=1 이면 모든 종목, 아니면 매수·매도 신호만
function doGet(e) {
  var all = e && e.parameter && e.parameter.all;
  var ss = SpreadsheetApp.getActive(), out = { updated: {}, rows: [] };
  ['한국', '미국'].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (!sh || sh.getLastRow() < 2) return;
    out.updated[n] = sh.getRange('O1').getValue();
    var v = sh.getRange(2, 1, sh.getLastRow() - 1, HEAD.length).getValues();
    v.forEach(function (r) {
      if (!all && r[10] !== '매수' && r[10] !== '매도') return;
      var o = {};
      HEAD.forEach(function (h, i) { o[h] = r[i] instanceof Date ? fmtDate_(r[i]) : r[i]; });
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
  sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]);
  if (rows.length) sh.getRange(2, 1, rows.length, HEAD.length).setValues(rows);
  sh.getRange('N1').setValue('갱신');
  sh.getRange('O1').setValue(Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm'));
  sh.setFrozenRows(1);
}

function log_(what, msg) {
  var sh = SpreadsheetApp.getActive().getSheetByName('로그');
  if (sh) sh.appendRow([Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss'), what, msg]);
}

function num_(s) { return +String(s).replace(/[^0-9.\-]/g, '') || 0; }
function avg_(a) { var t = 0; a.forEach(function (x) { t += x; }); return t / a.length; }
function round_(x) { return x === '' ? '' : Math.round(x * 100) / 100; }
function pad_(n) { return (n < 10 ? '0' : '') + n; }
function fmtDate_(d) { return Utilities.formatDate(d, 'Asia/Seoul', 'yyyy-MM-dd HH:mm'); }
