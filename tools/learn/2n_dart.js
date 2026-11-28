// 한국 재무제표 받기(DART 오픈API, 백테스트 전용) → data/dart/<종목코드6자리>.json
//   {c: 기업코드, yrs:[받아 본 사업연도], r:[{y 사업연도, filed 공시일(YYYYMMDD), fs:'CFS'|'OFS', rev 매출액, oi 영업이익, ni 당기순이익, assets 자산총계, liab 부채총계, eq 자본총계}]} (원 단위)
//   ★ API 키 필요(무료): opendart.fss.or.kr 회원가입 → 인증키 신청 → PC 환경 변수 DART_KEY에 넣음(채팅·저장소에 붙이지 말 것, 로그에도 안 찍음).
//       Git Bash:  export DART_KEY='…'
//   ★ 받는 것: 백테스트에 쓰인 한국 종목(events.csv)의 사업보고서(연간) 주요 계정 2015년~(전체 재무제표 API가 2015년부터라 그 전은 없음) → 신호 달 말까지 공시된 것만 쓰도록 공시일(접수번호 앞 8자리)을 같이 저장.
//   ★ 하루 요청 한도(약 2만 건)에 걸리면(status 020) 그 자리에서 멈춤 → 다음 날 다시 실행하면 받은 종목·연도는 건너뛰고 이어받음.
//   실행: node 2n_dart.js   (DART_FROM=2015 첫 사업연도, DART_MAX=숫자 한 번에 몇 종목만, DART_WAIT=120 요청 사이 ms, DART_CONC=3 동시 요청)
const { fs, path, DATA, sleep } = require('./common');
const zlib = require('zlib');
const KEY = process.env.DART_KEY;
const DIR = path.join(DATA, 'dart'); fs.mkdirSync(DIR, { recursive: true });
const API = 'https://opendart.fss.or.kr/api/';
const num = v => { const s = String(v == null ? '' : v).replace(/[,\s]/g, ''); if (s === '' || s === '-') return null; const x = +s; return Number.isFinite(x) ? x : null; };

function unzipFirst(buf) {                                  // zip 한 개짜리에서 첫 파일 꺼내기(중앙 디렉터리 기준)
  let e = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('zip 끝 표시를 못 찾음(키 오류 등으로 zip이 아닐 수 있음)');
  const cd = buf.readUInt32LE(e + 16), method = buf.readUInt16LE(cd + 10), csize = buf.readUInt32LE(cd + 20), lho = buf.readUInt32LE(cd + 42);
  const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28), data = buf.slice(start, start + csize);
  return method === 0 ? data : zlib.inflateRawSync(data);
}
function parseCorp(xml) {                                   // CORPCODE.xml → {종목코드: 기업코드} (상장사만)
  const m = {}; const re = /<list>([\s\S]*?)<\/list>/g; let a;
  while ((a = re.exec(xml))) { const b = a[1], g = t => { const x = b.match(new RegExp('<' + t + '>([^<]*)</' + t + '>')); return x ? x[1].trim() : ''; }; const sc = g('stock_code'); if (/^\d{6}$/.test(sc)) m[sc] = g('corp_code'); }
  return m;
}
function pickAcct(list) {                                   // 계정 목록 → {rev,oi,ni,assets,liab,eq}
  const out = {}, byId = (ids, names, sj) => {
    for (const r of list) { if (sj && !sj.includes(r.sj_div)) continue; const id = String(r.account_id || ''), nm = String(r.account_nm || '').replace(/\s/g, ''); if (ids.includes(id) || names.some(n => nm === n)) { const v = num(r.thstrm_amount); if (v != null) return v; } }
    return null;
  };
  out.rev = byId(['ifrs-full_Revenue', 'ifrs_Revenue'], ['매출액', '수익(매출액)', '영업수익', '매출', '매출액(영업수익)'], ['IS', 'CIS']);
  out.oi = byId(['dart_OperatingIncomeLoss'], ['영업이익', '영업이익(손실)', '영업손익'], ['IS', 'CIS']);
  out.ni = byId(['ifrs-full_ProfitLoss', 'ifrs_ProfitLoss'], ['당기순이익', '당기순이익(손실)', '연결당기순이익', '연결당기순이익(손실)', '반기순이익', '당기순손익'], ['IS', 'CIS']);
  out.assets = byId(['ifrs-full_Assets', 'ifrs_Assets'], ['자산총계'], ['BS']);
  out.liab = byId(['ifrs-full_Liabilities', 'ifrs_Liabilities'], ['부채총계'], ['BS']);
  out.eq = byId(['ifrs-full_Equity', 'ifrs_Equity'], ['자본총계'], ['BS']);
  return out;
}
module.exports = { num, unzipFirst, parseCorp, pickAcct };

