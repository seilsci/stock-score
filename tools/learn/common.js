// 공통: 받기·저장·월봉 정리
const fs = require('fs'), path = require('path');
const DATA = process.env.DATA || path.join(__dirname, 'data');
fs.mkdirSync(path.join(DATA, 'raw'), { recursive: true });
const UA = { 'User-Agent': 'Mozilla/5.0' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, tries = 4) {
  let err;
  for (let k = 0; k < tries; k++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
      if (r.status === 404) return null;
      if (r.status === 429) { await sleep(5000 * (k + 1)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { err = e; await sleep(1000 * (k + 1)); }
  }
  throw err || new Error('429 too many');
}

// 전체 진행률: run.sh가 넘겨준 T0(시작 시각), 이 단계의 구간 PFROM~PTO(%)
const T0 = +process.env.T0 * 1000 || Date.now();
const hhmm = t => new Date(t).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });
function progress(label, frac) {
  const from = +process.env.PFROM || 0, to = +process.env.PTO || 100;
  const p = from + (to - from) * Math.min(1, frac), el = Date.now() - T0;
  const eta = p > 0.5 ? hhmm(T0 + el * 100 / p) : '계산 중';
  process.stdout.write(`\r${label} 진행중 · ${p.toFixed(1)}% 완료 · 경과 ${Math.round(el / 60000)}분 · 100% 예상 ${eta}     `);
}

// 동시에 n개씩 돌리기
async function pool(items, n, fn, label) {
  let i = 0, done = 0;
  async function worker() {
    while (i < items.length) {
      const k = i++;
      try { await fn(items[k], k); } catch (e) { /* 기록은 fn 안에서 */ }
      done++;
      if (label && (done % 20 === 0 || done === items.length)) progress(label, done / items.length);
    }
  }
  await Promise.all(Array.from({ length: n }, worker));
  if (label) process.stdout.write('\n');
}

// 야후 월봉 → [[YYYYMM,시가,고가,저가,종가,거래량],...]  (월봉 + '오늘 하루치' 점 합치기)
function yahooMonthly(j) {
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp) return null;
  const off = (r.meta.gmtoffset || 0) + 6 * 3600, q = r.indicators.quote[0];
  const by = new Map();
  r.timestamp.forEach((t, i) => {
    const c = q.close[i];
    if (c == null) return;
    const d = new Date((t + off) * 1000);
    const ym = d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;
    const o = q.open[i] || null, h = q.high[i] || null, l = q.low[i] || null, v = q.volume[i] || 0;
    const p = by.get(ym);
    by.set(ym, p ? [ym, p[1] || o, Math.max(p[2] || 0, h || 0) || null,
                    Math.min(p[3] || Infinity, l || Infinity) === Infinity ? null : Math.min(p[3] || Infinity, l || Infinity),
                    c, Math.max(p[5], v)]
                 : [ym, o, h, l, c, v]);
  });
  return [...by.values()].sort((a, b) => a[0] - b[0]).map(x => {
    const c = x[4], o = x[1] || c;
    return [x[0], o, Math.max(x[2] || 0, o, c), Math.min(x[3] || Infinity, o, c), c, x[5]];
  });
}

module.exports = { fs, path, DATA, getJSON, pool, sleep, yahooMonthly, progress };
