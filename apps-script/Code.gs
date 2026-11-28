/**
 * 주식 점수 — 월봉 10이평 돌파 신호 (Apps Script)
 *
 * 매수: 전달 종가 ≤ 전달 10이평  그리고  이번 달 최근 종가 > 이번 달 10이평
 * 유예: 이번 달 처음 판매 기준 이평 아래로 내려옴(하향 돌파 1개월째). 다음 달에도 아래면 매도. 판매 기준 이평 = 미국 10이평 · 한국 6이평(2026-11-27 변경, 매수 돌파와 익절 2배 기준은 10이평 그대로)
 * 매도: 하향 돌파 후 2개월째까지 계속 판매 기준 이평 아래(전전달 위 → 전달·이번 달 아래).
 *       단, 미국 국채 10년 금리가 6개월 전 달말보다 올라 있으면(FRED DGS10) 유예 없이 하향 돌파 즉시 매도
 * 수급: 확인 매수 후보 중 한국 종목은 확인 달 외국인·기관 순매수가 같은 방향(둘 다 매수 또는 둘 다 매도)이면 후보에서 뺌(네이버 일별 투자자 매매, flowCheck_)
 * 10이평 = 최근 10개월 월말 종가 평균(이번 달은 최근 종가를 그 달 종가로 씀)
 *
 * 대상: 코스피 시총 상위 300(ETF·ETN·우선주 포함, 채권·금리·레버리지·인버스형은 제외) + 코스닥 상위 200 + 미국 상위 500 (오늘 시총 순 = 구매 시점의 시총 기준)
 *   (선택) CFG.LIQ_N > 0이면 후보를 넓게 받아 그 달 거래대금 상위만 인정하는 방식도 코드에 남아 있음(거래대금 = 직전 12개월 평균 거래량 × 최근 종가, tools/learn/3_build.js와 같은 정의)
 * 데이터: 한국 = 네이버 시총 순위(후보) + 야후 월봉(15:30 종가, 없으면 네이버)
 *         미국 = 네이버 시총 순위(후보)·월봉(막히면 야후)
 *
 * 처음 한 번: setup 실행 → 탭 만들기 + 매일 자동 갱신 예약
 */

var CFG = {
  KOSPI_N: 300,        // 종목 수(시총 순). 거래대금 상위로 거르려면 LIQ_N을 500 등으로 하고 후보를 넓게(KOSPI_N 1000·KOSDAQ_N 900·US_N 1500 정도)
  KOSDAQ_N: 200,
  US_N: 500,
  LIQ_N: 0,            // 0이면 시총 순 그대로(기본). 양수면 그 달 거래대금 상위 LIQ_N개(한국 전체·미국 각각)만 인정
  MONTHS: 10,          // 이동평균 개월 수
  CHART_N: 45,         // 차트용으로 저장하는 개월 수(화면 36개월 + 10이평 계산용 9개월)
  BATCH: 40,           // 한 번에 동시에 받는 개수(100으로 올렸더니 야후 31.6→37.0초, 네이버 31.8→47.5초로 오히려 느려져 40으로 되돌림)
  UA: { 'User-Agent': 'Mozilla/5.0' }
};

var HEAD = ['시장', '코드', '이름', '종류', '시총', '시총단위', '최근종가', '10이평',
            '전달종가', '전달10이평', '신호', '기준일', '개월수', '차트', '점수', '확인', '익절', '판매이평', '배당률'];   // 배당률(%): 네이버 종목 정보의 배당수익률(없으면 빈칸). 갱신 시각은 U1:V1(S열이 배당률이라 한 칸 더 띄움)

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
  var list = naverTop_('KOSPI', CFG.KOSPI_N).concat(naverTop_('KOSDAQ', CFG.KOSDAQ_N));    // 후보(시총 순)
  T.lap('목록', t);
  // 월봉은 야후 먼저: 15:30 정규장 종가. 네이버 가격엔 16:00~18:00 시간외 단일가가 섞임
  t = new Date();
  var bodies = fetchAll_(list.map(function (s) {
    return 'https://query1.finance.yahoo.com/v8/finance/chart/' + s.code + (s.market === 'KOSPI' ? '.KS' : '.KQ') +
           '?range=' + (CFG.CHART_N + 2) + 'mo&interval=1mo';
  }));
  T.lap('야후받기', t);
  t = new Date();
  var mons = [], retry = [];
  list.forEach(function (s, i) {
    var mon = parseYahooMonthly_(bodies[i]);
    if (mon && mon.length > CFG.MONTHS) mons[i] = mon; else retry.push(i);
  });
  // 야후에 없거나 막히면 네이버 월봉
  var fail = 0;
  if (retry.length) {
    var b2 = fetchAll_(retry.map(function (i) {
      return 'https://fchart.stock.naver.com/sise.nhn?symbol=' + list[i].code +
             '&timeframe=month&count=' + (CFG.CHART_N + 2) + '&requestType=0';
    }));
    retry.forEach(function (i, k) { var mon = parseNaverMonthly_(b2[k]); if (mon) mons[i] = mon; else fail++; });
    T.lap('네이버대체(' + retry.length + '개)', t);
    t = new Date();
  }
  var liq = CFG.LIQ_N ? buildLiq_(mons, CFG.LIQ_N) : null;               // LIQ_N > 0일 때만: 매달 거래대금 상위 LIQ_N의 문턱(한국 전체 한 묶음)
  var rows = [];
  list.forEach(function (s, i) { if (mons[i]) { var r = makeRow_(s, mons[i], liq); if (r) { r._s = s; rows.push(r); } } });
  T.lap('계산·점수', t);
  t = new Date();
  T.note(addDiv_(rows)); T.lap('배당률', t);
  t = new Date();
  var fl = flowCheck_(rows);                                              // 수급 규칙: 확인 후보 중 외국인·기관 같은 방향인 종목은 후보에서 뺌
  T.lap('수급확인', t); T.note(fl);
  rows.sort(function (a, b) { return b[4] - a[4]; });
  t = new Date();
  var wd = writeRows_('한국', rows);
  T.lap('시트쓰기', t); T.note(wd);
  log_('updateKR', '후보 ' + list.length + ' → ' + rows.length + '종목, 네이버 대체 ' + (retry.length - fail) + ', 실패 ' + fail + ', ' +
       Math.round((Date.now() - t0) / 1000) + '초 ' + T.text());
}

// 제외 종목: 채권·금리(CD·KOFR)·머니마켓·단기채 등 가격이 거의 안 움직이는 상품, 레버리지·인버스(음의 복리)
// tools/learn/1_lists.js의 EXCLUDE와 같은 규칙으로 유지할 것
var EXCLUDE_RE = /채권|국채|국고채|회사채|특수은행채|금융채|국공채|통안채|크레딧|하이일드|단기자금|금리|머니마켓|레버리지|인버스|곱버스|\b[23]X\b|1\.5X/;

// 미국: 채권·지방채·우선주 중심의 폐쇄형 펀드(가격이 거의 안 움직이는 채권형). tools/learn/1_lists.js의 EXCLUDE_US와 같게 유지
var EXCLUDE_US_RE = /Muni|Municipal|Bond Trust|(Fund|Fd|Closed).*(High Yield|High Income|Floating Rate|Credit|Loan|Treasury|Mortgage|Duration|Preferred|Income Solutions|Dynamic Income|Corporate & Income|Multi-Sector|Core Bond)|(High Yield|High Income|Floating Rate|Credit|Loan|Treasury|Preferred|Income Solutions|Dynamic Income|Corporate & Income|Multi-Sector|Core Bond).*(Fund|Fd|Closed)/i;

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
  var list = naverUSTop_(CFG.US_N);                                      // 후보(시총 순)
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
  var mons = [], retry = [];
  list.forEach(function (s, i) {
    var mon = parseNaverUSMonthly_(bodies[i], s.date);
    if (mon) mons[i] = mon; else retry.push(i);
  });
  var fail = 0;
  if (retry.length) {
    var b2 = fetchAll_(retry.map(function (i) {
      return 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(list[i].yahoo) +
             '?range=' + (CFG.CHART_N + 2) + 'mo&interval=1mo';
    }));
    retry.forEach(function (i, k) { var mon = parseYahooMonthly_(b2[k]); if (mon) mons[i] = mon; else fail++; });
    T.lap('야후대체(' + retry.length + '개)', t);
    t = new Date();
  }
  var liq = CFG.LIQ_N ? buildLiq_(mons, CFG.LIQ_N) : null;               // LIQ_N > 0일 때만: 매달 거래대금 상위 LIQ_N의 문턱(미국 한 묶음)
  var rows = [];
  list.forEach(function (s, i) { if (mons[i]) { var r = makeRow_(s, mons[i], liq); if (r) { r._s = s; rows.push(r); } } });
  T.lap('계산·점수', t);
  t = new Date();
  T.note(addDiv_(rows)); T.lap('배당률', t);
  rows.sort(function (a, b) { return b[4] - a[4]; });
  t = new Date();
  var wd = writeRows_('미국', rows);
  T.lap('시트쓰기', t); T.note(wd);
  log_('updateUS', '후보 ' + list.length + ' → ' + rows.length + '종목, 야후 대체 ' + (retry.length - fail) + ', 실패 ' + fail + ', ' +
       Math.round((Date.now() - t0) / 1000) + '초 ' + T.text());
}

