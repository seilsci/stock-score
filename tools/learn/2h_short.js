// 미국 공매도 거래량 받기(백테스트 전용, 사이트에는 안 씀) → data/short/<YYYYMM>.json  {_done, ds:{날짜:1|0}, d:{종목:[공매도거래량 합, 전체거래량 합, 일수]}}
//   자료: FINRA 일별 공매도 거래량(Reg SHO) https://cdn.finra.org/equity/regsho/daily/CNMSshvol<YYYYMMDD>.txt — 열쇠(API 키) 필요 없음, 공개 파일.
//   하루 파일 하나를 받아 월별로 합쳐 저장함 → 월 공매도 거래량 비율 = 합계 ÷ 전체 거래량. (공매도 '잔고'가 아니라 거래량이라 시장조성자 거래가 섞여 비율이 높음 → 시험에서는 그 달 전 종목 중 순위로 씀.)
//   ★ 날짜 단위 이어받기: ds에 처리한 날(1=받음, 0=파일 없음=휴일)을 적어 두고 다음에는 못 받은 날만 받음. 중간에 닫아도 그때까지 받은 날은 저장됨(날마다 저장).
//   ★ 막히면 자동으로 느리게: 403/429/끊김이 나오면 요청 사이를 늘렸다가(최대 30초) 성공하면 줄임. 끝에 상태별 횟수·달별 요약을 data/short/_status.txt에 적음.
//   속도: 기본 3영업일에 하루만(SHORT_STEP=1이면 매일). 최근 달부터 거꾸로.
//   실행: node 2h_short.js   (SHORT_FROM=201101 처음 달, SHORT_MAX=숫자 앞에서 몇 달만, CONC=6 동시 요청 수, SHORT_STEP=3, SHORT_DIR=저장 폴더)
const { fs, path, DATA, sleep } = require('./common');
const DIR = process.env.SHORT_DIR || path.join(DATA, 'short'); fs.mkdirSync(DIR, { recursive: true });
const URL = d => `https://cdn.finra.org/equity/regsho/daily/CNMSshvol${d}.txt`;
function parseDay(text, agg) {                            // 한 날 파일(Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market) → agg에 더함
  let n = 0;
  for (const line of String(text).split(/\r?\n/)) {
    const p = line.split('|');
    if (p.length < 5 || !/^\d{8}$/.test(p[0])) continue;   // 머리글·꼬리말 줄은 건너뜀
    const sym = p[1].trim(), s = +p[2], t = +p[4];
    if (!sym || !(t >= 0) || !(s >= 0)) continue;
    const a = agg[sym] || (agg[sym] = [0, 0, 0]); a[0] += s; a[1] += t; a[2]++; n++;
  }
  return n;
}
const ST = {}; let slow = 0;                               // 상태별 횟수 · 막혔을 때 요청 사이 쉬는 시간(ms)
const bump = k => { ST[k] = (ST[k] || 0) + 1; };
async function getText(url) {                              // → {ok:true,text} | {ok:true,text:null}(파일 없음) | {ok:false}
  for (let t = 0; t < 5; t++) {
    if (slow) await sleep(slow);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; research-script)' }, signal: AbortSignal.timeout(90000) });
      bump(String(r.status));
      if (r.status === 404) { slow = Math.max(0, slow * 0.8 - 100); return { ok: true, text: null }; }
      if (r.status === 403) { if (t >= 1) return { ok: true, text: null, blocked: true }; await sleep(1500); continue; }   // 403: 없는 날(휴일)을 이렇게 돌려주는 서버가 많아서 두 번 확인 뒤 '없음'으로 처리(그 달에 받은 날이 하나도 없으면 막힌 것으로 보고 이어받기 대상으로 남김)
      if (r.status === 429 || r.status >= 500) { slow = Math.min(30000, (slow || 1500) * 2); await sleep(2000 * (t + 1)); continue; }
      if (!r.ok) return { ok: true, text: null };
      const text = await r.text(); slow = Math.max(0, slow * 0.8 - 100); return { ok: true, text };
    } catch (e) { bump('오류'); slow = Math.min(30000, (slow || 1500) * 2); await sleep(1500 * (t + 1)); }
  }
  return { ok: false };
}
module.exports = { parseDay, getText };
if (require.main === module) (async () => {
  const now = new Date(), CUR = now.getFullYear() * 100 + now.getMonth() + 1, FROM = +process.env.SHORT_FROM || 201101, CONC = +process.env.CONC || 6, STEP = Math.max(1, +process.env.SHORT_STEP || 3), MAXM = +process.env.SHORT_MAX || Infinity;
  const months = []; for (let ym = FROM; ym <= CUR; ym = (ym % 100 === 12 ? ym + 89 : ym + 1)) months.push(ym);
  const today = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
  const sum = []; let touched = 0, skipM = 0;
  for (const ym of months.reverse()) {                     // 최근 달부터
    const f = path.join(DIR, ym + '.json'); let M = null;
    try { M = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {}
    if (M && M._done && ym < CUR) { skipM++; sum.push([ym, 'done', Object.values(M.ds || {}).filter(v => v === 1).length]); continue; }
    if (!M || !M.ds) M = { ds: {}, d: {} };                // 옛 형식(날짜 기록 없음)은 처음부터
    if (touched >= MAXM) { sum.push([ym, 'skip', 0]); continue; }
    const y = Math.floor(ym / 100), m = ym % 100, dim = new Date(y, m, 0).getDate(), days = []; let wi = 0;
    for (let d = 1; d <= dim; d++) { const wd = new Date(y, m - 1, d).getDay(), key = ym * 100 + d; if (wd !== 0 && wd !== 6 && key <= today) { if (wi++ % STEP === 0) days.push(key); } }
    const todo = days.filter(d => M.ds[d] === undefined); let idx = 0, fails = 0, got = 0, blocked = 0;
    const worker = async () => { while (idx < todo.length) { const d = todo[idx++]; const r = await getText(URL(d)); if (!r.ok) { fails++; continue; } if (r.blocked) blocked++; if (r.text && parseDay(r.text, M.d) > 0) { M.ds[d] = 1; got++; } else M.ds[d] = 0; fs.writeFileSync(f, JSON.stringify(M)); await sleep(50); } };
    await Promise.all(Array.from({ length: CONC }, worker));
    M._done = fails === 0 && ym < CUR && Object.values(M.ds).some(v => v === 1);
    if (!Object.values(M.ds).some(v => v === 1) && blocked > 0) { for (const d of Object.keys(M.ds)) if (M.ds[d] === 0) delete M.ds[d]; M._done = false; }   // 받은 날이 하나도 없고 403만 → 막힌 것: 다음에 다시
    fs.writeFileSync(f, JSON.stringify(M)); touched++;
    const ok = Object.values(M.ds).filter(v => v === 1).length; sum.push([ym, M._done ? 'done' : fails ? 'partial' : 'cur', ok]);
    console.log(`공매도 받기 ${ym}: 이번에 ${got}일 (이 달 받은 날 합계 ${ok}) · 종목 ${Object.keys(M.d).length}${fails ? ' · 못 받음 ' + fails + '일(다음 실행 때 이어서)' : ''}${blocked ? ' · 403(없는 날로 처리) ' + blocked + '일' : ''}${slow ? ' · 서버가 느려서 대기 ' + Math.round(slow / 1000) + '초' : ''}  (${touched + skipM}/${months.length}달)`);
  }
  const part = sum.filter(x => x[1] === 'partial').map(x => x[0]), miss = sum.filter(x => x[1] === 'skip').map(x => x[0]);
  const line = `끝: 완성 ${sum.filter(x => x[1] === 'done').length}달 · 일부만 ${part.length}달 · 건너뜀 ${miss.length}달 · 응답 상태 ${Object.entries(ST).map(([k, v]) => k + '×' + v).join(' ') || '(받기 없음)'}`;
  fs.writeFileSync(path.join(DIR, '_status.txt'), line + '\n' + (part.length ? '일부만: ' + part.join(' ') + '\n' : '') + (miss.length ? '건너뜀: ' + miss.join(' ') + '\n' : ''));
  console.log(line + (part.length ? ' → 다시 실행하면 못 받은 날만 이어서 받음' : ''));
})();
