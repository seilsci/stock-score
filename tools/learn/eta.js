// 실행 시간 예상(run.sh·exp.sh가 부름): data/runtimes.txt의 같은 곳(pc/cloud) 지난 실측만 써서 예상 시간(초)을 출력
//   node eta.js exp <pc|cloud> <묶음 번호>      → 그 묶음의 예상 초(최근 3번 중앙값, 기록 없으면 70)
//   node eta.js learn <pc|cloud> <월봉 새로 받을 종목 수>  → 학습 전체 예상 초(받기 제외 시간의 중앙값 + 받아야 할 때만 지난 받기 시간), 기록 없으면 빈 값
const fs = require('fs'), path = require('path');
const [, , kind, where, arg] = process.argv;
const file = path.join(process.env.DATA || 'data', 'runtimes.txt');
let lines = []; try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch (e) {}
const rows = lines.filter(l => l.includes(` ${kind}@${where} `)).map(l => { const o = {}; l.split(' ').forEach(t => { const m = t.match(/^([a-z0-9]+)=(\d+)$/); if (m) o[m[1]] = +m[2]; }); return o; });
const med = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
if (kind === 'exp') {
  const v = rows.slice(-3).map(r => r['b' + arg]).filter(x => x > 0);
  // 기록이 없는 묶음의 기본값(PC 실측·추정, 초): 옛 기간(44~48·144~147)은 자료가 이미 있을 때의 값, 61은 events를 두 번 만드는 값
  const DEF = { 15: 1050, 28: 2400, 44: 150, 45: 45, 46: 45, 47: 45, 48: 60, 61: 420, 144: 75, 145: 45, 146: 45, 147: 45, 59: 670, 56: 55, 60: 50 };
  console.log(Math.round(med(v) || DEF[+arg] || 70));
} else if (kind === 'learn') {
  const full = rows.filter(r => !r.limit && r.total > 0).slice(-5);
  if (!full.length) { console.log(''); process.exit(0); }
  const base = med(full.map(r => r.total - (r.download || 0)));
  const dl = +arg > 200 ? (med(full.map(r => r.download || 0).filter(x => x > 300)) || 0) : 0;
  console.log(Math.round(base + dl));
}