// 미국 ETF(네이버 미국 종목 목록에는 ETF가 없어 목록을 직접 둠). 채권형·레버리지·인버스·변동성 제외, 순자산(천 달러)은 만든 날짜 기준 — tools/learn/1b_us_etf.js --gs 로 갱신해서 붙여넣기
// [야후 심볼, 네이버(로이터) 코드, 이름, 순자산(천 달러)]
var US_ETF = [["VOO","VOO","Vanguard S&P 500 ETF",1050677127],["IVV","IVV","iShares Core S&P 500 ETF",847284035],["SPY","SPY","State Street SPDR S&P 500 ETF Trust",775356447],["VTI","VTI","Vanguard Morningstar Total Stock Mkt ETF",673255571],["QQQ","QQQ.O","Invesco QQQ Trust  Series 1",455660451],["VEA","VEA","Vanguard FTSE Developed Markets ETF",222660828],["VUG","VUG","Vanguard Morningstar Growth ETF",212526664],["VTV","VTV","Vanguard Morningstar Value ETF",192446871],["IEFA","IEFA.K","iShares Core MSCI EAFE ETF",185122080],["VXUS","VXUS.O","Vanguard Total International Stock ETF",157781127],["IEMG","IEMG.K","iShares Core MSCI Emerging Markets ETF",139328112],["VGT","VGT","Vanguard Information Technology ETF",131469493],["SCHD","SCHD.K","Schwab US Dividend Equity ETF",123880127],["IJH","IJH","iShares Core S&P Mid-Cap ETF",121452638],["GLD","GLD","SPDR Gold Shares",120584640],["VIG","VIG","Vanguard Dividend Appreciation ETF",115488554],["VWO","VWO","Vanguard FTSE Emerging Markets ETF",114928175],["IWF","IWF","iShares Russell 1000 Growth",112922696],["XLK","XLK","State Street Technology Select Sector SPDR ETF",108583589],["QQQM","QQQM.O","Invesco NASDAQ 100 ETF",105936041],["VO","VO","Vanguard Morningstar Mid-Cap ETF",105831373],["IJR","IJR","iShares Core S&P Small-Cap ETF",104117967],["RSP","RSP","Invesco S&P 500 Equal Weight ETF",103634994],["ITOT","ITOT.K","iShares Core S&P Total US Stock Market ETF",93674651],["IWD","IWD","iShares Russell 1000 Value ETF",83656428],["VT","VT","Vanguard Total World Stock ETF",82169458],["VYM","VYM","Vanguard High Dividend Yield ETF",81782602],["VB","VB","Vanguard Morningstar Small-Cap ETF",78141032],["IWM","IWM","iShares Russell 2000 ETF",76127310],["EFA","EFA","iShares MSCI EAFE ETF",75209064],["SCHX","SCHX.K","Schwab US Large-Cap ETF",71782380],["IVW","IVW","iShares S&P 500 Growth ETF",69900320],["SCHF","SCHF.K","Schwab International Equity ETF",65698906],["SMH","SMH.O","VanEck Semiconductor ETF",58590413],["SCHG","SCHG.K","Schwab US Large-Cap Growth ETF",57887433],["IWR","IWR","iShares Russell Mid-Cap ETF",57865640],["IXUS","IXUS.O","iShares Core MSCI Total International Stock ETF",55874610],["XLF","XLF","State Street Financial Sel Sec SPDR ETF",53953063],["IAU","IAU","iShares Gold Trust",53879294],["VV","VV","Vanguard Morningstar Large-Cap ETF",52001176],["SPYG","SPYG.K","State Street SPDR Portfolio S&P 500 Growth ETF",50377970],["IVE","IVE","iShares S&P 500 Value ETF",50279341],["DFAC","DFAC.K","DFA US Core Equity 2 ETF",48125170],["XLV","XLV","State Street Health Care Select Sector SPDR ETF",47784303],["IWB","IWB","iShares Russell 1000 ETF",47286240],["QUAL","QUAL.K","iShares MSCI USA Quality Factor ETF",47202078],["JEPI","JEPI.K","JPMorgan Equity Premium Income ETF",46074688],["DGRO","DGRO.K","iShares Core Dividend Growth ETF",45155063],["DIA","DIA","State Street SPDR Dow Jones Indust Avg ETF Trust",44766699],["IBIT","IBIT.O","iShares Bitcoin Trust ETF",44520482],["SCHB","SCHB.K","Schwab US Broad Market ETF",43088760],["VONG","VONG.O","Vanguard Russell 1000 Growth ETF",42780940],["JEPQ","JEPQ.O","JPMorgan Nasdaq Equity Premium Income ETF",40726855],["SPDW","SPDW.K","State Street SPDR Portfolio Devt World ex-US ETF",40543172],["VNQ","VNQ","Vanguard Real Estate ETF",39034843],["XLE","XLE","State Street Energy Select Sector SPDR ETF",38719411],["SPYV","SPYV.K","State Street SPDR Portfolio S&P 500 Value ETF",38503347],["VBR","VBR","Vanguard Morningstar Small-Cap Value ETF",37222466],["SOXX","SOXX.O","iShares Semiconductor ETF",34281699],["IDEV","IDEV.K","iShares Core MSCI International Developed Mkt ETF",33390990],["ACWI","ACWI.O","iShares MSCI ACWI ETF",32374700],["AVUV","AVUV.K","Avantis US Small Cap Value ETF",32217130],["MGK","MGK","Vanguard Morningstar Mega Cap Growth ETF",31280239],["IUSG","IUSG.O","iShares Core S&P US Growth ETF",31163688],["XLI","XLI","State Street Industrial Select Sector SPDR ETF",30260395],["EFV","EFV","iShares MSCI EAFE Value ETF",30069400],["VXF","VXF","Vanguard Extended Market ETF",29737569],["VGK","VGK","Vanguard FTSE Europe ETF",29211109],["IUSV","IUSV.O","iShares Core S&P US Value ETF",28628307],["GLDM","GLDM.K","SPDR Gold MiniShares Trust",27900664],["EEM","EEM","iShares MSCI Emerging Markets ETF",26981640],["MDY","MDY","State Street SPDR S&P MidCap 400 ETF Trust",25115605],["GDX","GDX","VanEck Gold Miners ETF",24696440],["VOE","VOE","Vanguard Morningstar Mid-Cap Value ETF",24367100],["USMV","USMV.K","iShares MSCI USA Min Vol Factor ETF",24107154],["VONV","VONV.O","Vanguard Russell 1000 Value ETF",23737049],["DVY","DVY.O","iShares Select Dividend ETF",23581185],["XLU","XLU","State Street Utilities Select Sector SPDR ETF",23362679],["EWJ","EWJ","iShares MSCI Japan ETF",23060223],["AVLV","AVLV.K","Avantis US Large Cap Value ETF",23044984],["XLY","XLY","State Street Consumer Disc Sel Sect SPDR ETF",22993031],["SDY","SDY","State Street SPDR S&P Dividend ETF",22774156],["XLC","XLC","State Street Com Svc Sel Sec SPDR ETF",22178498],["SLV","SLV","iShares Silver Trust",21953680],["IYW","IYW","iShares US Technology ETF",21772473],["VBK","VBK","Vanguard Morningstar Small-Cap Growth ETF",21771688],["SCHA","SCHA.K","Schwab US Small-Cap ETF",21666125],["VYMI","VYMI.O","Vanguard Internatl High Div Yield ETF",21478535],["VTIP","VTIP.O","Vanguard Sht-Term Inflation-Protected Sec ETF",21402599],["VHT","VHT","Vanguard Health Care ETF",21099552],["DFUS","DFUS.K","DFA Dimensional US Equity Market ETF",20874701],["IWV","IWV","iShares Russell 3000 ETF",20153934],["EWY","EWY","Ishares Msci South Korea ETF",19821974],["SPMO","SPMO.K","Invesco S&P 500 Momentum ETF",19479160],["OEF","OEF","iShares S&P 100 ETF",19209911],["COWZ","COWZ.K","Pacer US Cash Cows 100 ETF",19180145],["AVDV","AVDV.K","Avantis International Small Cap Value ETF",19097010],["FTEC","FTEC.K","Fidelity MSCI Information Technology Index ETF",18845872],["SPHQ","SPHQ.K","Invesco S&P 500 Quality ETF",18638071],["SPMD","SPMD.K","State Street SPDR Portfolio S&P 400 Mid Cap ETF",18586062],["BBJP","BBJP.K","JPMorgan BetaBuilders Japan ETF",18507711],["VOT","VOT","Vanguard Morningstar Mid-Cap Growth ETF",18384349],["DFAI","DFAI.K","DFA Dimensional International Core Equity Market",17879667],["CIBR","CIBR.O","First Trust NASDAQ Cybersecurity ETF",17828425],["IWP","IWP","iShares Russell Mid-Cap Growth ETF",17606367],["HDV","HDV","iShares Core High Dividend ETF",16669692],["DGRW","DGRW.O","WisdomTree US Quality Dividend Growth Fund",16339635],["VTWO","VTWO.O","Vanguard Russell 2000 ETF",16286033],["XLP","XLP","State Street Consumer Staples Sel Sect SPDR ETF",16026393],["SPEM","SPEM.K","State Street SPDR Portfolio Emerging Markets ETF",15887523],["SPSM","SPSM.K","State Street SPDR Portfolio S&P 600 Small Cap ETF",15831703],["MTUM","MTUM.K","iShares MSCI USA Momentum Factor ETF",15569297],["DFIV","DFIV.K","Dimensional International Value ETF",15534637],["SCHV","SCHV.K","Schwab US Large-Cap Value ETF",15489180],["DFAS","DFAS.K","DFA US Small Cap ETF",15291606],["SCHM","SCHM.K","Schwab US Mid-Cap ETF",14816099],["IWS","IWS","iShares Russell Mid-Cap Value ETF",14812664],["QQQI","QQQI.O","NEOS Nasdaq-100 High Income ETF",14540072],["AVUS","AVUS.K","Avantis US Equity ETF",14353917],["DFAT","DFAT.K","DFA US Targeted Value ETF",14215355],["MGV","MGV","Vanguard Morningstar Mega Cap Value ETF",14060727],["IWY","IWY","iShares Russell Top 200 Growth Index ETF",13897037],["IWO","IWO","iShares Russell 2000 Growth ETF",13739773],["SPTM","SPTM.K","State Street SPDR Prft S&P 1500 Comp Stk Mkt ETF",13718382],["IWN","IWN","iShares Russell 2000 Value ETF",13712425],["EFG","EFG","iShares MSCI EAFE Growth ETF",13607580],["VFH","VFH","Vanguard Financials ETF",13360118],["IQLT","IQLT.K","iShares MSCI Intl Quality Factor ETF",13354590],["PAVE","PAVE.K","Global X US Infrastructure Development ETF",13096966],["SPYI","SPYI.K","NEOS S&P 500 High Income ETF",12541975],["SCHH","SCHH.K","Schwab US REIT ETF",12512720],["SCZ","SCZ.O","iShares MSCI EAFE Small Cap ETF",12488456],["NOBL","NOBL.K","ProShares S&P 500 Dividend Aristocrats ETF",12342247],["AMLP","AMLP.K","Alerian MLP ETF",11839947],["IGV","IGV","iShares Expanded Tech-Software Sector ETF",11820636],["SCHE","SCHE.K","Schwab Emerging Markets Equity ETF",11788616],["IBB","IBB.O","iShares Biotechnology ETF",11682720],["ITA","ITA","iShares US Aerospace & Defense ETF",11616436],["BBCA","BBCA.K","JPMorgan BetaBuilders Canada ETF",11533721],["XLG","XLG","Invesco S&P 500 Top 50 ETF",11046255],["IGF","IGF.O","iShares Global Infrastructure ETF",10929600],["VSS","VSS","Vanguard FTSE All-World ex-US Small-Cap ETF",10628137],["XBI","XBI","State Street SPDR S&P Biotech ETF",10516475],["DFAX","DFAX.K","Dimensional World ex U S Core Equity 2 ETF",10353511],["IEUR","IEUR.K","iShares Core MSCI Europe ETF",10316544],["IJK","IJK","iShares S&P Mid-Cap 400 Growth ETF",10234718],["VDE","VDE","Vanguard Energy ETF",10227752],["FBTC","FBTC.K","Fidelity Wise Origin Bitcoin Fund",10128481],["GRID","GRID.O","First Trust NASDAQ Cln Edge Smart Grid Infra Ix Fd",10087123],["JQUA","JQUA.K","Jpmorgan US Quality Factor ETF",9991640],["IGM","IGM","iShares Expanded Tech Sector ETF",9682751],["EWZ","EWZ","Ishares Msci Brazil ETF",9086472],["DFAE","DFAE.K","DFA Dimensional Emerging Core Equity Market ETF",9075474],["AIQ","AIQ.O","Global X Artificial Intelligence & Technology ETF",9063213],["EZU","EZU","iShares MSCI Eurozone ETF",8860698],["BBEU","BBEU.K","JPMorgan BetaBuilders Europe ETF",8847042],["IJJ","IJJ","iShares S&P Mid-Cap 400 Value ETF",8673462],["VLUE","VLUE.K","iShares MSCI USA Value Factor ETF",8627948],["VDC","VDC","Vanguard Consumer Staples ETF",8542176],["XLRE","XLRE.K","State Street Real Estate Select Sector SPDR ETF",8346874],["EWT","EWT","Ishares Msci Taiwan ETF",8209543],["VPU","VPU","Vanguard Utilities ETF",8154115],["XLB","XLB","State Street Materials Select Sector SPDR ETF",8067472],["VPL","VPL","Vanguard FTSE Pacific ETF",7958301],["IJS","IJS","iShares S&P Small-Cap 600 Value ETF",7900419],["IXN","IXN","iShares Global Tech ETF",7842874],["SPYD","SPYD.K","State Street SPDR Portfolio S&P 500 High Dvd ETF",7783149],["DIVO","DIVO.K","Amplify CWP Enhanced Dividend Income ETF",7775898],["VIS","VIS","Vanguard Industrials ETF",7661269],["SPLV","SPLV.K","Invesco S&P 500 Low Volatility ETF",7650864],["EWC","EWC","iShares MSCI Canada ETF",7590978],["QYLD","QYLD.O","Global X NASDAQ 100 Covered Call ETF",7532688],["INDA","INDA.K","iShares MSCI India ETF",7419462],["IJT","IJT.O","iShares S&P Small-Cap 600 Growth ETF",7289847],["GBTC","GBTC.K","Grayscale Bitcoin Trust ETF",7247574],["PPA","PPA","Invesco Aerospace & Defense ETF",7226320],["PDBC","PDBC.O","Invesco Optimum Yld Dvsfd Cmd Str No K-1 ETF",7014962],["GDXJ","GDXJ.K","VanEck Junior Gold Miners ETF",7006008],["DXJ","DXJ","WisdomTree Japan Hedged Equity Fund",6893955],["GUNR","GUNR.K","Northern Trust Morningstar Glbl Upstm Ntrl Res ETF",6609532],["BBAX","BBAX.K","JPMorgan BetaBuilders Dev Asia Pacific ex-Japan",6481929],["SGOL","SGOL.K","abrdn Physical Gold Shares ETF",6199206],["VCR","VCR","Vanguard Consumer Discretionary ETF",6158311],["VOX","VOX","Vanguard Communication Services ETF",5721177],["ARKK","ARKK.K","ARK Innovation ETF",5664250],["EFAV","EFAV.K","iShares MSCI EAFE Min Vol Factor ETF",5602328],["MCHI","MCHI.O","iShares MSCI China ETF",5422305],["GNR","GNR","State Street SPDR S&P Global Nat Resources ETF",4980273],["XAR","XAR","State Street SPDR S&P Aerospace & Defense ETF",4835159],["FDN","FDN","First Trust Dow Jones Internet Index Fund",4827653],["VTHR","VTHR.O","Vanguard Russell 3000 ETF",4714302],["IXJ","IXJ","iShares Global Healthcare ETF",4703951],["COPX","COPX.K","Global X Copper Miners ETF",4615797],["IYH","IYH","iShares US Healthcare ETF",4582704],["KWEB","KWEB.K","KraneShares CSI China Internet ETF",4375569],["ETHA","ETHA.O","iShares Ethereum Trust ETF",4241705],["EMLP","EMLP.K","First Trust North American Energy Infrastructure",4157861],["KRE","KRE","State Street SPDR S&P Regional Banking ETF",4136762],["VIOO","VIOO.K","Vanguard S&P Small-Cap 600 ETF",4107206],["IYR","IYR","iShares US Real Estate ETF",4092205],["URA","URA","Global X Uranium ETF",4075389],["FHLC","FHLC.K","Fidelity MSCI Health Care Index ETF",4062720],["IFRA","IFRA.K","iShares US Infrastructure ETF",3993648],["FEZ","FEZ","State Street SPDR EURO STOXX 50 ETF",3941321],["IHI","IHI","iShares US Medical Devices ETF",3885761],["CALF","CALF.K","Pacer US Small Cap Cash Cows ETF",3849473],["IVOO","IVOO.K","Vanguard S&P Mid-Cap 400 ETF",3833284],["IYF","IYF","iShares US Financials ETF",3795552],["QTEC","QTEC.O","First Trust NASDAQ-100-Technology Sector Index Fd",3737491],["XOP","XOP","State Street SPDR S&P Oil & Gas Expl & Prod ETF",3677902],["FXI","FXI","iShares China Large-Cap ETF",3656457],["HACK","HACK.K","Amplify Cybersecurity ETF",3651800],["INTF","INTF.K","iShares International Equity Factor ETF",3651648],["EWU","EWU","iShares MSCI United Kingdom ETF",3625416],["LRGF","LRGF.K","iShares US Equity Factor ETF",3624957],["SPHD","SPHD.K","Invesco S&P 500 High Div Low Volatility ETF",3603568],["MLPX","MLPX.K","Global X MLP & Energy Infrastructure ETF",3568557],["SIL","SIL","Global X Silver Miners ETF",3490496],["AAXJ","AAXJ.O","iShares MSCI All Country Asia ex Japan ETF",3406800],["ILF","ILF","iShares Latin America 40 ETF",3243100],["XYLD","XYLD.K","Global X S&P 500 Covered Call ETF",3187943],["EWL","EWL","Ishares Msci Switzerland ETF",3153478],["XME","XME","State Street SPDR S&P Metals & Mining ETF",3141770],["SKYY","SKYY.O","First Trust Cloud Computing ETF",3140280],["FBT","FBT","First Trust NYSE Arca Biotechnology Index Fund",3075367],["SIVR","SIVR.K","abrdn Physical Silver Shares ETF",3069963],["NFRA","NFRA.K","Northern Trust STOXX Global Broad Infrastrct ETF",3053464],["VAW","VAW","Vanguard Materials ETF",2898264],["BOTZ","BOTZ.O","Global X Robotics and Artificial Intelligence ETF",2750634],["SILJ","SILJ.K","Amplify Junior Silver Miners ETF",2628441],["NLR","NLR","VanEck Uranium and Nuclear ETF",2550316],["BUG","BUG.O","Global X Cybersecurity ETF",2433443],["OUNZ","OUNZ.K","VanEck Merk Gold ETF",2381699],["IXC","IXC","iShares Global Energy ETF",2329164],["FNCL","FNCL.K","Fidelity MSCI Financials Index ETF",2295991],["AAAU","AAAU.K","Goldman Sachs Physical Gold ETF",2284756],["FIDU","FIDU.K","Fidelity MSCI Industrials Index ETF",2261108],["ITB","ITB","iShares US Home Construction ETF",2255524],["XSD","XSD","State Street SPDR S&P Semiconductor ETF",2225495],["IYG","IYG","iShares US Financial Services ETF",2216025],["PHO","PHO.O","Invesco Water Resources ETF",2164725],["BITB","BITB.K","Bitwise Bitcoin ETF",2131656],["EWG","EWG","iShares MSCI Germany ETF",2115144],["DFEV","DFEV.K","DFA Dimensional Emerging Markets Value ETF",2113842],["IWL","IWL","iShares Russell Top 200 ETF",2111593],["QDF","QDF","Northern Trust Quality Dividend ETF",2098001],["FENY","FENY.K","Fidelity MSCI Energy Index ETF",2078952],["EWP","EWP","Ishares Msci Spain ETF",2067843],["RING","RING.O","iShares MSCI Global Gold Miners ETF",2065462],["FUTY","FUTY.K","Fidelity MSCI Utilities Index ETF",2050048],["IYT","IYT","iShares US Transportation ETF",2010580],["USO","USO","United States Oil Fund LP",1959586],["FIW","FIW","First Trust Water ETF",1923950],["EPI","EPI","WisdomTree India Earnings Fund",1918176],["IYJ","IYJ","iShares US Industrials ETF",1837438],["ICLN","ICLN.O","iShares Global Clean Energy ETF",1817200],["HEDJ","HEDJ.K","WisdomTree Europe Hedged Equity Fund",1749982],["FDIS","FDIS.K","Fidelity MSCI Consumer Discretionary Index ETF",1704878],["ROBO","ROBO.K","ROBO Global Robotics and Automation Index ETF",1696943],["IYE","IYE","iShares US Energy ETF",1667416],["FSTA","FSTA.K","Fidelity MSCI Consumer Staples Index ETF",1641590],["ARKG","ARKG.K","ARK Genomic Revolution ETF",1629810],["CQQQ","CQQQ.K","Invesco China Technology ETF",1623458],["DBC","DBC","Invesco DB Commodity Index Tracking Fund",1616386],["ARKB","ARKB.K","ARK 21Shares Bitcoin ETF",1606742],["OIH","OIH","VanEck Oil Services ETF",1603318],["ARKW","ARKW.K","ARK Next Generation Technology ETF",1597596],["XHB","XHB","State Street SPDR S&P Homebuilders ETF",1588706],["FCOM","FCOM.K","Fidelity MSCI Communication Services Index ETF",1547675],["IEV","IEV","iShares Europe ETF",1545838],["URNM","URNM.K","Sprott Uranium Miners ETF",1536083],["ARKQ","ARKQ.K","ARK Autonomous Technology & Robotics ETF",1531836],["EWW","EWW","iShares MSCI Mexico ETF",1519456],["DGS","DGS","WisdomTree Emerging Markets SmallCap Dividend Fund",1502943],["PPLT","PPLT.K","abrdn Physical Platinum Shares ETF",1498046],["IYC","IYC","iShares US Consumer Discretionary ETF",1477700],["EWD","EWD","Ishares Msci Sweden Etf",1436441],["FREL","FREL.K","Fidelity MSCI Real Estate Index ETF",1422036],["IYK","IYK","iShares US Consumer Staples ETF",1413320],["KBE","KBE","State Street SPDR S&P Bank ETF",1401306],["IHF","IHF","iShares US Healthcare Providers ETF",1401192],["VTWG","VTWG.O","Vanguard Russell 2000 Growth ETF",1393058],["EWH","EWH","iShares MSCI Hong Kong ETF",1335111],["ASHR","ASHR.K","Xtrackers Hvst CSI 300 China A Shs ETF Class A",1274588],["EPOL","EPOL.K","Ishares Msci Poland ETF",1271930],["VTWV","VTWV.O","Vanguard Russell 2000 Value ETF",1244644],["RYLD","RYLD.K","Global X Russell 2000 Covered Call ETF",1228214],["EWA","EWA","iShares MSCI Australia ETF",1221144],["REMX","REMX.K","VanEck Rare Earth and Strategic Metals ETF",1197952],["BAR","BAR","GraniteShares Gold Trust",1155658],["QQQJ","QQQJ.O","Invesco NASDAQ Next Gen 100 ETF",1135838],["ETHE","ETHE.K","Grayscale Ethereum Staking ETF",1117642],["CGW","CGW","Invesco S&P Global Water Index ETF",1063920],["BITO","BITO.K","ProShares Bitcoin ETF",1050990],["EWI","EWI","Ishares Msci Italy ETF",1042065],["DBA","DBA","Invesco DB Agriculture Fund",1032551],["MOO","MOO","VanEck Agribusiness ETF",1004524],["FETH","FETH.K","Fidelity Ethereum Fund",994656],["LIT","LIT","Global X Lithium & Battery Tech ETF",975219],["IYM","IYM","iShares US Basic Materials ETF",919013],["TAN","TAN","Invesco Solar ETF",913208],["TPYP","TPYP.K","Tortoise North American Pipeline ETF",882195],["GSG","GSG","iShares S&P GSCI Commodity-Indexed Trust ETF",878310],["EWS","EWS","Ishares Msci Singapore Etf",854474],["HODL","HODL.K","VanEck Bitcoin",852849],["XRT","XRT","State Street PDR S&P Retail ETF",852506],["PPH","PPH.O","VanEck Pharmaceutical ETF",851923],["JETS","JETS.K","US Global Jets ETF",812493],["IEO","IEO","iShares US Oil & Gas Exploration & Production ETF",784887],["ARKF","ARKF.K","ARK Blockchain & Fintech Innovation ETF",780000],["IGE","IGE","iShares North American Natural Resources ETF",770610],["EIS","EIS","Ishares Msci Israel ETF",763233],["SMIN","SMIN.K","iShares MSCI India Small-Cap ETF",750880],["BLOK","BLOK.K","Amplify Blockchain Technology ETF",726110],["EWN","EWN","iShares MSCI Netherlands ETF",697992],["ECH","ECH","iShares MSCI Chile ETF",692928],["SPEU","SPEU.K","State Street SPDR Portfolio Europe ETF",689661],["BNO","BNO","United States Brent Oil Fund LP",668856],["DBJP","DBJP.K","Xtrackers MSCI Japan Hedged Equity ETF",667397],["ISCF","ISCF.K","iShares Intl Small Cap Equity Factor ETF",646043],["IXG","IXG","iShares Global Financials ETF",629454],["PJP","PJP","Invesco Pharmaceuticals ETF",613825],["INDY","INDY.O","iShares India 50 ETF",606848],["ARKX","ARKX.K","ARK Space & Defense Innovation ETF",595571],["KIE","KIE","State Street SPDR S&P Insurance ETF",589981],["FMAT","FMAT.K","Fidelity MSCI Materials Index ETF",588193],["FCG","FCG","First Trust Natural Gas ETF",574434],["ARGT","ARGT.K","Global X MSCI Argentina ETF",533849],["XPH","XPH","State Street SPDR S&P Pharmaceuticals ETF",533347],["ENFR","ENFR.K","ALPS Alerian Energy Infrastructure ETF",519260],["IXP","IXP","iShares Global Comm Services ETF",497042],["PALL","PALL.K","abrdn Physical Palladium Shares ETF",488134],["EIDO","EIDO.K","iShares MSCI Indonesia ETF",487795],["CPER","CPER.K","United States Copper Index Fund",485596],["UNG","UNG","United States Natural Gas Fund LP",454078],["EZA","EZA","iShares MSCI South Africa ETF",440352],["SIZE","SIZE.K","iShares MSCI USA Size Factor ETF",429024],["QCLN","QCLN.O","First Trust NASDAQ Clean Edge Green Energy Idx Fd",423748],["VNM","VNM","VanEck Vietnam ETF",417736],["GXC","GXC","State Street SPDR S&P China ETF",413490],["HEZU","HEZU.K","iShares Currency Hedged MSCI Eurozone ETF",411913],["PEJ","PEJ","Invesco Leisure and Entertainment ETF",391999],["MXI","MXI","iShares Global Materials ETF",384574],["IEZ","IEZ","iShares US Oil Equipment & Services ETF",357785],["CLOU","CLOU.O","Global X Cloud Computing ETF",351850],["EWQ","EWQ","iShares MSCI France ETF",338960],["BRRR","BRRR.O","Coinshares Bitcoin ETF",338222],["IDNA","IDNA.K","iShares Genomics Immunology and Healthcare ETF",324576],["EZBC","EZBC.K","Franklin Bitcoin ETF",319680],["BTCO","BTCO.K","Invesco Galaxy Bitcoin ETF",295467],["WCLD","WCLD.O","WisdomTree Cloud Computing Fund",293985],["THD","THD","Ishares Msci Thailand Etf",292230],["DRIV","DRIV.O","Global X Autonomous & Electric Vehicles ETF",274778],["ESPO","ESPO.O","VanEck Video Gaming and eSports ETF",258655],["BITQ","BITQ.K","Bitwise Crypto Industry Innovators ETF",258614],["XES","XES","State Street SPDR S&P Oil & Gas Equip & Serv ETF",255067],["PBW","PBW","Invesco WilderHill Clean Energy ETF",254062],["WEAT","WEAT.K","Teucrium Wheat Fund",211246],["QYLG","QYLG.O","Global X Nasdaq 100 Covered Call & Growth ETF",185080],["FAN","FAN","First Trust Global Wind Energy ETF",176280],["TOLZ","TOLZ.K","ProShares DJ Brookfield Global Infrastructure ETF",176269],["TUR","TUR.O","iShares MSCI Turkey ETF",160434],["CNRG","CNRG.K","State Street SPDR S&P Kensho Grid Innovation ETF",144595],["PXE","PXE","Invesco Energy Exploration & Production ETF",142580],["CORN","CORN.K","Teucrium Corn Fund",136266],["UGA","UGA","United States Gasoline Fund LP",131675],["JPXN","JPXN.K","iShares JPX-Nikkei 400 ETF",131544],["PXJ","PXJ","Invesco Oil & Gas Services ETF",123595],["USAI","USAI.K","Pacer American Energy Infrastructure ETF",122513],["SMOG","SMOG.K","VanEck Low Carbon Energy ETF",118898],["IDRV","IDRV.K","iShares Self-Driving EV and Tech ETF",115440],["GNOM","GNOM.O","Global X Genomics And Biotechnology ETF",100637],["EVX","EVX","VanEck Environmental Services ETF",99510],["PBD","PBD","Invesco Global Clean Energy ETF",86727],["ACES","ACES.K","ALPS Clean Energy ETF",81606],["BATT","BATT.K","Amplify Lithium & Battery Technology ETF",75803],["HYDR","HYDR.O","Global X Hydrogen ETF",64490],["HERO","HERO.O","Global X Video Games & Esports ETF",58670],["KARS","KARS.K","KraneShares Electric Vehicles and Future Mobility",58048],["KTEC","KTEC.K","KraneShares Hang Seng TECH Index ETF",42911],["CARZ","CARZ.O","First Trust S-Network Future Vehicles & Tech ETF",38693],["BETZ","BETZ.K","Roundhill Sports Betting & iGaming ETF",38609],["SOYB","SOYB.K","Teucrium Soybean Fund",37791],["GAMR","GAMR.K","Amplify Video Game Leaders ETF",37467],["NERD","NERD.K","Roundhill Video Games ETF",13978]];

