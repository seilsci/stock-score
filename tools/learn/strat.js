// 3단계: "정답"을 실제 판매 규칙으로 계산한 수익으로 바꾸기 위한 도구 (7_backtest.js가 씀)
//  events.csv의 정답(tgt)은 "처음 10이평 아래로 내려갈 때까지의 수익"이라 실제 판매 규칙(2배 트레일·유예·금리)과 다름.
//  여기서는 신호마다 실제 규칙으로 팔았다면의 수익을 월봉(+첫날 가격)으로 다시 계산한다. 학습에 쓰는 정보는 data.js trainSetL이 시점별로 거름.
//  규칙(opt): tp(익절 배수, 0이면 없음) · grace(유예 달 수) · rate(금리 상승 중이면 유예 없이 즉시) · entry('fd': 다음 달 첫날 종가, 'me': 신호 달 월말 종가)
//  시뮬레이션(7_backtest.js simulate)의 판매 순서와 같게: 월말마다 ① tpTrail ② 유예(10이평 아래 연속 grace달, 금리 상승 중이면 1달)
const { fs, path, DATA, RAW } = require('./common');
const MK = [3, 6, 9, 12, 18, 24, 36, 48, 60, 72, 96, 120];
const mi = ym => Math.floor(ym / 100) * 12 + ym % 100, ymOf = k => Math.floor((k - 1) / 12) * 100 + (k - 1) % 12 + 1;
const key = y => y.replace(/[^A-Za-z0-9.\-]/g, '_') + '.json';
const PX = new Map(), FDM = new Map();
function monthly(y) {
  let m = PX.get(y); if (m) return m;
  m = new Map(); try { JSON.parse(fs.readFileSync(path.join(RAW, key(y)))).forEach(b => { if (b[4] > 0) m.set(mi(b[0]), b[4]); }); } catch (e) {}
  PX.set(y, m); return m;
}
function firstDay(y, k) {
  let m = FDM.get(y);
  if (!m) { m = new Map(); try { JSON.parse(fs.readFileSync(path.join(DATA, 'first', key(y)))).forEach(b => { if (b[2] > 0) m.set(mi(b[0]), b[2]); }); } catch (e) {} FDM.set(y, m); }
  return m.get(k);
}
let MACRO = {}; try { MACRO = JSON.parse(fs.readFileSync(path.join(DATA, 'macro.json'))); } catch (e) {}
const ffUp = k => { const m = MACRO[ymOf(k)]; return !!(m && m.ff_chg12 != null && m.ff_chg12 > 0); };
const MAN = +process.env.MA_N || 10;                                  // 이동평균 길이(달), 3_build.js와 같게
const ma10 = (o, k) => { let s = 0; for (let j = k; j > k - MAN; j--) { const p = o.get(j); if (p === undefined) return null; s += p; } return s / MAN; };

// 신호 하나의 결과: { t: 판 수익 log(1+r) | null(아직 보유·자료 끝), exoff: 신호 달부터 판 달까지 달 수 | null, mk: [k달 시점 수익(판 뒤엔 판 수익)], px0: 진입가 } 또는 null(진입가 없음)
function label(y, ym, opt, END) {
  const o = monthly(y), i0 = mi(ym);
  const p0 = opt.entry === 'fd' ? firstDay(y, i0 + 1) : o.get(i0);
  if (!(p0 > 0)) return null;
  let exoff = null, t = null, trig = false, cnt = 0;
  for (let j = i0 + 1; j <= END; j++) {
    const p = o.get(j); if (p === undefined) break;                   // 거래 자료가 끊기면 더 모름
    const ma = ma10(o, j);
    if (ma) {
      if (opt.tp) {
        if (p >= opt.tp * ma) trig = true;
        else if (trig) { exoff = j - i0; t = Math.log(p / p0); break; }
      }
      if (opt.grace) {
        if (p < ma) {
          cnt++;
          const n = (opt.rate && ffUp(j)) ? 1 : opt.grace;
          if (cnt >= n) { exoff = j - i0; t = Math.log(p / p0); break; }
        } else cnt = 0;
      } else if (p < ma) { exoff = j - i0; t = Math.log(p / p0); break; }   // 유예 없음: 10이평 아래면 바로
    }
  }
  const mk = MK.map(K => {
    if (exoff !== null && exoff <= K) return t;
    const p = o.get(i0 + K); return i0 + K <= END && p > 0 ? Math.log(p / p0) : null;
  });
  return { t, exoff, mk, p0 };
}
module.exports = { label, MK, mi, ymOf };
