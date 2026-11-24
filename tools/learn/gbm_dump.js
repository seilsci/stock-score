// events.csv의 각 신호에 실제 규칙(첫날 진입) 정답을 붙여 CSV로 저장 (파이썬 모델 실험용)
//   사용: node gbm_dump.js data/ev_all.csv   →   python3 gbm_export.py data   →   data/ext_scores.csv (7_backtest.js가 '9 외부 모델'로 비교)
const { load } = require('./data');
const SL = require('./strat');
const { F, L } = load(); const now = new Date(), CUR = now.getFullYear() * 100 + now.getMonth() + 1, END = SL.mi(CUR) - 1;
const opts = { fd: { entry: 'fd', tp: 2, grace: 2, rate: true }, me: { entry: 'me', tp: 2, grace: 2, rate: true } };
const rows = ['y,ym,t_orig,exoff_orig,t_fd,exoff_fd,t12_fd,t_me,t12_me,' + F.join(',')];
for (const r of L) {
  const a = SL.label(r.y, r.ym, opts.fd, END), b = SL.label(r.y, r.ym, opts.me, END);
  const f = (l) => !l ? ['', '', ''] : [l.t ?? '', l.exoff ?? '', (l.exoff !== null ? l.t : l.mk[3]) ?? ''];
  const fa = f(a), fb = f(b);
  rows.push([r.y, r.ym, r.t ?? '', r.exoff ?? '', fa[0], fa[1], fa[2], fb[0], fb[2]].concat(r.x.map(v => Number.isFinite(v) ? v : '')).join(','));
}
require('fs').writeFileSync(process.argv[2], rows.join('\n'));
console.log(rows.length);