function naverUSTop_(n) {
  var urls = [];
  (n > 600 ? [['NASDAQ', 9], ['NYSE', 8], ['AMEX', 3]] : [['NASDAQ', 5], ['NYSE', 5], ['AMEX', 1]]).forEach(function (e) {
    for (var p = 1; p <= e[1]; p++)
      urls.push('https://api.stock.naver.com/stock/exchange/' + e[0] + '/marketValue?page=' + p + '&pageSize=100');
  });
  var all = [];
  fetchAll_(urls).forEach(function (txt) {
    if (!txt) return;
    (JSON.parse(txt).stocks || []).forEach(function (x) {
      var cap = num_(x.marketValue);                       // 단위: 천 달러
      if (cap > 0 && !EXCLUDE_US_RE.test(x.stockName)) all.push({
        market: 'US', code: x.symbolCode, reuters: x.reutersCode,
        yahoo: String(x.symbolCode).replace(/\s+/g, '-'),
        name: x.stockName, type: x.stockEndType || 'stock',
        cap: Math.round(cap / 1e5), capUnit: '억달러',
        date: String(x.localTradedAt || '').slice(0, 10)
      });
    });
  });
  US_ETF.forEach(function (e) {                                         // ETF도 시총(순자산) 순위에 같이 넣음
    all.push({ market: 'US', code: e[0], reuters: e[1], yahoo: e[0], name: e[2], type: 'etf', cap: Math.round(e[3] / 1e5), capUnit: '억달러', date: '' });
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
// 금리가 오르는 중인지(매도 유예를 건너뛰는 조건): 미국 국채 10년 금리(FRED DGS10 하루 단위)가 6개월 전 달말보다 높으면 true. 못 받으면 false
//   tools/learn/7_backtest.js rateJ와 같은 규칙으로 유지할 것(그 달 마지막 거래일 값 비교; 이번 달은 가장 최근 값)
var FF = null;     // { 'YYYY-MM': 그 달 마지막 값 }
function rateUp_() { return rateAt_(0); }
// 이번 달에서 back개월 전 시점의 판단(확인 매수의 가상 포지션 유예 계산용)
function rateAt_(back0) {
  if (FF === null) {
    FF = {};
    try {
      var d0 = new Date(); d0.setFullYear(d0.getFullYear() - 3);
      UrlFetchApp.fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10&cosd=' + Utilities.formatDate(d0, 'Asia/Seoul', 'yyyy-MM-dd'), { headers: CFG.UA })
        .getContentText().split('\n').slice(1).forEach(function (l) {
          var p = l.trim().split(',');
          if (p.length > 1 && p[1] && p[1] !== '.') FF[p[0].slice(0, 7)] = +p[1];     // 날짜순이라 덮어쓰면 그 달 마지막 값
        });
    } catch (e) { FF = {}; }
  }
  var now = new Date(Utilities.formatDate(new Date(), 'Asia/Seoul', "yyyy-MM-dd'T'12:00:00"));
  var key = function (back) {
    var d = new Date(now.getFullYear(), now.getMonth() - back, 1);
    return d.getFullYear() + '-' + pad_(d.getMonth() + 1);
  };
  var a = FF[key(back0)], b = FF[key(back0 + 6)];
  return a !== undefined && b !== undefined && a > b;
}

/* ───────── 거래대금 순위 ─────────
 * 거래대금(달 i) = log10(직전 12개월(i-12..i-1) 평균 거래량 × 달 i 종가 + 1). tools/learn/3_build.js와 같은 정의.
 * 한 시장(한국 전체 또는 미국)의 후보들 월봉을 모아 매달 상위 n개의 문턱을 구함. 돌려주는 값: { th: {YYYYMM: 문턱}, at: function(mon, i) → 그 달 거래대금 }
 * 월봉이 14개월보다 짧은 종목은 순위에 못 들어감 */
function liqAt_(mon, i) {
  if (i < 13) return null;
  var c = mon[i].close, v = 0, k;
  if (!(c > 0)) return null;
  for (k = i - 12; k <= i - 1; k++) { if (mon[k].close > 0 || mon[k].vol > 0) v += mon[k].vol || 0; }
  return mon[i].vol ? Math.log(v / 12 * c + 1) / Math.LN10 : null;
}
function buildLiq_(mons, n) {
  var by = {};
  mons.forEach(function (mon) {
    if (!mon) return;
    for (var i = 13; i < mon.length; i++) {
      var t = liqAt_(mon, i); if (t == null) continue;
      (by[mon[i].ym] = by[mon[i].ym] || []).push(t);
    }
  });
  var th = {};
  Object.keys(by).forEach(function (ym) { var a = by[ym].sort(function (x, y) { return y - x; }); th[ym] = a[Math.min(n, a.length) - 1]; });
  return { th: th, at: liqAt_,
           has: function (mon, i) { var t = liqAt_(mon, i), h = th[mon[i] && mon[i].ym]; return t != null && h !== undefined && t >= h; } };
}

/* ───────── 확인 매수 후보 ─────────
 * 돌파 달(전달 종가 ≤ 10이평, 그달 종가 > 10이평)의 다음 달 시가에 샀다고 가정한 가상 포지션이
 * (익절 트레일 2배·유예 2달(금리 상승 중이면 1달)로 안 팔린 채) 이번 달 최근 종가 기준 +10% 이상이고 5>10>20 정배열이 "처음" 된 달이면 후보.
 * 점수 = 돌파 달 시점의 점수. 후보가 여러 돌파에서 나오면 점수가 가장 높은 것 하나. 돌려주는 값: 'YYYYMM|점수' 또는 ''
 * tools/learn/7_backtest.js confirmTrig와 같은 규칙으로 유지할 것 */
function confirmInfo_(s, mon, liq) { return confirmInfo2_(s, mon, liq).c; }
// 반환 {c: 확인 후보 '돌파월|점수' 또는 '', nr: 근접 후보 '돌파월|점수' 또는 ''}
// 근접 = 돌파 뒤 판매·익절 조건에 안 걸리고 아직 조건(+10%·정배열)을 못 채웠지만 이번 달 가격이 다음 달 시가보다 +6% 이상인 종목(마감 직전 확인 화면용: 지금 가격이 월말 종가가 되면 후보가 될 수 있음)
function confirmInfo2_(s, mon, liq) {
  var n = mon.length, M = CFG.MONTHS, c = mon.map(function (x) { return x.close; });
  var maAt = function (k, len) { return k >= len - 1 ? avg_(c.slice(k - len + 1, k + 1)) : null; };
  var best = null, up = null, nbest = null;
  for (var b = Math.max(M, 24); b <= n - 2; b++) {
    var mb = maAt(b, M), pm = maAt(b - 1, M);
    if (!(c[b - 1] <= pm && c[b] > mb)) continue;                       // 돌파 달
    if (liq && !liq.has(mon, b)) continue;                              // 그 돌파 달에 거래대금 상위가 아니었으면 후보가 아님(백테스트는 그 달 상위인 종목의 돌파만 신호로 봄)
    var p0 = mon[b + 1].open; if (!(p0 > 0)) continue;
    var tp = false, cnt = 0, alive = true, trig = false, reach = false;
    for (var j = b + 1; j <= n - 1 && alive; j++) {
      if (j === n - 1) reach = true;                                    // 이번 달 전까지 살아 있음
      var ma = maAt(j, M), p = c[j];
      if (ma != null) {
        if (p >= 2 * ma) tp = true; else if (tp) { alive = false; break; }
        if (p < ma) {
          cnt++;
          if (up === null) up = {};
          var back = n - 1 - j; if (up[back] === undefined) up[back] = rateAt_(back);
          if (cnt >= (up[back] ? 1 : 2)) { alive = false; break; }
        } else cnt = 0;
      }
      var a5 = maAt(j, 5), a20 = maAt(j, 20);
      if (p / p0 - 1 >= 0.1 && a5 != null && a20 != null && ma != null && a5 > ma && ma > a20) { trig = (j === n - 1); break; }   // 처음 조건을 채운 달이 이번 달이어야 후보
    }
    if (alive && trig) {
      var sc = scoreMonthly_(mon.slice(0, b + 1), s);
      if (sc !== '' && (best === null || sc > best.sc)) best = { ym: mon[b].ym, sc: sc };
    } else if (reach && !trig && c[n - 1] / p0 - 1 >= 0.06) {
      var sc2 = scoreMonthly_(mon.slice(0, b + 1), s);
      if (sc2 !== '' && (nbest === null || sc2 > nbest.sc)) nbest = { ym: mon[b].ym, sc: sc2 };
    }
  }
  return { c: best ? best.ym + '|' + best.sc : '', nr: nbest ? nbest.ym + '|' + nbest.sc : '' };
}

/* ───────── 수급 규칙(2026-11-27 채택) ─────────
 * 확인 매수 후보(한국)의 확인 달(= 이번 달, 월 중에는 오늘까지) 외국인·기관 순매수 금액이 같은 방향(둘 다 순매수 또는 둘 다 순매도)이면 후보에서 뺌.
 * 금액 = 네이버 일별 순매수 수량 × 그날 종가의 합(KRX 금액과 판단 일치 97~99%, tools/learn/2l_flow_naver.js). 자료를 못 받으면 그대로 둠.
 * tools/learn/flow.js · 7_backtest.js(JOURNAL_FLOW)와 같은 규칙으로 유지할 것. 돌려주는 값: 로그용 요약 */
function flowCheck_(rows) {
  var idx = [];
  rows.forEach(function (r, i) { if (r[15] && String(r[15]).charAt(0) !== '~') idx.push(i); });   // '~'로 시작하는 건 근접 후보(확인 후보가 아님)라 건너뜀
  if (!idx.length) return '수급: 후보 없음';
  var bodies = fetchAll_(idx.map(function (i) { return 'https://m.stock.naver.com/api/stock/' + rows[i][1] + '/trend?pageSize=30'; }));
  var out = [], miss = 0;
  idx.forEach(function (i, k) {
    var r = rows[i], ym = '';
    try { var ch = JSON.parse(r[13]); ym = String(ch[ch.length - 1][0]); } catch (e) {}
    var a = null; try { a = JSON.parse(bodies[k]); } catch (e) {}
    if (!ym || !a || !a.length) { miss++; return; }
    var fv = 0, iv = 0, days = 0;
    a.forEach(function (x) { if (String(x.bizdate).indexOf(ym) !== 0) return; var p = num_(x.closePrice); fv += num_(x.foreignerPureBuyQuant) * p; iv += num_(x.organPureBuyQuant) * p; days++; });
    if (!days) { miss++; return; }
    if ((fv > 0 && iv > 0) || (fv < 0 && iv < 0)) { out.push(r[2] + '(외 ' + Math.round(fv / 1e8) + '억/기 ' + Math.round(iv / 1e8) + '억)'); r[15] = ''; }
  });
  return '수급: 후보 ' + idx.length + '개 중 같은 방향 ' + out.length + '개 제외' + (miss ? ', 자료 없음 ' + miss : '') + (out.length ? ' — ' + out.join(', ') : '');
}

/* 익절(2배) 상태: 월 종가가 10이평의 2배 이상이면 '도달'(트레일 중), 직전 달에 2배 이상이었는데 이번 달 2배 선 아래로 내려오면 '하락'(이번 달 말 익절 매도 신호).
 * 보유 여부와 무관한 시장 기준 목록 — 규칙: 매수 뒤 종가 ≥ 2×10이평에 한 번이라도 닿았다가 처음 그 선 아래로 내려오면 매도 */
function tpInfo_(mon) {
  var n = mon.length, M = CFG.MONTHS, c = mon.map(function (x) { return x.close; });
  var ma = function (k) { return k >= M - 1 ? avg_(c.slice(k - M + 1, k + 1)) : null; };
  var m1 = ma(n - 1), m0 = ma(n - 2);
  if (m1 && c[n - 1] >= 2 * m1) return '도달|' + round_(c[n - 1] / m1) + '|' + mon[n - 1].ym;
  if (m0 && m1 && c[n - 2] >= 2 * m0 && c[n - 1] < 2 * m1) return '하락|' + round_(c[n - 2] / m0) + '|' + mon[n - 2].ym;
  return '';
}

function makeRow_(s, mon, liq) {
  if (liq && !liq.has(mon, mon.length - 1)) return null;                    // 이번 달 거래대금 상위가 아니면 목록에서 뺌
  var n = mon.length, M = CFG.MONTHS, c = mon.map(function (x) { return x.close; });
  var cur = c[n - 1], prev = c[n - 2];
  var ma = n >= M ? avg_(c.slice(n - M)) : '';
  var pma = n >= M + 1 ? avg_(c.slice(n - M - 1, n - 1)) : '';
  var pma2 = n >= M + 2 ? avg_(c.slice(n - M - 2, n - 2)) : '';
  var sig = '';
  var XN = s.market === 'US' ? M : 6;                                         // 판매 기준 이평 길이: 미국 10이평 · 한국 6이평 (매수 돌파·익절 2배 기준은 모두 10이평 그대로)
  var xma = n >= XN ? avg_(c.slice(n - XN)) : '';
  var pxma = n >= XN + 1 ? avg_(c.slice(n - XN - 1, n - 1)) : '';
  var pxma2 = n >= XN + 2 ? avg_(c.slice(n - XN - 2, n - 2)) : '';
  if (ma !== '' && pma !== '') {
    var below = xma !== '' && cur < xma;
    var justCrossed = below && pxma !== '' && prev >= pxma;                   // 이번 달 처음 판매 이평 아래로
    var second = below && pxma !== '' && prev < pxma && pxma2 !== '' && c[n - 3] >= pxma2;   // 전달 처음 아래로 → 이번 달 2개월째
    if (prev <= pma && cur > ma) sig = '매수';
    else if (second || (justCrossed && rateUp_())) sig = '매도';
    else if (justCrossed) sig = '유예';
    else sig = cur > ma ? '위' : '아래';
  }
  // 매수·매도·유예 종목만 차트용 월봉 저장: [[YYYYMM, 시가, 고가, 저가, 종가, 거래량], ...]
  // 점수 계산에 쓴 월봉 전체를 보내야 사이트의 "점수 설명"이 시트 점수와 똑같이 계산됨
  var tp = n >= M + 1 ? tpInfo_(mon) : '';                                           // 익절(2배) 상태 — '도달|배율|YYYYMM' / '하락|배율|YYYYMM'
  var ci = n >= 25 ? confirmInfo2_(s, mon, liq) : { c: '', nr: '' };
  var conf = ci.c || (ci.nr ? '~' + ci.nr : '');                                    // 확인 매수 후보('돌파월|점수') — 다음 달 첫날 사는 후보. 근접 후보는 앞에 '~'(마감 직전 확인 화면 전용, 일반 목록에는 안 나감)
  var chart = '';
  if (sig === '매수' || sig === '매도' || sig === '유예' || conf || tp) {
    chart = JSON.stringify(mon.map(function (x) {
      return [+x.ym, round_(x.open), round_(x.high), round_(x.low), round_(x.close), Math.round(x.vol || 0)];
    }));
  }
  // 매수 신호 종목만 점수 계산
  var scoreVal = sig === '매수' ? scoreMonthly_(mon, s) : '';
  return [s.market, s.code, s.name, s.type, s.cap, s.capUnit, round_(cur), round_(ma), n > 1 ? round_(prev) : '',
          round_(pma), sig, mon[n - 1].date, n, chart, scoreVal, conf, tp, xma !== '' ? round_(xma) : ''];
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
  ['sig', 'all', 'pre'].forEach(function (k) {
    var key = 'doGet:' + k, n = +c.get(key + ':n'), keys = [key + ':n'];
    for (var i = 0; i < n; i++) keys.push(key + ':' + i);
    c.removeAll(keys);
  });
}

/* ───────── 보유 종목 현재 월봉 ─────────
 * ?hold=005930.KS,AAPL,... (매매일지의 보유 종목, 최대 40개): 거래대금 상위 목록 밖으로 밀린 보유 종목도 현재 가격·신호를 볼 수 있게
 * 야후 월봉을 그때그때 받아 { rows: [{시장, 코드, 키, 최근종가, 10이평, 신호, 기준일, 차트}] }로 돌려줌(캐시 안 함, 시트 안 읽음) */
function holdRows_(param) {
  var ys = String(param || '').split(',').map(function (x) { return x.trim(); })
    .filter(function (x) { return /^[A-Za-z0-9.\-]{1,14}$/.test(x); }).slice(0, 40);
  var bodies = fetchAll_(ys.map(function (y) {
    return 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(y) + '?range=' + (CFG.CHART_N + 2) + 'mo&interval=1mo';
  }));
  var rows = [];
  ys.forEach(function (y, i) {
    var mon = parseYahooMonthly_(bodies[i]); if (!mon || mon.length <= CFG.MONTHS) return;
    var kr = /\.(KS|KQ)$/.test(y), mk = kr ? (/\.KS$/.test(y) ? 'KOSPI' : 'KOSDAQ') : 'US';
    var r = makeRow_({ market: mk, code: kr ? y.slice(0, -3) : y, name: '', type: '', cap: '', capUnit: '' }, mon);   // liq 없이: 순위와 무관하게 계산
    rows.push({ '시장': mk, '코드': r[1], '키': y, '최근종가': r[6], '10이평': r[7], '전달종가': r[8], '전달10이평': r[9], '신호': r[10], '기준일': r[11], '판매이평': r[17],
      '차트': mon.map(function (x) { return [+x.ym, round_(x.open), round_(x.high), round_(x.low), round_(x.close), Math.round(x.vol || 0)]; }) });
  });
  return { rows: rows };
}

/* ───────── 마감 직전 확인용 ─────────
 * ?pre=1: 확인 후보('확인')와 근접 후보('근접')의 월봉 + 금리 판단 기록(rateBack[k] = k개월 전 시점의 '금리 상승 중' 여부).
 * 화면(매매일지)이 실시간 가격을 이번 달 종가로 넣어 후보 조건을 다시 계산함(규칙은 confirmInfo2_와 같음) */
function preRows_() {
  var hit = cacheGet_('doGet:pre');
  if (hit) { try { return JSON.parse(hit); } catch (err) { } }
  var ss = SpreadsheetApp.getActive(), out = { updated: {}, rows: [], rateBack: [] };
  for (var k = 0; k <= 36; k++) out.rateBack.push(rateAt_(k));
  ['한국', '미국'].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (!sh || sh.getLastRow() < 2) return;
    out.updated[n] = sh.getRange('V1').getValue();
    sh.getRange(2, 1, sh.getLastRow() - 1, HEAD.length).getValues().forEach(function (r) {
      var cf = String(r[15] || ''); if (!cf) return;
      var near = cf.charAt(0) === '~', pr = (near ? cf.slice(1) : cf).split('|');
      var o = { '시장': r[0], '코드': r[1], '이름': r[2], '최근종가': r[6], '10이평': r[7], '기준일': r[11], '신호': near ? '근접' : '확인', '돌파월': pr[0], '점수': +pr[1], '판매이평': r[17] };
      try { o['차트'] = JSON.parse(r[13]); } catch (err) { o['차트'] = null; }
      if (o['차트']) out.rows.push(o);
    });
  });
  cachePut_('doGet:pre', JSON.stringify(out));
  return out;
}
/* ?flow=005930,000660,... (한국 6자리 코드, 최대 12개): 이번 달 외국인·기관 순매수 금액(수량×종가 합, 원) → { 코드: {fv, iv, days} }. 네이버 일별 투자자 매매(flowCheck_와 같은 계산), 60초 캐시 */
function flowRows_(list) {
  var codes = String(list).split(',').map(function (x) { return x.trim(); }).filter(function (x) { return /^\d{6}$/.test(x); }).slice(0, 12);
  if (!codes.length) return {};
  var ck = 'fl:' + codes.join(','), cache = CacheService.getScriptCache(), hit = cache.get(ck);
  if (hit) { try { return JSON.parse(hit); } catch (err) { } }
  var ym = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMM');
  var bodies = fetchAll_(codes.map(function (c) { return 'https://m.stock.naver.com/api/stock/' + c + '/trend?pageSize=30'; }));
  var out = {};
  codes.forEach(function (c, i) {
    var a = null; try { a = JSON.parse(bodies[i]); } catch (e) { }
    if (!a || !a.length) return;
    var fv = 0, iv = 0, days = 0;
    a.forEach(function (x) { if (String(x.bizdate).indexOf(ym) !== 0) return; var p = num_(x.closePrice); fv += num_(x.foreignerPureBuyQuant) * p; iv += num_(x.organPureBuyQuant) * p; days++; });
    if (days) out[c] = { fv: Math.round(fv), iv: Math.round(iv), days: days };
  });
  try { cache.put(ck, JSON.stringify(out), 60); } catch (err) { }
  return out;
}

// ?all=1 이면 모든 종목, 아니면 매수·매도·유예 신호만
function doGet(e) {
  if (e && e.parameter && e.parameter.q) return ContentService.createTextOutput(JSON.stringify(searchRows_(e.parameter.q))).setMimeType(ContentService.MimeType.JSON);
  if (e && e.parameter && e.parameter.live) return ContentService.createTextOutput(JSON.stringify(liveRows_(e.parameter.live))).setMimeType(ContentService.MimeType.JSON);
  if (e && e.parameter && e.parameter.px) return ContentService.createTextOutput(JSON.stringify(pxRows_(e.parameter.px))).setMimeType(ContentService.MimeType.JSON);
  if (e && e.parameter && e.parameter.pre) return ContentService.createTextOutput(JSON.stringify(preRows_())).setMimeType(ContentService.MimeType.JSON);
  if (e && e.parameter && e.parameter.flow) return ContentService.createTextOutput(JSON.stringify(flowRows_(e.parameter.flow))).setMimeType(ContentService.MimeType.JSON);
  if (e && e.parameter && e.parameter.hold) return ContentService.createTextOutput(JSON.stringify(holdRows_(e.parameter.hold))).setMimeType(ContentService.MimeType.JSON);
  var all = e && e.parameter && e.parameter.all;
  var key = 'doGet:' + (all ? 'all' : 'sig');
  var hit = cacheGet_(key);
  if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
  var ss = SpreadsheetApp.getActive(), out = { updated: {}, rows: [], rateUp: rateUp_() };   // rateUp: 미국 국채 10년 금리 상승 중인지(6개월 전 달말 대비)(매매일지의 매도 예정 계산용)
  ['한국', '미국'].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (!sh || sh.getLastRow() < 2) return;
    out.updated[n] = sh.getRange('V1').getValue();
    var v = sh.getRange(2, 1, sh.getLastRow() - 1, HEAD.length).getValues();
    v.forEach(function (r) {
      var isSig = r[10] === '매수' || r[10] === '매도' || r[10] === '유예', cf = String(r[15] || ''), tpv = String(r[16] || '');
      if (cf.charAt(0) === '~') cf = '';                      // 근접 후보는 ?pre=1에서만
      if (!all && !isSig && !cf && !tpv) return;
      var o = {};
      HEAD.forEach(function (h, i) { o[h] = r[i] instanceof Date ? fmtDate_(r[i]) : r[i]; });
      if (o['차트']) { try { o['차트'] = JSON.parse(o['차트']); } catch (err) { o['차트'] = null; } }
      delete o['확인']; delete o['익절'];
      if (all || isSig) out.rows.push(o);
      if (tpv) {                                  // 익절(2배) 종목은 '익절' 신호 행으로 따로 내려줌(상태·배율·기준월 포함)
        var qt = JSON.parse(JSON.stringify(o)), pt = tpv.split('|');
        qt['신호'] = '익절'; qt['익절상태'] = pt[0]; qt['배율'] = +pt[1]; qt['익절월'] = pt[2];
        out.rows.push(qt);
      }
      if (cf) {                                   // 확인 매수 후보는 '확인' 신호 행으로 따로 내려줌(점수 = 돌파 달 점수, 돌파월 포함)
        var q = JSON.parse(JSON.stringify(o)), pr = cf.split('|');
        q['신호'] = '확인'; q['돌파월'] = pr[0]; q['점수'] = +pr[1];
        out.rows.push(q);
      }
    });
  });
  var text = JSON.stringify(out);
  cachePut_(key, text);
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

