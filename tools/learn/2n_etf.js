// 채권·금 ETF 월봉(야후 수정종가=배당 포함) → $DATA/etf/<심볼>.json  [월, 시가, 고가, 저가, 수정종가, 거래량]. 묶음 47용.
const fs = require('fs'), path = require('path');
const DATA = process.env.DATA || path.join(__dirname, 'data');
const out = path.join(DATA, 'etf'); fs.mkdirSync(out, { recursive: true });
const UA = { 'User-Agent': 'Mozilla/5.0' }, sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  for (const s of (process.argv.slice(2).length ? process.argv.slice(2) : ['TLT', 'IEF', 'SHY', 'AGG', 'GLD'])) {
    const f = path.join(out, s + '.json'); if (fs.existsSync(f) && fs.statSync(f).size > 1000) { console.log(s, '이미 있음'); continue; }
    let ok = false;
    for (const host of ['query1', 'query2']) for (let k = 0; k < 4 && !ok; k++) {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${s}?period1=946684800&period2=1795000000&interval=1mo`, { headers: UA });
      if (r.status === 429) { await sleep(4000 * (k + 1)); continue; }
      if (!r.ok) break;
      const c = (await r.json()).chart.result[0], t = c.timestamp, q = c.indicators.quote[0], adj = (c.indicators.adjclose || [{}])[0].adjclose;
      const rows = t.map((ts, i) => { const d = new Date(ts * 1000 + 9 * 3600e3); return [d.getUTCFullYear() * 100 + d.getUTCMonth() + 1, q.open[i], q.high[i], q.low[i], adj && adj[i] != null ? adj[i] : q.close[i], q.volume[i]]; }).filter(x => x[4] > 0);
      fs.writeFileSync(f, JSON.stringify(rows)); console.log(s, rows.length, rows[0][0], '~', rows[rows.length - 1][0]); ok = true;
    }
    if (!ok) console.log(s, '받기 실패'); await sleep(1500);
  }
})();
