// 미국 공매도 거래량 받기(백테스트 전용, 사이트에는 안 씀) → data/short/<YYYYMM>.json  {_done, d:{종목:[공매도거래량 합, 전체거래량 합, 일수]}}
//   자료: FINRA 일별 공매도 거래량(Reg SHO) https://cdn.finra.org/equity/regsho/daily/CNMSshvol<YYYYMMDD>.txt — 열쇠(API 키) 필요 없음, 공개 파일.
//   하루 파일 하나(약 수천 종목)를 받아 월별로 합쳐 저장함 → 월 공매도 거래량 비율 = 합계 ÷ 전체 거래량. (공매도 '잔고'가 아니라 그날 공매도로 체결된 거래량이라 시장조성자 거래가 섞여 비율이 평균 40~50%로 높음 → 시험에서는 그 달 전 종목 중 순위(백분위)로 씀.)
//   한국은 공매도 자료가 없어(KRX 키·금지 기간 공백) 이 도구는 미국만. 지난 달은 한 번 완성되면 건너뜀(이어받기), 이번 달은 매번 다시 받음.
//   속도: FINRA 파일 하나가 느려서(20초 안팎) 하루 건너 하루가 아니라 기본 3영업일에 하루만 받아 월 비율을 어림함(SHORT_STEP=1이면 매일, 기본 3). 최근 달부터 거꾸로 받아서 중간에 멈춰도 최근 연도는 이미 받아져 있음.
//   실행: node 2h_short.js   (SHORT_FROM=201101 처음 달, SHORT_MAX=숫자 앞에서 몇 달만, CONC=12 동시 요청 수, SHORT_STEP=3)
const { fs, path, DATA, sleep } = require('./common');
const DIR = path.join(DATA, 'short'); fs.mkdirSync(DIR, { recursive: true });
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
async function getText(url) {                              // 없는 날(휴일·아직 안 나온 날)은 null, 막히거나 끊기면 다시 시도하다 오류
  for (let t = 0; t < 4; t++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; research-script)' } });
      if (r.status === 404) return null;
      if (r.status === 403 || r.status === 429 || r.status >= 500) { await sleep(1500 * (t + 1)); continue; }
      if (!r.ok) return null;
      return await r.text();
    } catch (e) { await sleep(1000 * (t + 1)); }
  }
  throw new Error('받기 실패');
}
module.exports = { parseDay };
if (require.main === module) (async () => {
  const now = new Date(), CUR = now.getFullYear() * 100 + now.getMonth() + 1, FROM = +process.env.SHORT_FROM || 201101, CONC = +process.env.CONC || 12, STEP = Math.max(1, +process.env.SHORT_STEP || 3), MAXM = +process.env.SHORT_MAX || Infinity;
  const months = []; for (let ym = FROM; ym <= CUR; ym = (ym % 100 === 12 ? ym + 89 : ym + 1)) months.push(ym);
  const today = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
  let doneM = 0, newM = 0, skipM = 0, failM = 0, totalDays = 0;
  for (const ym of months.reverse()) {                    // 최근 달부터
    const f = path.join(DIR, ym + '.json');
    if (ym < CUR && fs.existsSync(f)) { try { if (JSON.parse(fs.readFileSync(f, 'utf8'))._done) { skipM++; continue; } } catch (e) {} }
    if (newM >= MAXM) break;
    const days = []; const y = Math.floor(ym / 100), m = ym % 100, dim = new Date(y, m, 0).getDate();
    let wi = 0; for (let d = 1; d <= dim; d++) { const wd = new Date(y, m - 1, d).getDay(); const key = ym * 100 + d; if (wd !== 0 && wd !== 6 && key <= today) { if (wi++ % STEP === 0) days.push(key); } }
    const agg = {}; let idx = 0, errs = 0, got = 0;
    const worker = async () => { while (idx < days.length) { const d = days[idx++]; try { const t = await getText(URL(d)); if (t && parseDay(t, agg) > 0) got++; } catch (e) { errs++; } await sleep(50); } };
    await Promise.all(Array.from({ length: CONC }, worker));
    totalDays += got; newM++;
    fs.writeFileSync(f, JSON.stringify({ _done: errs === 0 && ym < CUR && got > 0, days: got, d: agg }));
    if (errs || got === 0) failM++;
    doneM++; console.log(`공매도 받기 ${ym}: ${got}일 · 종목 ${Object.keys(agg).length}${errs ? ' · 실패 ' + errs + '일(다시 실행하면 이 달을 다시 받음)' : ''}  (${doneM + skipM}/${months.length}달)`);
  }
  console.log(`끝: 새로 ${newM}달 · 이미 있음 ${skipM}달 · 문제 있는 달 ${failM} · 받은 날 ${totalDays}` + (failM ? ' → 다시 실행하면 문제 있는 달만 이어서 받음' : ''));
})();