/* ───────── 도구 ───────── */
// 배당률(%): 네이버 종목 정보의 배당수익률(한국 m.stock.naver.com/api/stock/<코드>/integration, 미국·ETF api.stock.naver.com/stock/<로이터코드>/basic). 값이 없거나 받기 실패면 빈칸.
function addDiv_(rows) {
  var urls = rows.map(function (r) {
    var s = r._s || {};
    return s.market === 'US' ? 'https://api.stock.naver.com/stock/' + encodeURIComponent(s.reuters || s.code) + '/basic'
                             : 'https://m.stock.naver.com/api/stock/' + r[1] + '/integration';
  });
  var bodies = fetchAll_(urls), n = 0;
  rows.forEach(function (r, i) {
    var y = '';
    try {
      var d = JSON.parse(bodies[i]), a = d.totalInfos || d.stockItemTotalInfos || [];
      for (var k = 0; k < a.length; k++) if (a[k].code === 'dividendYieldRatio') { var v = parseFloat(String(a[k].value).replace(/[^0-9.\-]/g, '')); if (v >= 0) { y = Math.round(v * 100) / 100; n++; } break; }
    } catch (e) {}
    r[18] = y;
  });
  return '(배당률 ' + n + '/' + rows.length + ')';
}

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
    ['B:D', 'F:F', 'K:L', 'N:N', 'Q:Q', 'U1:V1'].forEach(function (a) { sh.getRange(a).setNumberFormat('@'); });
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
             { range: q + '!U1:V1', majorDimension: 'ROWS', values: [['갱신', stamp]] }]
    }, id);
    tm.push('API쓰기 ' + sec(t));
    done = true;
  } catch (e) { tm.push('API안됨→기존방식'); }
  if (!done) {
    t = new Date(); sh.clearContents(); tm.push('지우기 ' + sec(t));
    t = new Date(); sh.getRange(1, 1, values.length, HEAD.length).setValues(values); tm.push('쓰기 ' + sec(t));
    t = new Date(); sh.getRange('U1:V1').setValues([['갱신', stamp]]); tm.push('갱신시각 ' + sec(t));
  }
  t = new Date(); cacheClear_(); tm.push('캐시 ' + sec(t));   // 새 데이터가 들어왔으니 저장해 둔 응답을 지움
  return '(' + tm.join(', ') + ')';
}

