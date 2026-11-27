// KRX 수급 파일(data/krx_flow, 로그인 필요)이 없는 최근 달을 네이버(로그인 불필요)로 채움 → data/nv_flow/<YYYYMM>.json {_done, d:{코드:[외국인 순매수 금액, 기관 순매수 금액, 거래일 수]}}
//   금액 = 일별 순매수 수량 × 그날 종가의 합(묶음 38: KRX 금액과 '같은 방향' 판단 일치 97~99%). 대상 = data/lists.json의 한국 종목.
//   채우는 달: KRX 마지막 달 다음 ~ 지난달(이번 달은 진행 중이라 제외). 이미 _done인 달은 건너뜀. stock_learn(run.sh)이 받기 단계에서 실행.
//   NV_FROM=YYYYMM 으로 시작 달 지정 가능, NV_CONC=8 동시 요청 수
const { fs, path, DATA, pool, sleep, progress } = require('./common');
const KD = path.join(DATA, 'krx_flow'), ND = path.join(DATA, 'nv_flow'); fs.mkdirSync(ND, { recursive: true });
const nextYm = ym => (ym % 100 === 12 ? ym + 89 : ym + 1);
const num = s => +String(s == null ? '' : s).replace(/[,+%\s]/g, '') || 0;
(async () => {
  const now = new Date(), CUR = now.getFullYear() * 100 + now.getMonth() + 1;
  let lastK = 0; try { fs.readdirSync(KD).forEach(f => { const ym = +f.replace('.json', ''); try { if (JSON.parse(fs.readFileSync(path.join(KD, f), 'utf8'))._done && ym > lastK) lastK = ym; } catch (e) {} }); } catch (e) {}
  let from = +process.env.NV_FROM || (lastK ? nextYm(lastK) : 0);
  if (!from) { const d = new Date(now.getFullYear(), now.getMonth() - 1, 1); from = d.getFullYear() * 100 + d.getMonth() + 1; }
  const months = []; for (let ym = from; ym < CUR; ym = nextYm(ym)) { let done = false; try { done = JSON.parse(fs.readFileSync(path.join(ND, ym + '.json'), 'utf8'))._done; } catch (e) {} if (!done) months.push(ym); }
  if (!months.length) { console.log(`네이버 수급: 채울 달 없음(KRX 마지막 ${lastK || '-'}, 이미 받은 달 포함)`); return; }
  let codes = []; try { codes = JSON.parse(fs.readFileSync(path.join(DATA, 'lists.json'), 'utf8')).filter(s => /\.(KS|KQ)$/.test(s.y)).map(s => s.y.slice(0, 6)); } catch (e) {}
  codes = [...new Set(codes)];
  console.log(`네이버 수급 받기: ${months.join(',')} · 한국 ${codes.length}종목`);
  for (const ym of months) {
    const d = {}; let fail = 0, empty = 0;
    await pool(codes, +process.env.NV_CONC || 8, async code => {
      for (let t = 0; t < 3; t++) {
        try {
          const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/trend?pageSize=30&bizdate=${nextYm(ym)}01`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
          if (r.status === 429 || r.status >= 500) { await sleep(2000 * (t + 1)); continue; }
          if (!r.ok) { empty++; return; }
          const a = (await r.json() || []).filter(x => String(x.bizdate).startsWith(String(ym)));
          if (!a.length) { empty++; return; }
          let fv = 0, iv = 0; for (const x of a) { const p = num(x.closePrice); fv += num(x.foreignerPureBuyQuant) * p; iv += num(x.organPureBuyQuant) * p; }
          d[code] = [Math.round(fv), Math.round(iv), a.length]; return;
        } catch (e) { await sleep(1000 * (t + 1)); }
      }
      fail++;
    }, '네이버 수급 ' + ym);
    const ok = Object.keys(d).length, isDone = fail <= Math.max(5, codes.length * 0.01);
    fs.writeFileSync(path.join(ND, ym + '.json'), JSON.stringify({ _done: isDone, d }));
    console.log(`${isDone ? '✓' : '△'} ${ym}: ${ok}종목 · 자료 없음 ${empty} · 실패 ${fail}` + (isDone ? '' : ' (실패가 많아 다음 실행 때 다시 받음)'));
  }
})();
