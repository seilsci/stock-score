// 한국 투자자별 순매수(외국인·기관) 받기(백테스트 전용, 사이트에는 안 씀) → data/krx_flow/<YYYYMM>.json
//   {_done, name:{종목코드:이름}, f:{종목코드:[순매수거래량, 순매수거래대금, 매수거래대금, 매도거래대금]}(외국인), i:{…}(기관합계)}  (거래대금은 원 단위)
//   자료: KRX 정보데이터시스템(data.krx.co.kr) [12010] 투자자별 순매수상위종목 화면이 부르는 주소(getJsonData.cmd, bld=…MDCSTAT02401)를 달마다 한 번씩 부름.
//   ★ 로그인이 필요함 → 브라우저에서 로그인한 뒤 요청 머리말의 Cookie 줄 값을 PC 환경 변수 KRX_COOKIE에 넣어서 씀(채팅·저장소에 붙이지 말 것, 로그에도 안 찍음).
//       Git Bash:  export KRX_COOKIE='JSESSIONID=…; …'      (F12 → Network → getJsonData.cmd 요청 → Headers → Request Headers → Cookie)
//   ★ 이어받기: 받은 달(_done)은 건너뜀. 막히거나(로그아웃·429 등) 응답이 이상하면 그 자리에서 멈추고 안내를 찍음(그때까지 받은 달은 저장됨).
//   ★ 검산: 처음 받는 달에 삼성전자 줄을 찍음 → KRX 화면(같은 기간)의 값과 맞는지 눈으로 확인할 것. 투자자 코드(외국인 9000·기관합계 7050)가 틀리면 여기서 드러남.
//   실행: node 2k_flow.js   (FLOW_FROM=201112 처음 달, FLOW_MAX=숫자 한 번에 몇 달만, FLOW_WAIT=1500 요청 사이 ms, FLOW_DIR=저장 폴더, FLOW_MKT=ALL|STK|KSQ)
const { fs, path, DATA, sleep } = require('./common');
const DIR = process.env.FLOW_DIR || path.join(DATA, 'krx_flow'); fs.mkdirSync(DIR, { recursive: true });
const URL = process.env.FLOW_URL || 'https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd';
const BLD = 'dbms/MDC/STAT/standard/MDCSTAT02401';
const INV = { f: '9000', i: '7050' };                      // 외국인, 기관합계 (개인 8000은 외국인·기관의 거울이라 안 받음)
const num = v => { const x = +String(v == null ? '' : v).replace(/[,\s]/g, ''); return Number.isFinite(x) ? x : 0; };
function pick(row, re) { for (const k of Object.keys(row)) if (re.test(k)) return row[k]; return undefined; }
function parseRows(json) {                                 // 응답 JSON → [{code,name,nv,nval,bval,sval}] (필드 이름이 조금 달라도 정규식으로 찾음)
  const rows = (json && (json.OutBlock_1 || json.output || json.block1)) || [];
  const out = [];
  for (const r of rows) {
    const code = String(pick(r, /^ISU_(SRT_)?CD$/) || '').trim(), name = String(pick(r, /^ISU_(ABBRV|NM)$/) || '').trim();
    if (!code) continue;
    out.push({ code, name, nv: num(pick(r, /NETBID_TRDVOL/)), nval: num(pick(r, /NETBID_TRDVAL/)), bval: num(pick(r, /^BID_TRDVAL/)), sval: num(pick(r, /^ASK_TRDVAL/)) });
  }
  return out;
}
const ST = {}; const bump = k => { ST[k] = (ST[k] || 0) + 1; };
async function call(inv, strt, end, mkt) {                 // → {ok:true,rows} | {ok:false,why}
  const body = new URLSearchParams({ bld: BLD, locale: 'ko_KR', mktId: mkt, invstTpCd: inv, strtDd: strt, endDd: end, share: '1', money: '1', csvxls_isNo: 'false' }).toString();
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': 'Mozilla/5.0 (compatible; research-script)', 'Referer': 'https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201', 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/javascript, */*; q=0.01' };
  if (process.env.KRX_COOKIE) headers.Cookie = process.env.KRX_COOKIE;
  let wait = +process.env.FLOW_WAIT || 1500;
  for (let t = 0; t < 4; t++) {
    try {
      const r = await fetch(URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(60000) }); bump(String(r.status));
      if (r.status === 429 || r.status >= 500) { wait *= 2; await sleep(wait); continue; }
      if (r.status === 400 || r.status === 401 || r.status === 403) return { ok: false, why: 'HTTP ' + r.status + ' — 로그인(KRX_COOKIE)이 없거나 만료됐을 수 있음' };
      const text = await r.text(); let j; try { j = JSON.parse(text); } catch (e) { return { ok: false, why: '응답이 JSON이 아님(로그인 만료·점검 중일 수 있음): ' + text.slice(0, 80).replace(/\s+/g, ' ') }; }
      const rows = parseRows(j); if (!rows.length) return { ok: false, why: '응답에 종목 줄이 없음(키 ' + Object.keys(j).join(',') + ')' };
      return { ok: true, rows, sample: (j.OutBlock_1 || [])[0] };
    } catch (e) { bump('오류'); await sleep(wait * 2); }
  }
  return { ok: false, why: '여러 번 실패(네트워크·차단)' };
}
module.exports = { parseRows, num };
if (require.main === module) (async () => {
  const now = new Date(), CUR = now.getFullYear() * 100 + now.getMonth() + 1, FROM = +process.env.FLOW_FROM || 201112, MAXM = +process.env.FLOW_MAX || Infinity, WAIT = +process.env.FLOW_WAIT || 1500, MKT = process.env.FLOW_MKT || 'ALL';
  if (!process.env.KRX_COOKIE) console.log('※ KRX_COOKIE가 비어 있음 — 로그인 필요한 자료라 실패할 수 있음(머리말 주석 참고)');
  const months = []; for (let ym = FROM; ym < CUR; ym = (ym % 100 === 12 ? ym + 89 : ym + 1)) months.push(ym);   // 이번 달(진행 중)은 제외
  let got = 0, skip = 0, firstShown = false;
  for (const ym of months.reverse()) {                     // 최근 달부터
    const f = path.join(DIR, ym + '.json'); let M = null; try { M = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {}
    if (M && M._done) { skip++; continue; }
    if (got >= MAXM) break;
    const y = Math.floor(ym / 100), m = ym % 100, strt = String(ym) + '01', end = String(ym) + String(new Date(y, m, 0).getDate());
    M = { name: {}, f: {}, i: {} };
    for (const k of Object.keys(INV)) {
      const r = await call(INV[k], strt, end, MKT);
      if (!r.ok) { console.log('✗ ' + ym + ' ' + (k === 'f' ? '외국인' : '기관') + ': ' + r.why + '\n  → 여기서 멈춤(받은 달은 저장됨, 다시 실행하면 이어받음)'); console.log('상태별 횟수', JSON.stringify(ST)); return; }
      for (const x of r.rows) { M.name[x.code] = x.name; M[k][x.code] = [x.nv, x.nval, x.bval, x.sval]; }
      if (!firstShown && k === 'f') { firstShown = true; const s = r.rows.find(x => x.code === '005930') || r.rows[0]; console.log('검산용 첫 응답(' + ym + ' 외국인) 종목 ' + r.rows.length + '개 · ' + s.code + ' ' + s.name + ' 순매수거래대금 ' + s.nval.toLocaleString() + '원, 매수 ' + s.bval.toLocaleString() + ', 매도 ' + s.sval.toLocaleString() + ' — KRX 화면과 맞는지 확인(원 단위 필드 이름: ' + Object.keys(r.sample || {}).join(',') + ')'); }
      await sleep(WAIT);
    }
    M._done = true; fs.writeFileSync(f, JSON.stringify(M)); got++;
    console.log('✓ ' + ym + ' (외국인 ' + Object.keys(M.f).length + '·기관 ' + Object.keys(M.i).length + '종목)');
  }
  console.log('끝: 새로 받은 달 ' + got + '개, 이미 있어서 건너뜀 ' + skip + '개 · 상태별 횟수 ' + JSON.stringify(ST));
})();