/* 종목 검색(매매일지 '내 체결 내역' 자동완성 보충): 이름·코드 일부 → [{code, name, mk:'KOSPI'|'KOSDAQ'|'US'}]. 네이버 자동완성을 씀(목록에 없는 종목용, 안 되면 빈 목록) */
function searchRows_(q) {
  q = String(q || '').trim(); if (!q) return [];
  try {
    var r = UrlFetchApp.fetch('https://ac.stock.naver.com/ac?q=' + encodeURIComponent(q) + '&target=stock', { muteHttpExceptions: true, headers: CFG.UA });
    var j = JSON.parse(r.getContentText()), items = j.items || [], flat = [], out = [], seen = {};
    items.forEach(function (x) { if (Array.isArray(x) && Array.isArray(x[0])) x.forEach(function (y) { flat.push(y); }); else flat.push(x); });
    flat.forEach(function (x) {
      var code, name, type, nation;
      if (Array.isArray(x)) { name = x[0]; code = x[1]; type = x[2]; nation = x[4]; }
      else if (x) { code = x.code; name = x.name; type = x.typeCode; nation = x.nationCode; }
      code = String(code || '').toUpperCase(); name = String(name || '');
      if (!code || !name || !/^[0-9A-Z.\-]{1,12}$/.test(code) || seen[code]) return;
      seen[code] = 1;
      var kr = /^\d{6}$/.test(code) || nation === 'KOR';
      out.push({ code: code, name: name, mk: kr ? (/KOSDAQ|코스닥/i.test(type || '') ? 'KOSDAQ' : 'KOSPI') : 'US' });
    });
    return out.slice(0, 10);
  } catch (err) { return []; }
}

