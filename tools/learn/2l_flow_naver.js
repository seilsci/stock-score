// 네이버 수급(로그인 불필요)이 KRX 수급(로그인 필요, 2k_flow.js)과 같은 판단을 내리는지 비교 — 묶음 37 '엇갈린 종목만' 규칙을 사이트에서 자동으로 쓸 수 있나 확인용
//   네이버: m.stock.naver.com/api/stock/<코드>/trend?pageSize=30&bizdate=<다음 달 1일>  → 그 날짜 전 거래일들(일별 외국인·기관 순매수 '수량', 종가)
//   비교 대상: ① 실제 한국 거래(data/trades.json)의 확인 달(구매 전달)  ② 수급 파일에서 고른 무작위 (종목, 달) — 기본 300개
//   판단: 외국인 순매수 부호 · 기관 순매수 부호 · '같은 방향(둘 다 매수 또는 둘 다 매도 = 사지 않음)'. 네이버 쪽은 수량 합 부호와 (수량×종가) 합 부호 두 가지로 봄.
//   실행: node 2l_flow_naver.js    (NV_RAND=300 무작위 개수, NV_WAIT=250 요청 사이 ms, NV_FROM=201201 무작위 시작 달)  결과: data/flow_naver_cmp.txt
const { fs, path, DATA, sleep } = require('./common');
const DIR = path.join(DATA, 'krx_flow'), OUT = path.join(DATA, 'flow_naver_cmp.txt');
const WAIT = +process.env.NV_WAIT || 250, NR = process.env.NV_RAND == null ? 300 : +process.env.NV_RAND, FROM = +process.env.NV_FROM || 201201;
const num = s => +String(s == null ? '' : s).replace(/[,+%\s]/g, '') || 0;
const nextYm = ym => (ym % 100 === 12 ? ym + 89 : ym + 1), prevYm = ym => (ym % 100 === 1 ? ym - 89 : ym - 1);
const lines = []; const log = s => { console.log(s); lines.push(s); };
const KRX = new Map(); const krx = ym => { if (KRX.has(ym)) return KRX.get(ym); let v = null; try { const j = JSON.parse(fs.readFileSync(path.join(DIR, ym + '.json'), 'utf8')); if (j._done) v = j; } catch (e) {} KRX.set(ym, v); return v; };
let req = 0, fail = 0;
async function naver(code, ym) {                                              // 그 달 일별 수급 합(수량·금액 근사) — 실패하면 null
  const bd = String(nextYm(ym)) + '01';
  for (let t = 0; t < 3; t++) {
    try {
      req++; const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/trend?pageSize=30&bizdate=${bd}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
      if (r.status === 429 || r.status >= 500) { await sleep(WAIT * 8); continue; }
      if (!r.ok) { fail++; return null; }
      const a = (await r.json() || []).filter(x => String(x.bizdate).startsWith(String(ym)));
      if (!a.length) return null;
      let fq = 0, iq = 0, fv = 0, iv = 0; for (const x of a) { const p = num(x.closePrice), f = num(x.foreignerPureBuyQuant), i = num(x.organPureBuyQuant); fq += f; iq += i; fv += f * p; iv += i * p; }
      return { days: a.length, fq, iq, fv, iv };
    } catch (e) { await sleep(WAIT * 4); }
  }
  fail++; return null;
}
const sg = x => (x > 0 ? 1 : x < 0 ? -1 : 0);
const sameDir = (a, b) => (a > 0 && b > 0) || (a < 0 && b < 0);
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
(async () => {
  if (!fs.existsSync(DIR)) { console.log('data/krx_flow가 없음 → node 2k_flow.js 먼저'); return; }
  // ① 실제 한국 거래
  const pairs = []; let tj = null; try { tj = JSON.parse(fs.readFileSync(path.join(DATA, 'trades.json'), 'utf8')); } catch (e) {}
  const seen = new Set();
  (tj && tj.trades || []).filter(t => /\.(KS|KQ)$/.test(t.y) && t.buyYm).forEach(t => { const ym = prevYm(+t.buyYm), code = t.y.slice(0, 6), k = code + '|' + ym; if (!seen.has(k) && krx(ym)) { seen.add(k); pairs.push({ code, ym, src: '거래', name: t.name, ret: t.ret }); } });
  // ② 무작위 (종목, 달): 그 달 KRX 외국인 줄이 있는 종목 중에서
  const months = fs.readdirSync(DIR).map(f => +f.replace('.json', '')).filter(ym => ym >= FROM && krx(ym)).sort();
  const R = rng(20261127);
  for (let n = 0, guard = 0; n < NR && guard < NR * 20 && months.length; guard++) { const ym = months[Math.floor(R() * months.length)], j = krx(ym), cs = Object.keys(j.f || {}); if (!cs.length) continue; const code = cs[Math.floor(R() * cs.length)], k = code + '|' + ym; if (seen.has(k)) continue; seen.add(k); pairs.push({ code, ym, src: '무작위', name: (j.name || {})[code] || code }); n++; }
  console.log(`비교할 (종목, 달) ${pairs.length}개 (거래 ${pairs.filter(p => p.src === '거래').length} · 무작위 ${pairs.filter(p => p.src === '무작위').length}) — 요청 사이 ${WAIT}ms, 약 ${Math.ceil(pairs.length * (WAIT + 200) / 60000)}분`);
  const res = [];
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i], j = krx(p.ym), f = (j.f || {})[p.code], ii = (j.i || {})[p.code];
    const nv = await naver(p.code, p.ym); await sleep(WAIT);
    res.push({ ...p, kf: f ? f[1] : 0, ki: ii ? ii[1] : 0, kHas: !!(f || ii), nv });
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${pairs.length} (실패 ${fail})`);
  }
  log(`# 네이버 vs KRX 수급 비교 (${new Date().toISOString().slice(0, 10)}) — 요청 ${req}번 · 실패 ${fail}번`);
  const pct = (a, b) => (b ? (a / b * 100).toFixed(1) + '%' : '-');
  for (const src of ['거래', '무작위', '전체']) {
    const R2 = res.filter(r => (src === '전체' || r.src === src) && r.kHas && r.nv);
    const miss = res.filter(r => (src === '전체' || r.src === src) && !r.nv).length;
    if (!R2.length) { log(`## ${src}: 비교할 값 없음(네이버 못 받음 ${miss})`); continue; }
    const cnt = f => R2.filter(f).length;
    log(''); log(`## ${src} — 비교 ${R2.length}개 (네이버 자료 없음 ${miss}개)`);
    log('판단                                   네이버 수량 합   네이버 수량×종가 합');
    log(`외국인 순매수 부호 같음                  ${pct(cnt(r => sg(r.nv.fq) === sg(r.kf)), R2.length).padStart(8)}        ${pct(cnt(r => sg(r.nv.fv) === sg(r.kf)), R2.length).padStart(8)}`);
    log(`기관 순매수 부호 같음                    ${pct(cnt(r => sg(r.nv.iq) === sg(r.ki)), R2.length).padStart(8)}        ${pct(cnt(r => sg(r.nv.iv) === sg(r.ki)), R2.length).padStart(8)}`);
    log(`'같은 방향(사지 않음)' 판단 같음         ${pct(cnt(r => sameDir(r.nv.fq, r.nv.iq) === sameDir(r.kf, r.ki)), R2.length).padStart(8)}        ${pct(cnt(r => sameDir(r.nv.fv, r.nv.iv) === sameDir(r.kf, r.ki)), R2.length).padStart(8)}`);
    const kx = cnt(r => sameDir(r.kf, r.ki)), both = cnt(r => sameDir(r.kf, r.ki) && sameDir(r.nv.fv, r.nv.iv));
    log(`KRX가 '같은 방향'이라 뺀 ${kx}개 중 네이버(금액)도 뺌 ${both}개(${pct(both, kx)}) · KRX가 산 ${R2.length - kx}개 중 네이버가 잘못 뺌 ${cnt(r => !sameDir(r.kf, r.ki) && sameDir(r.nv.fv, r.nv.iv))}개`);
    const rel = R2.filter(r => Math.abs(r.kf) > 1e8).map(r => r.nv.fv / r.kf).sort((a, b) => a - b);
    if (rel.length) log(`외국인 순매수 금액 크기 비(네이버 수량×종가 ÷ KRX, KRX 1억 원 넘는 것 ${rel.length}개): 중앙값 ${rel[Math.floor(rel.length / 2)].toFixed(2)} · 10% ${rel[Math.floor(rel.length * 0.1)].toFixed(2)} · 90% ${rel[Math.floor(rel.length * 0.9)].toFixed(2)}`);
  }
  const bad = res.filter(r => r.kHas && r.nv && sameDir(r.nv.fv, r.nv.iv) !== sameDir(r.kf, r.ki));
  log(''); log(`## '같은 방향' 판단이 다른 경우 (${bad.length}개, 앞 15개) — KRX 외국인/기관 vs 네이버(수량×종가) 외국인/기관, 억 원`);
  const eok = x => (x / 1e8).toFixed(1);
  bad.slice(0, 15).forEach(r => log(`${r.src} ${r.ym} ${r.code} ${String(r.name).slice(0, 12).padEnd(12)} KRX ${eok(r.kf)}/${eok(r.ki)} · 네이버 ${eok(r.nv.fv)}/${eok(r.nv.iv)} (${r.nv.days}일)`));
  fs.writeFileSync(OUT, lines.join('\n') + '\n'); console.log('\n저장: ' + OUT);
})();
