// 진행률 구간 계획 → run.sh가 eval 해서 B1~B7(각 단계 끝 지점 %)을 받음
// - 월봉을 새로 받아야 하는 종목이 많으면 받기에 큰 몫, 이미 있으면 거의 0
// - 나머지 단계는 지난 실행의 실측 시간(data/steptimes.txt) 비율로, 기록이 없으면 기본 비율로
const fs = require('fs'), path = require('path');
const D = process.env.DATA || 'data';
let need = 0;
try {
  JSON.parse(fs.readFileSync(path.join(D, 'lists.json'))).forEach(s => {
    if (!fs.existsSync(path.join(D, 'raw2', s.y.replace(/[^A-Za-z0-9.\-]/g, '_') + '.json'))) need++;
  });
} catch (e) { need = 9999; }
let needFd = 0;
try {
  JSON.parse(fs.readFileSync(path.join(D, 'lists.json'))).forEach(s => {
    if (!fs.existsSync(path.join(D, 'first', s.y.replace(/[^A-Za-z0-9.\-]/g, '_') + '.json'))) needFd++;
  });
} catch (e) { needFd = 9999; }
const names = ['build', 'train', 'explore', 'check', 'backtest'];
let w = { build: 4, train: 4, explore: 70, check: 7, backtest: 15 };          // 기본 비율(실측 기준 어림값)
try {
  const h = {};
  fs.readFileSync(path.join(D, 'steptimes.txt'), 'utf8').trim().split('\n').forEach(l => { const [k, v] = l.split(' '); h[k] = Math.max(1, +v); });
  if (names.every(k => h[k])) w = h;
} catch (e) {}
const dl = need > 200 ? 45 : 1;                    // 받기 몫(%)
const fdShare = needFd > 200 ? 20 : 1;               // 첫날 가격 받기 몫(%)
const head = 1 + dl + fdShare + 1;                           // 목록 1 + 받기 + 거시 1
const tot = names.reduce((s, k) => s + w[k], 0);
let acc = 1, out = { B1: 1 }, i = 2;
acc += dl; out.B2 = acc; acc += fdShare; out.B2c = acc; acc += 1; out.B3 = acc;
names.forEach((k, j) => { acc += (100 - head) * w[k] / tot; out['B' + (4 + j)] = j === names.length - 1 ? 100 : Math.round(acc * 10) / 10; });
console.log(Object.entries(out).map(([k, v]) => `${k}=${v}`).join('\n'));