/* 매매일지 '내 체결 내역' 현재가: 코드(쉼표로 여러 개) → { 코드: {px, prev, chg, pct, cur, src, t} }
 * 국내 6자리 코드는 네이버 시세(거의 실시간, 비공식 주소), 없거나 미국은 야후(약 15분 지연). prev = 전일 종가, chg·pct = 전일 대비 */
function liveRows_(list) {
  var codes = String(list).split(',').map(function (x) { return x.trim().toUpperCase(); }).filter(String).slice(0, 25);
  var ck = 'lv:' + codes.join(','), cache = CacheService.getScriptCache(), hit = cache.get(ck);           // 여러 기기·잦은 호출이 겹쳐도 3초 안에는 같은 응답(호출 한도 보호)
  if (hit) { try { return JSON.parse(hit); } catch (err) { } }
  var out = liveFetch_(codes); try { cache.put(ck, JSON.stringify(out), 3); } catch (err) { }
  return out;
}
function liveFetch_(codes) {
  var out = {}, now = Date.now();
  var kr = codes.filter(function (c) { return /^\d{6}$/.test(c); });
  if (kr.length) {
    try {
      var r = UrlFetchApp.fetch('https://polling.finance.naver.com/api/realtime?query=SERVICE_ITEM:' + kr.join(','), { muteHttpExceptions: true, headers: CFG.UA });
      var j = JSON.parse(r.getContentText()), areas = (j.result && j.result.areas) || [];
      areas.forEach(function (a) {
        (a.datas || []).forEach(function (d) {
          var c = String(d.cd || ''), px = +d.nv, prev = +d.pcv; if (!c || !(px > 0)) return;
          out[c] = { px: px, prev: prev > 0 ? prev : null, chg: prev > 0 ? px - prev : null, pct: prev > 0 ? (px / prev - 1) * 100 : null, cur: 'KRW', src: 'naver', t: now };
        });
      });
    } catch (err) { }
  }
  var reqs = [], meta = [];
  codes.forEach(function (c) {
    if (out[c]) return;
    var ys = /^\d{6}$/.test(c) ? [c + '.KS', c + '.KQ'] : [c];
    ys.forEach(function (y) { reqs.push({ url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(y) + '?range=1d&interval=5m', muteHttpExceptions: true, headers: CFG.UA }); meta.push([c, y]); });
  });
  var res = reqs.length ? UrlFetchApp.fetchAll(reqs) : [];
  res.forEach(function (rr, i) {
    var c = meta[i][0], y = meta[i][1]; if (out[c]) return;
    try {
      var m = JSON.parse(rr.getContentText()).chart.result[0].meta, px = +m.regularMarketPrice, prev = +(m.chartPreviousClose || m.previousClose);
      if (!(px > 0)) return;
      out[c] = { px: px, prev: prev > 0 ? prev : null, chg: prev > 0 ? px - prev : null, pct: prev > 0 ? (px / prev - 1) * 100 : null, cur: /\.(KS|KQ)$/.test(y) ? 'KRW' : (m.currency || 'USD'), src: 'yahoo', t: now };
    } catch (err) { }
  });
  return out;
}

