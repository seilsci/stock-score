// 학습 자료 읽기 + 시험 연도별 "그때 알 수 있던 정답"만 쓰는 학습 세트 (미래 정보 새는 것 막기)
const { fs, path, DATA } = require('./common');
const MK = [3, 6, 9, 12, 18, 24, 36, 48, 60, 72, 96, 120];
function load() {
  const lines = fs.readFileSync(path.join(DATA, 'events.csv'), 'utf8').trim().split('\n');
  const head = lines[0].split(','), NH = head.indexOf('mk120') + 1, F = head.slice(NH);
  const L = lines.slice(1).map(l => {
    const p = l.split(',');
    return { y: p[0], ym: +p[1], hold: +p[3], t: p[5] === '' ? null : +p[5], exoff: p[6] === '' ? null : +p[6],
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
// 정답을 바꿔 끼운 학습 세트: labs[i]는 L[i]의 {t, exoff, mk}(strat.js). 시점 규칙은 trainSet과 같음(Y년 1월 1일에 알 수 있던 것만).
//  minAge: 아직 못 판 신호를 "그때까지 수익"으로 쓰는 최소 나이(달, 기본 12 = trainSet과 같음)
function trainSetL(L, labs, Y, minAge = 12) {
  const cut = (Y - 1) * 12 + 12, out = [];
  for (let i = 0; i < L.length; i++) {
    const r = L[i], l = labs[i]; if (!l) continue;
    const e = cut - (Math.floor(r.ym / 100) * 12 + r.ym % 100);
    if (e < 1) continue;
    let t = null;
    if (l.exoff !== null && l.exoff <= e) t = l.t;
    else if (e >= minAge) { for (let q = MK.length - 1; q >= 0; q--) if (MK[q] <= e && l.mk[q] !== null) { t = l.mk[q]; break; } }
    if (t !== null) out.push({ ym: r.ym, x: r.x, t, y: r.y });
  }
  return out;
}
// 비교할 모델들(6_check·7_backtest 공통)
function modelDefs(F) {
  const fi = n => F.indexOf(n), all = F.map((_, j) => j), MAC = all.filter(j => F[j].startsWith('m_'));
  const MKT = all.filter(j => F[j].startsWith('idx_') || F[j] === 'us');
  const PRICE = all.filter(j => !F[j].startsWith('m_') && !F[j].startsWith('f_')), STOCK = PRICE.filter(j => !MKT.includes(j));
  const MODELS = [
    { n: 'A 가격만(35)', cols: PRICE, lam: 1000 },
    { n: 'B 가격+거시 전부', cols: PRICE.concat(MAC), lam: 1000 },
    { n: 'C 가격+기준금리변화', cols: PRICE.concat([fi('m_ff_chg12')]), lam: 1000 },
    { n: 'D 시장 요소만(지수·거시)', cols: MKT.concat(MAC), lam: 1000 },
    { n: 'E 종목 요소만(달 평균 뺀 수익)', cols: STOCK, lam: 1000, demean: true },
    { n: 'F 가격35(달 평균 뺀 수익)', cols: PRICE, lam: 1000, demean: true }
  ];
  return { PRICE, MAC, MKT, STOCK, MODELS };
}
module.exports = { load, trainSet, trainSetL, MK, modelDefs };