const ST = {}; const bump = k => { ST[k] = (ST[k] || 0) + 1; };
let ABORT = '';
async function callJ(url) {                                 // → {status, list?}  (키는 주소에만 있고 어디에도 찍지 않음)
  let wait = 800;
  for (let t = 0; t < 4; t++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; research-script)' }, signal: AbortSignal.timeout(40000) }); bump('HTTP ' + r.status);
      if (r.status === 429 || r.status >= 500) { await sleep(wait); wait *= 2; continue; }
      if (!r.ok) return { status: 'HTTP' + r.status };
      return await r.json();
    } catch (e) { bump('오류'); await sleep(wait); wait *= 2; }
  }
  return { status: 'NETERR' };
}
async function fetchYear(corp, y) {                         // 연결(CFS) 먼저, 자료 없으면 별도(OFS). → {fs, filed, ...계정} | null(자료 없음)
  for (const fsd of ['CFS', 'OFS']) {
    const j = await callJ(`${API}fnlttSinglAcntAll.json?crtfc_key=${KEY}&corp_code=${corp}&bsns_year=${y}&reprt_code=11011&fs_div=${fsd}`);
    if (j.status === '000' && Array.isArray(j.list) && j.list.length) { const a = pickAcct(j.list), rc = String(j.list[0].rcept_no || ''); return { y, filed: +rc.slice(0, 8) || null, fs: fsd, ...a }; }
    if (j.status === '013') continue;                       // 조회된 데이터가 없음
    if (j.status === '020') { ABORT = '하루 요청 한도(020)에 걸림 → 내일 다시 실행하면 이어받음'; return undefined; }
    if (['010', '011', '012', '901'].includes(j.status)) { ABORT = '인증키 문제(status ' + j.status + '): DART_KEY를 확인하세요'; return undefined; }
    if (j.status === 'NETERR' || String(j.status).startsWith('HTTP')) { ABORT = '네트워크·서버 문제(' + j.status + ')라 멈춤 → 다시 실행하면 이어받음'; return undefined; }
  }
  return null;
}
if (require.main === module) (async () => {
  if (!KEY) { console.log('DART_KEY가 비어 있음 — opendart.fss.or.kr에서 무료 인증키를 받아 export DART_KEY=… 로 넣고 다시 실행하세요.'); process.exit(0); }
  const cf = path.join(DIR, '_corp.json'); let corp = null; try { corp = JSON.parse(fs.readFileSync(cf, 'utf8')); } catch (e) {}
  if (!corp || !Object.keys(corp).length) {
    const r = await fetch(`${API}corpCode.xml?crtfc_key=${KEY}`, { signal: AbortSignal.timeout(120000) });
    const buf = Buffer.from(await r.arrayBuffer());
    try { corp = parseCorp(unzipFirst(buf).toString('utf8')); } catch (e) { console.log('기업코드 목록을 못 읽음: ' + e.message + (buf.length < 400 ? ' · 응답: ' + buf.toString('utf8').slice(0, 160).replace(/\s+/g, ' ') : '')); process.exit(0); }
    fs.writeFileSync(cf, JSON.stringify(corp)); console.log('기업코드 목록 저장: 상장사 ' + Object.keys(corp).length + '개');
  }
  const codes = new Set(); { const txt = fs.readFileSync(path.join(DATA, 'events.csv'), 'utf8'); for (const ln of txt.split('\n')) { const y = ln.slice(0, ln.indexOf(',')); if (/^\d{6}\.(KS|KQ)$/.test(y)) codes.add(y.slice(0, 6)); } }
  const now = new Date(), LASTY = now.getFullYear() - 1, FROM = +process.env.DART_FROM || 2015, MAXN = +process.env.DART_MAX || Infinity, WAIT = +process.env.DART_WAIT || 120, CONC = +process.env.DART_CONC || 3;
  const list = [...codes].sort(); let done = 0, calls = 0, nocorp = 0, newYears = 0, idx = 0, processed = 0;
  async function work() {
    while (idx < list.length && !ABORT && processed < MAXN) {
      const sc = list[idx++], f = path.join(DIR, sc + '.json'); let M = null; try { M = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {}
      if (!corp[sc]) { nocorp++; continue; }
      M = M || { c: corp[sc], yrs: [], r: [] };
      const need = []; for (let y = FROM; y <= LASTY; y++) if (!M.yrs.includes(y)) need.push(y);
      if (!need.length) { done++; continue; }
      processed++;
      for (const y of need) {
        const v = await fetchYear(corp[sc], y); calls++;
        if (v === undefined) break;                         // 멈춤(한도·키 문제): 이 연도는 기록하지 않음
        M.yrs.push(y); if (v) { M.r.push(v); newYears++; }
        await sleep(WAIT);
      }
      fs.writeFileSync(f, JSON.stringify(M)); done++;
      if (done % 25 === 0) process.stdout.write(`\r종목 ${done}/${list.length} · 요청 ${calls}회 · 새로 받은 연도 ${newYears}     `);
    }
  }
  await Promise.all(Array.from({ length: CONC }, work));
  console.log(`\nDART: 종목 ${list.length}개 중 처리 ${done}, 기업코드 없음 ${nocorp}, 요청 ${calls}회, 새로 받은 사업연도 ${newYears}` + (ABORT ? '\n⚠ ' + ABORT : '') + ' · 상태별 ' + JSON.stringify(ST));
})();