/* 매매일지 '내 체결 내역' 평가용: 코드(쉼표로 여러 개)별 직전 마감 종가. 국내 6자리 코드는 .KS → .KQ 순으로 찾음.
 * 오늘 장이 아직 안 끝났으면 오늘 봉은 빼고 직전 마감일 종가를 줌 → { 코드: {px, date(거래소 현지 날짜), cur:'KRW'|'USD', key} } */
function pxRows_(list) {
  var codes = String(list).split(',').map(function (x) { return x.trim().toUpperCase(); }).filter(String).slice(0, 25);
  var reqs = [], meta = [];
  codes.forEach(function (c) {
    var ys = /^\d{6}$/.test(c) ? [c + '.KS', c + '.KQ'] : [c];
    ys.forEach(function (y) {
      reqs.push({ url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(y) + '?range=10d&interval=1d', muteHttpExceptions: true, headers: CFG.UA });
      meta.push([c, y]);
    });
  });
  var res = reqs.length ? UrlFetchApp.fetchAll(reqs) : [], out = {}, now = Date.now() / 1000;
  res.forEach(function (r, i) {
    var c = meta[i][0], y = meta[i][1]; if (out[c]) return;
    try {
      var j = JSON.parse(r.getContentText()).chart.result[0], ts = j.timestamp, q = j.indicators.quote[0].close, m = j.meta;
      var reg = m.currentTradingPeriod && m.currentTradingPeriod.regular, last = -1;
      for (var k = ts.length - 1; k >= 0; k--) {
        if (q[k] == null) continue;
        if (reg && ts[k] >= reg.start && now < reg.end) continue;           // 오늘 장이 아직 안 끝났으면 그 봉은 뺌(직전 마감일 종가를 씀)
        last = k; break;
      }
      if (last < 0) return;
      out[c] = { px: q[last], date: Utilities.formatDate(new Date((ts[last] + (m.gmtoffset || 0)) * 1000), 'UTC', 'yyyy-MM-dd'), cur: /\.(KS|KQ)$/.test(y) ? 'KRW' : (m.currency || 'USD'), key: y };
    } catch (err) { }
  });
  return out;
}

