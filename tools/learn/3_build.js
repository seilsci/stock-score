// 2·3단계: 과거 매수 신호 전부 찾기 + 정답(12개월 유지) + 후보 지표 → data/events.csv
const { fs, path, DATA, progress } = require('./common');
const list = JSON.parse(fs.readFileSync(path.join(DATA, 'lists.json')));
const load = y => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'raw', y.replace(/[^A-Za-z0-9.\-]/g, '_') + '.json'))); } catch (e) { return null; } };
const now = new Date(), CUR = now.getFullYear() * 100 + now.getMonth() + 1;   // 이번 달(진행 중)
const HOLD = 12;
// 학습 시작: 버냉키 첫 양적완화(QE1, 2008-11-25 발표) 이후 신호만. 이전 시장은 성격이 다름
const MIN_YM = +process.env.MIN_YM || 200812;

// 지수: 월 → {위, 기울기, 12개월 수익}
function indexInfo(y) {
  const b = load(y) || [], c = b.map(x => x[4]), out = new Map();
  for (let i = 12; i < b.length; i++) {
    const ma = avg(c, i - 9, i), ma3 = avg(c, i - 12, i - 3);
    out.set(b[i][0], { above: c[i] > ma ? 1 : 0, slope: ma / ma3 - 1, ret12: c[i] / c[i - 12] - 1 });
  }
  return out;
}
function avg(a, s, e) { let t = 0; for (let k = s; k <= e; k++) t += a[k]; return t / (e - s + 1); }
const IDX = { KOSPI: indexInfo('^KS11'), KOSDAQ: indexInfo('^KQ11'), US: indexInfo('^GSPC') };

const F = ['gap', 'slope1', 'slope3', 'cross24', 'below', 'above24', 'c_ma12', 'ma10_ma24', 'vol', 'vol3',
           'body', 'upwick', 'lowwick', 'range', 'ret1', 'ret3', 'ret12', 'high24', 'dd36', 'volat12',
           'idx_above', 'idx_slope', 'idx_ret12', 'us', 'etf'];
const rows = [];
let nEv = 0, ns = 0;
for (const s of list) {
  if (++ns % 100 === 0) progress('신호·지표 만들기', ns / list.length);
  let b = load(s.y);
  if (!b || b.length < 30) continue;
  b = b.filter(x => x[4] > 0);
  const c = b.map(x => x[4]), n = b.length;
  const ma = c.map((_, i) => i >= 9 ? avg(c, i - 9, i) : null);
  const above = c.map((x, i) => ma[i] == null ? null : x > ma[i]);
  for (let i = 25; i < n; i++) {
    if (b[i][0] < MIN_YM) continue;
    if (!(c[i - 1] <= ma[i - 1] && c[i] > ma[i])) continue;           // 매수 신호
    const [ym, o, h, l, , v] = b[i];
    if (!v) continue;                                                  // 거래 없는 달 제외
    // 정답: 다음 12개월 월말 종가가 모두 10이평 위 (이번 달은 아직 안 끝났으니 제외)
    let label = '', hold = 0, exitRet = '';
    let lastDone = n - 1; if (b[n - 1][0] >= CUR) lastDone = n - 2;
    for (let j = i + 1; j <= lastDone; j++) { if (above[j]) hold++; else { exitRet = c[j] / c[i] - 1; break; } }
    if (i + HOLD <= lastDone) label = hold >= HOLD ? 1 : 0;
    else if (exitRet !== '') label = 0;                                // 12개월 전에 이미 깨짐
    // 지표
    let cross = 0, ab = 0, below = 0;
    for (let k = i - 24; k < i; k++) { if (above[k] !== above[k - 1]) cross++; if (above[k]) ab++; }
    for (let k = i - 1; k >= 0 && above[k] === false; k--) below++;
    const vAvg = avg(b.map(x => x[5]), i - 12, i - 1) || 1;
    const v3 = avg(b.map(x => x[5]), i - 2, i), v12 = avg(b.map(x => x[5]), i - 14, i - 3) || 1;
    const hi24 = Math.max(...b.slice(i - 24, i).map(x => x[2])), hi36 = Math.max(...b.slice(Math.max(0, i - 36), i).map(x => x[2]));
    const lr = []; for (let k = i - 11; k <= i; k++) lr.push(Math.log(c[k] / c[k - 1]));
    const m = avg(lr, 0, 11), volat = Math.sqrt(lr.reduce((t, x) => t + (x - m) ** 2, 0) / 12);
    const ma12 = avg(c, i - 11, i), ma24 = avg(c, i - 23, i);
    const ix = IDX[s.mk === 'US' ? 'US' : s.mk].get(ym) || { above: '', slope: '', ret12: '' };
    const hl = h - l || 1;
    const f = {
      gap: c[i] / ma[i] - 1, slope1: ma[i] / ma[i - 1] - 1, slope3: ma[i] / ma[i - 3] - 1,
      cross24: cross, below, above24: ab / 24, c_ma12: c[i] / ma12 - 1, ma10_ma24: ma[i] / ma24 - 1,
      vol: Math.log((v + 1) / (vAvg + 1)), vol3: Math.log((v3 + 1) / (v12 + 1)),
      body: (c[i] - o) / o, upwick: (h - Math.max(o, c[i])) / hl, lowwick: (Math.min(o, c[i]) - l) / hl, range: hl / o,
      ret1: c[i] / c[i - 1] - 1, ret3: c[i] / c[i - 3] - 1, ret12: c[i] / c[i - 12] - 1,
      high24: c[i] / hi24 - 1, dd36: c[i] / hi36 - 1, volat12: volat,
      idx_above: ix.above, idx_slope: ix.slope, idx_ret12: ix.ret12,
      us: s.mk === 'US' ? 1 : 0, etf: s.type === 'stock' ? 0 : 1
    };
    rows.push([s.y, ym, label, hold, exitRet === '' ? '' : exitRet.toFixed(4)].concat(F.map(k => f[k] === '' ? '' : +(+f[k]).toFixed(5))).join(','));
    nEv++;
  }
}
fs.writeFileSync(path.join(DATA, 'events.csv'), ['y,ym,label,hold,exitret,' + F.join(',')].concat(rows).join('\n'));
const lab = rows.filter(r => r.split(',')[2] !== ''), good = lab.filter(r => r.split(',')[2] === '1');
progress('신호·지표 만들기', 1);
console.log(`\n매수 신호 ${nEv}건 (정답 있는 것 ${lab.length}건, 그중 12개월 유지 ${good.length}건 = ${(good.length / lab.length * 100).toFixed(1)}%)`);
