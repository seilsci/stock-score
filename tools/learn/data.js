// 학습 자료 읽기 + 시험 연도별 "그때 알 수 있던 정답"만 쓰는 학습 세트 (미래 정보 새는 것 막기)
const { fs, path, DATA } = require('./common');
const MK = [3, 6, 9, 12, 18, 24, 36, 48, 60, 72, 96, 120];
function load() {
  const lines = fs.readFileSync(path.join(DATA, 'events.csv'), 'utf8').trim().split('\n');
  const head = lines[0].split(','), NH = head.indexOf('mk120') + 1, F = head.slice(NH);
  const L = lines.slice(1).map(l => {
    const p = l.split(',');
    return { ym: +p[1], hold: +p[3], t: p[5] === '' ? null : +p[5], exoff: p[6] === '' ? null : +p[6],
             mk: p.slice(7, 7 + MK.length).map(v => v === '' ? null : +v), x: p.slice(NH).map(v => v === '' ? NaN : +v) };
  });
  return { F, L, MK };
}
// Y년 1월 1일에 알 수 있던 것만: 이미 매도했으면 매도 수익, 아직 보유 중이면 12개월 이상 된 것만 "그때까지" 수익
function trainSet(L, Y) {
  const cut = (Y - 1) * 12 + 12, out = [];
  for (const r of L) {
    const e = cut - (Math.floor(r.ym / 100) * 12 + r.ym % 100);
    if (e < 1) continue;
    let t = null;
    if (r.exoff !== null && r.exoff <= e) t = r.t;
    else if (e >= 12) { for (let q = MK.length - 1; q >= 0; q--) if (MK[q] <= e && r.mk[q] !== null) { t = r.mk[q]; break; } }
    if (t !== null) out.push({ ym: r.ym, x: r.x, t });
  }
  return out;
}
module.exports = { load, trainSet, MK };