/* ── 내 일지 동기화(매매일지 ?x=1): 폰·PC에서 같은 체결·금액·시작 시점을 보게 함 ──
 * 스크립트 속성 MY_KEY(나만 아는 긴 글자)가 맞아야 읽고 씀. 데이터는 시트 '내일지' 탭(A열 한 칸당 4만 자)에 저장.
 * 요청(POST, 본문 JSON): {k:키, op:'load'} 또는 {k:키, op:'save', base:내가 마지막으로 본 rev, data:{…}}
 * 응답: {ok, rev, data} / 충돌이면 {ok:false, err:'conflict', rev, data} / 키가 틀리면 {ok:false, err:'badkey'} */
function doPost(e) {
  var out = function (o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); };
  try {
    var b = JSON.parse(e.postData.contents), key = PropertiesService.getScriptProperties().getProperty('MY_KEY');
    if (!key) return out({ ok: false, err: 'nokey' });
    if (!b || b.k !== key) return out({ ok: false, err: 'badkey' });
    var lock = LockService.getScriptLock(); lock.waitLock(15000);
    try {
      var ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName('내일지') || ss.insertSheet('내일지');
      var rev = +sh.getRange('B1').getValue() || 0, readData = function () {
        var n = sh.getLastRow(); if (n < 2) return null;
        var txt = sh.getRange(2, 1, n - 1, 1).getValues().map(function (r) { return r[0]; }).join('');
        try { return JSON.parse(txt); } catch (err) { return null; }
      };
      if (b.op === 'load') return out({ ok: true, rev: rev, data: readData() });
      if (b.op === 'save') {
        if (rev > 0 && (+b.base || 0) < rev) return out({ ok: false, err: 'conflict', rev: rev, data: readData() });   // 내가 모르는 새 저장이 있었음 → 합쳐서 다시 보내야 함
        var txt = JSON.stringify(b.data || {}), parts = [], i;
        for (i = 0; i < txt.length; i += 40000) parts.push([txt.substr(i, 40000)]);
        sh.clearContents();
        var nrev = Math.max(Date.now(), rev + 1);
        sh.getRange('A1:B1').setValues([['내일지 (비공개 데이터, 지우지 마세요)', nrev]]);
        if (parts.length) sh.getRange(2, 1, parts.length, 1).setValues(parts);
        return out({ ok: true, rev: nrev });
      }
      return out({ ok: false, err: 'badop' });
    } finally { lock.releaseLock(); }
  } catch (err) { return out({ ok: false, err: String(err && err.message || err) }); }
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
