// 업종 코드(미국): SEC 제출 정보의 SIC(표준산업분류) → data/sic.json  { 종목: { sic: "3674", d: "Semiconductors..." } }
//   종목 목록 = data/sec/<종목>.json(2d_sec.js가 받은 파일)에 들어 있는 CIK. 그래서 2d_sec.js를 먼저 돌려 둬야 함(이미 받았으면 그대로).
//   키 없음, SEC 규칙대로 초당 10건 이하·머리말(SEC_UA 환경변수로 연락처). 이미 받은 종목은 건너뜀(이어받기). 약 1,900종목 · 5분 안팎.
//   한계: 지금 시점의 업종(과거 업종 변화는 반영 못 함). 한국 종목은 아직 없음.
const { fs, path, DATA, sleep } = require('./common');
const UA = process.env.SEC_UA || 'stock-score-research (personal research, no commercial use)';
const OUT = path.join(DATA, 'sic.json'), DIR = path.join(DATA, 'sec');
(async () => {
  let res = {}; try { res = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}
  const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter(f => f.endsWith('.json')) : [];
  let ok = 0, skip = 0, none = 0, fail = 0, i = 0;
  for (const f of files) {
    const y = f.replace(/\.json$/, '');
    if (res[y]) { skip++; continue; }
    let cik; try { cik = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')).cik; } catch (e) {}
    if (!cik) { none++; continue; }
    try {
      let j = null;
      for (let t = 0; t < 4; t++) {
        try {
          const r = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(40000) });
          if (r.status === 404) break;
          if (r.status === 403 || r.status === 429) { await sleep(8000 * (t + 1)); continue; }
          if (!r.ok) throw new Error('HTTP ' + r.status);
          j = await r.json(); break;
        } catch (e) { await sleep(1500 * (t + 1)); if (t === 3) throw e; }
      }
      if (j && j.sic) { res[y] = { sic: String(j.sic), d: String(j.sicDescription || '') }; ok++; } else none++;
    } catch (e) { fail++; }
    if (++i % 100 === 0) { fs.writeFileSync(OUT, JSON.stringify(res)); console.log(`업종 받기 ${i}/${files.length - skip} (새로 ${ok}, 없음 ${none}, 실패 ${fail})`); }
    await sleep(130);
  }
  fs.writeFileSync(OUT, JSON.stringify(res));
  console.log(`업종(SEC SIC): 새로 ${ok}, 이미 있음 ${skip}, 자료 없음 ${none}, 실패 ${fail}` + (fail ? ' → 다시 실행하면 실패한 것만 이어서 받음' : ''));
})();
