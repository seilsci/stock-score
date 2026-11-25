// 종목 검색(매매일지 '내 체결 내역' 자동완성)용 목록: data/lists.json → tools/symbols.json  ([코드, 이름, 시장, 0=주식·1=ETF 등], 시총 큰 순)
const fs = require('fs'), path = require('path');
const l = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'lists.json'), 'utf8'));
l.sort((a, b) => (b.cap || 0) - (a.cap || 0));
const out = l.filter(x => x.code && x.name).map(x => [x.code, x.name, x.mk, x.type === 'stock' ? 0 : 1]);
fs.writeFileSync(path.join(__dirname, '..', 'symbols.json'), JSON.stringify(out));
console.log('symbols.json', out.length, '종목');
