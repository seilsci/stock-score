// 한국 수급(외국인·기관 순매수 금액) 읽기 — 매매일지·장부의 '외국인·기관 같은 방향이면 안 삼' 규칙(묶음 35~38, 2026-11-27 채택)
//   자료: data/krx_flow/<YYYYMM>.json(KRX, 2k_flow.js, 로그인 필요) 먼저, 없는 달은 data/nv_flow/<YYYYMM>.json(네이버, 2m_flow_naver.js, 로그인 불필요)
//   same(코드6자리, YYYYMM) → true(둘 다 순매수 또는 둘 다 순매도 = 사지 않음) / false / null(자료 없음 = 그대로 삼)
const fs = require('fs'), path = require('path');
function load(DATA) {
  const C = new Map();
  const month = ym => {
    if (C.has(ym)) return C.get(ym);
    let v = null;
    try { const j = JSON.parse(fs.readFileSync(path.join(DATA, 'krx_flow', ym + '.json'), 'utf8')); if (j._done) v = { src: 'krx', get: c => { const f = (j.f || {})[c], i = (j.i || {})[c]; return f || i ? [f ? f[1] : 0, i ? i[1] : 0] : null; } }; } catch (e) {}
    if (!v) try { const j = JSON.parse(fs.readFileSync(path.join(DATA, 'nv_flow', ym + '.json'), 'utf8')); v = { src: 'naver', get: c => { const a = (j.d || {})[c]; return a ? [a[0], a[1]] : null; } }; } catch (e) {}
    C.set(ym, v); return v;
  };
  const pair = (code, ym) => { const m = month(+ym); return m ? m.get(String(code)) : null; };
  const same = (code, ym) => { const a = pair(code, ym); if (!a) return null; return (a[0] > 0 && a[1] > 0) || (a[0] < 0 && a[1] < 0); };
  return { same, pair, src: ym => (month(+ym) || {}).src || null };
}
module.exports = { load };
