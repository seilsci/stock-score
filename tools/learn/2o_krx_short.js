// 한국 공매도 거래(종목별, 월 합계) 받기(백테스트 전용) → data/krx_short/<YYYYMM>.json
//   {_done, req:{쓴 요청}, d:{종목코드6자리:[공매도 거래량, 전체 거래량, 1]}}   (월 공매도 비율 = [0]÷[1])
//   자료: KRX 정보데이터시스템(data.krx.co.kr) 공매도 종합 화면이 부르는 주소(getJsonData.cmd). 수급 받기(2k_flow.js)와 같은 방식 — 로그인 쿠키 필요(PC 환경 변수 KRX_COOKIE, 채팅·저장소·로그에 안 붙임).
//   ★ 화면이 부르는 요청 이름(bld)·변수를 오프라인에서 확인하지 못해 후보 몇 개를 차례로 시험해(처음 받는 달에) 종목 줄에 공매도 거래량 필드가 있는 첫 후보를 data/krx_short/_req.json에 저장해 씀.
//     전부 실패하면 어떤 응답이 왔는지(상태·키 이름)를 찍고 멈춤 → 그 출력을 Claude에게 주면 요청을 고침. 직접 지정하려면: KRXS_BLD='dbms/MDC/STAT/srt/…' KRXS_EXTRA='{"mktTpCd":"1"}' (KRXS_EXTRA는 JSON)
//   ★ 이어받기: 받은 달(_done)은 건너뜀. 막히면(로그아웃 등) 그 자리에서 멈춤. 공매도 금지 기간(2020-03~2021-05, 2023-11~2025-03)은 자료가 비거나 적을 수 있음(그 달은 빈 파일로 표시).
//   실행: node 2o_krx_short.js   (KRXS_FROM=201101 처음 달, KRXS_MAX=숫자 한 번에 몇 달만, KRXS_WAIT=1500 요청 사이 ms, KRXS_PROBE=1 요청 후보만 시험하고 끝)
const { fs, path, DATA, sleep } = require('./common');
const DIR = path.join(DATA, 'krx_short'); fs.mkdirSync(DIR, { recursive: true });
const URL = process.env.KRXS_URL || 'https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd';
const num = v => { const x = +String(v == null ? '' : v).replace(/[,\s]/g, ''); return Number.isFinite(x) ? x : 0; };
const pick = (row, re) => { for (const k of Object.keys(row)) if (re.test(k)) return row[k]; return undefined; };
function codeOf(row) {                                      // 종목코드 6자리(ISIN이면 가운데 6자리)
  let c = String(pick(row, /^ISU_(SRT_)?CD$/) || pick(row, /^ISU_CD$/) || '').trim();
  if (/^KR\d[0-9A-Z]{9}\d$/.test(c)) c = c.slice(3, 9);
  return /^[0-9A-Z]{6}$/.test(c) ? c : '';
}
function parseRows(json) {                                  // → [{code, sell, total}] (공매도 거래량 필드를 못 찾으면 빈 배열)
  const rows = (json && (json.OutBlock_1 || json.output || json.block1)) || [], out = [];
  for (const r of rows) {
    const code = codeOf(r); if (!code) continue;
    const sell = pick(r, /CVSRTSELL_TRDVOL|SHRTSELL.*TRDVOL|SHRT.*VOL|STMFRT.*TRDVOL/i), total = pick(r, /^ACC_TRDVOL$|^TOT_TRDVOL$|^TRDVOL$|ACC_TRDVOL/i);
    if (sell === undefined || total === undefined) continue;
    out.push({ code, sell: num(sell), total: num(total) });
  }
  return out;
}
const CANDS = [                                              // [bld, 추가 변수] — 전 종목 공매도 종합(기간 합계)일 가능성이 있는 후보들
  ['dbms/MDC/STAT/srt/MDCSTAT30101', { searchType: '1', mktTpCd: '1' }],
  ['dbms/MDC/STAT/srt/MDCSTAT30101', { inqCond: 'STMFRTSCIFDRCD', mktId: 'STK' }],
  ['dbms/MDC/STAT/srt/MDCSTAT30101', { mktId: 'STK' }],
  ['dbms/MDC/STAT/srt/MDCSTAT30001', { mktTpCd: '1', searchType: '1' }],
  ['dbms/MDC/STAT/srt/MDCSTAT30001', { mktId: 'STK' }],
  ['dbms/MDC/STAT/srt/MDCSTAT30401', { mktTpCd: '1' }],
];
const ST = {}; const bump = k => { ST[k] = (ST[k] || 0) + 1; };
async function call(bld, extra, strt, end) {                 // → {ok, rows, keys, why}
  const body = new URLSearchParams({ bld, locale: 'ko_KR', strtDd: strt, endDd: end, trdDd: end, share: '1', money: '1', csvxls_isNo: 'false', ...extra }).toString();
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': 'Mozilla/5.0 (compatible; research-script)', 'Referer': 'https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201', 'X-Requested-With': 'XMLHttpRequest' };
  if (process.env.KRX_COOKIE) headers.Cookie = process.env.KRX_COOKIE;
  let wait = +process.env.KRXS_WAIT || 1500;
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(60000) }); bump(String(r.status));
      if (r.status === 429 || r.status >= 500) { wait *= 2; await sleep(wait); continue; }
      if (r.status === 400 || r.status === 401 || r.status === 403) return { ok: false, why: 'HTTP ' + r.status + ' — 로그인(KRX_COOKIE)이 없거나 만료됐거나 요청 이름이 틀림' };
      const text = await r.text(); let j; try { j = JSON.parse(text); } catch (e) { return { ok: false, why: '응답이 JSON이 아님: ' + text.slice(0, 80).replace(/\s+/g, ' ') }; }
      const rows = parseRows(j), raw = (j.OutBlock_1 || j.output || j.block1 || []);
      return rows.length ? { ok: true, rows } : { ok: false, why: '공매도 거래량 필드를 못 찾음(최상위 키 ' + Object.keys(j).join(',') + ' · 첫 줄 키 ' + (raw[0] ? Object.keys(raw[0]).join(',') : '없음') + ')' };
    } catch (e) { bump('오류'); await sleep(wait * 2); }
  }
  return { ok: false, why: '여러 번 실패(네트워크·차단)' };
}
module.exports = { parseRows, codeOf, num };
if (require.main === module) (async () => {
  if (!process.env.KRX_COOKIE) console.log('※ KRX_COOKIE가 비어 있음 — 로그인 필요한 자료라 실패할 수 있음(머리말 주석 참고)');
  const now = new Date(), CUR = now.getFullYear() * 100 + now.getMonth() + 1, FROM = +process.env.KRXS_FROM || 201101, MAXM = +process.env.KRXS_MAX || Infinity, WAIT = +process.env.KRXS_WAIT || 1500;
  const lastDay = ym => String(ym) + String(new Date(Math.floor(ym / 100), ym % 100, 0).getDate());
  const rf = path.join(DIR, '_req.json'); let REQ = null;
  if (process.env.KRXS_BLD) REQ = { bld: process.env.KRXS_BLD, extra: JSON.parse(process.env.KRXS_EXTRA || '{}') }; else { try { REQ = JSON.parse(fs.readFileSync(rf, 'utf8')); } catch (e) {} }
  if (!REQ || process.env.KRXS_PROBE) {                       // 요청 후보 시험: 최근 달로
    const t = CUR % 100 === 1 ? CUR - 89 : CUR - 1, strt = String(t) + '01', end = lastDay(t); let found = null; const why = [];
    for (const [bld, extra] of CANDS) { const r = await call(bld, extra, strt, end); if (r.ok) { found = { bld, extra }; console.log('✓ 요청 후보 사용: ' + bld + ' ' + JSON.stringify(extra) + ' (종목 ' + r.rows.length + '개, 삼성전자 ' + JSON.stringify(r.rows.find(x => x.code === '005930') || r.rows[0]) + ')'); break; } why.push(bld.split('/').pop() + ' ' + JSON.stringify(extra) + ' → ' + r.why); await sleep(WAIT); }
    if (!found) { console.log('✗ 공매도 요청 후보가 모두 실패했습니다. 아래 줄을 Claude에게 알려 주세요(키·쿠키 값은 포함하지 마세요):\n  ' + why.join('\n  ')); process.exit(0); }
    REQ = found; fs.writeFileSync(rf, JSON.stringify(REQ)); if (process.env.KRXS_PROBE) process.exit(0);
  }
  const months = []; for (let ym = FROM; ym < CUR; ym = (ym % 100 === 12 ? ym + 89 : ym + 1)) months.push(ym);
  let got = 0, skip = 0;
  for (const ym of months.reverse()) {
    const f = path.join(DIR, ym + '.json'); let M = null; try { M = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {}
    if (M && M._done) { skip++; continue; }
    if (got >= MAXM) break;
    const r = await call(REQ.bld, REQ.extra, String(ym) + '01', lastDay(ym));
    if (!r.ok) {
      if (/필드를 못 찾음/.test(r.why)) { fs.writeFileSync(f, JSON.stringify({ _done: true, empty: true, d: {} })); console.log('· ' + ym + ': 자료 없음(금지 기간일 수 있음) — 빈 파일로 표시'); got++; await sleep(WAIT); continue; }
      console.log('✗ ' + ym + ': ' + r.why + '\n  → 여기서 멈춤(받은 달은 저장됨, 다시 실행하면 이어받음)'); break;
    }
    const d = {}; for (const x of r.rows) d[x.code] = [x.sell, x.total, 1];
    fs.writeFileSync(f, JSON.stringify({ _done: true, req: REQ, d })); got++;
    console.log('✓ ' + ym + ' (종목 ' + r.rows.length + '개)'); await sleep(WAIT);
  }
  console.log('끝: 새로 받은 달 ' + got + '개, 이미 있어서 건너뜀 ' + skip + '개 · 상태별 횟수 ' + JSON.stringify(ST));
})();
