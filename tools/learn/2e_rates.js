// 금리 자료(하루 단위, FRED) → data/rates.json  { YYYYMM: { tgt, dff, dgs2, dgs1, dgs10, dtb3, dtb6 } }  (각 달 "마지막 거래일" 값 = 그 달 말에 이미 알던 값)
//   tgt  = 연준 목표금리 상단 (DFEDTARU 2008-12~, 그 전은 단일 목표 DFEDTAR) — "기준금리" 자체
//   dff  = 실효 연방기금금리(하루)   dgs2·dgs1·dgs10 = 미국 국채 2년·1년·10년   dtb3·dtb6 = 3개월·6개월 단기국채
//   시장이 예상하는 금리 방향의 근사 = 국채 2년(또는 1년) − 실효금리: 양수면 시장이 앞으로 금리 인상을 반영(FedWatch 같은 선물 내재 확률의 과거 자료는 구하기 어려워 대신 씀)
//   월평균값(FEDFUNDS)은 달이 끝나야 확정되지만, 이 자료는 그 달 마지막 날 값이라 한 달 빨리 알 수 있음
const { fs, path, DATA, sleep } = require('./common');
const S = ['DFEDTARU', 'DFEDTAR', 'DFF', 'DGS2', 'DGS1', 'DGS10', 'DTB3', 'DTB6'];
async function csv(id) {
  for (let k = 0; k < 4; k++) {
    try {
      const r = await fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + id, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(60000) });
      if (r.ok) { const t = await r.text(); if (/^\D/.test(t)) return t; }
    } catch (e) {}
    await sleep(3000 * (k + 1));
  }
  return null;
}
(async () => {
  const last = {};                                              // 시리즈 → { ym: 그 달 마지막 값 }
  for (const id of S) {
    const t = await csv(id); if (!t) { console.log('받지 못함:', id); last[id] = {}; continue; }
    const m = {}; t.trim().split('\n').slice(1).forEach(l => { const [d, v] = l.split(','); if (v && v !== '.' && d.length >= 7) m[+(d.slice(0, 4) + d.slice(5, 7))] = +v; });   // 날짜순이라 덮어쓰면 마지막 값
    last[id] = m;
  }
  const yms = new Set(); Object.values(last).forEach(m => Object.keys(m).forEach(k => yms.add(+k)));
  const out = {};
  [...yms].sort().forEach(ym => {
    const o = {}; const tgt = last.DFEDTARU[ym] ?? last.DFEDTAR[ym];
    if (tgt !== undefined) o.tgt = tgt; if (last.DFF[ym] !== undefined) o.dff = last.DFF[ym];
    if (last.DGS10[ym] !== undefined) o.dgs10 = last.DGS10[ym]; if (last.DGS2[ym] !== undefined) o.dgs2 = last.DGS2[ym]; if (last.DGS1[ym] !== undefined) o.dgs1 = last.DGS1[ym];
    if (last.DTB3[ym] !== undefined) o.dtb3 = last.DTB3[ym]; if (last.DTB6[ym] !== undefined) o.dtb6 = last.DTB6[ym];
    if (Object.keys(o).length) out[ym] = o;
  });
  fs.writeFileSync(path.join(DATA, 'rates.json'), JSON.stringify(out));
  const ks = Object.keys(out).sort(); const f = k => out[k] || {};
  console.log(`금리 자료: ${ks[0]}~${ks[ks.length - 1]} ${ks.length}개월 → ${path.join(DATA, 'rates.json')}`);
  ks.slice(-6).forEach(k => console.log(k, JSON.stringify(out[k])));
})();
