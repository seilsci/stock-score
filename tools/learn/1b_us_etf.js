// 미국 상장 ETF 목록 만들기 → tools/learn/us_etf.json (심볼·로이터 코드·이름·순자산(천 달러)). 네이버 미국 종목 목록에는 ETF가 없어서 후보 티커를 직접 두고 네이버 종목 정보로 확인
// 제외: 채권형·머니마켓·레버리지/인버스(음의 복리)·변동성(VIX) 상품 — 한국 ETF와 같은 기준. 원자재(금·원유·구리 등)·암호화폐·커버드콜·주식형은 포함
// 사용: node 1b_us_etf.js  (순자산은 매번 바뀌므로 가끔 다시 돌려 갱신. Code.gs의 US_ETF 상수도 같이 갱신: node 1b_us_etf.js --gs 로 붙여넣을 줄을 출력)
const fs = require('fs'), path = require('path');
const CAND = `SPY IVV VOO VTI QQQ QQQM VUG VTV IWM IWF IWD IJH IJR IVW IVE MDY VB VO VEA VWO IEFA IEMG EFA EEM VXUS ACWI VT IXUS SCHB SCHX SCHG SCHD SCHA SCHF SCHM SCHV SCHE SCHH SPLG SPYG SPYV SPYD RSP DIA OEF MGK MGV VYM VIG DGRO DVY HDV SDY NOBL VYMI VGT VHT VFH VDE VIS VCR VDC VPU VAW VNQ VOX XLK XLF XLV XLE XLI XLY XLP XLU XLB XLRE XLC SMH SOXX XSD IGV IBB XBI XHB XRT XME XOP OIH KRE KBE KIE IYR IYW IYF IYH IYE IYJ IYC IYK IYM IYG ITA ITB PPA XAR JETS SKYY CLOU WCLD HACK CIBR BUG ROBO BOTZ AIQ ARKK ARKG ARKQ ARKW ARKF ARKX TAN ICLN QCLN PBW LIT BATT URA URNM NLR REMX COPX GDX GDXJ SIL SILJ RING GLD IAU GLDM SGOL BAR OUNZ AAAU SLV SIVR PSLV PHYS PPLT PALL CPER DBC PDBC GSG USO BNO UNG UGA DBA CORN WEAT SOYB MOO VNM EWJ EWZ EWY EWT EWW EWC EWG EWU EWA EWH EWS EWI EWP EWQ EWL EWD EWN EZU FXI MCHI KWEB KTEC CQQQ ASHR INDA INDY EPI SMIN EIDO THD EPOL TUR ARGT ECH EZA EIS ILF GXC AAXJ DXJ HEDJ DBJP JPXN BBJP BBEU BBAX BBCA IEUR HEZU FEZ VGK IEV SPEU VPL VSS ISCF IDEV SCZ IQLT INTF EFV EFG EFAV USMV EFAV QUAL MTUM VLUE SIZE LRGF IWY IWB IWV IWN IWO IWS IWP IWR IWL IJJ IJK IJS IJT IVOO VIOO VBR VBK VOT VOE VV VXF IUSG IUSV ITOT IUSB IXN IXG IXJ IXC IXP IXU JEPI JEPQ DIVO QYLD XYLD RYLD QYLG NUSI SVOL SPYI QQQI JQUA JPST QDF DGRW SPHD SPLV SPHQ SPMO COWZ CALF AVUV AVLV AVUS AVDV DFAC DFAS DFAT DFIV DFAX DFUS DFEV DFAI DFAE DGS VTWO SPSM SPMD SPTM SPDW SPEM SPAB BLOK BITO IBIT FBTC GBTC ETHA ETHE FETH BITB ARKB HODL BTCO EZBC BRRR BITQ IGF IFRA GRID PAVE TOLZ NFRA FIW PHO CGW EVX FAN ACES SMOG PBD QCLN CNRG HYDR DRIV IDRV KARS CARZ ESPO HERO GAMR NERD BETZ PEJ IYT FDN IGM IGN IHI IHF PJP XPH PPH FBT GNOM IDNA ARKG XLG QQQJ QTEC FTEC FHLC FNCL FENY FIDU FDIS FSTA FUTY FMAT FREL FCOM VONG VONV VTHR VTV VTWV VTWG SCHP SCHO SCHR GUNR GNR MXI IGE FILL XES XOP PXE PXJ IEZ IEO FCG AMLP MLPX ENFR AMJ TPYP EMLP USAI QQQM SCHJ PSQ SH SDS SPXU SQQQ TQQQ UPRO SPXL SOXL SOXS TECL TECS FAS FAZ TNA TZA LABU LABD NUGT DUST JNUG JDST UCO SCO BOIL KOLD UVXY VXX SVXY VIXY TLT IEF SHY AGG BND LQD HYG JNK EMB MUB BIL SGOV SHV VCSH VCIT VCLT BSV BIV BLV GOVT TIP VTIP SCHZ MBB`.split(/\s+/);
const EXCL = /\b(2X|3X|-?1\.5X|-?2X|-?3X|Ultra|UltraPro|UltraShort|Bull|Bear|Inverse|Short|Leveraged|Bond|Bd|Bonds|Treasury|Treasuries|Aggregate|Municipal|Muni|Credit|Corporate|High Yield|Floating|Money Market|T-Bill|Mortgage|TIPS|Fixed Income|Government|Income Opportunities)\b|VIX|Volatility Premium|Short-Term Futures|0-3 Month|Ultra-Short|Short Term|Short-Term/i;
const UA = { 'User-Agent': 'Mozilla/5.0' };
const get = async u => { for (let i = 0; i < 3; i++) { try { const r = await fetch(u, { headers: UA }); if (r.status === 200) return await r.json(); if (r.status === 404 || r.status === 400) return null; } catch (e) {} await new Promise(r => setTimeout(r, 400)); } return null; };
(async () => {
  const seen = new Set(), out = [], skipped = [], miss = [], uniq = CAND.filter(x => !seen.has(x) && seen.add(x));
  let idx = 0;
  const one = async sym => {
    let d = null, rc = null;
    for (const suf of ['', '.O', '.K']) { d = await get(`https://api.stock.naver.com/stock/${sym}${suf}/basic`); if (d && d.reutersCode) { rc = d.reutersCode; break; } d = null; }
    if (!d) { miss.push(sym); return; }
    if (!(d.isEtf || d.stockEndType === 'etf')) { miss.push(sym + '(ETF 아님)'); return; }
    const aum = Math.round(+d.marketValueFullRaw / 1000) || 0, name = d.stockNameEng || d.stockName;      // 천 달러 단위(네이버 미국 종목 시총과 같은 단위)
    if (EXCL.test(name)) { skipped.push(sym + ' ' + name); return; }
    out.push({ y: sym, reuters: rc, name, cap: aum });
  };
  await Promise.all(Array.from({ length: 8 }, async () => { while (idx < uniq.length) await one(uniq[idx++]); }));
  out.sort((a, b) => b.cap - a.cap);
  fs.writeFileSync(path.join(__dirname, 'us_etf.json'), JSON.stringify({ made: new Date().toISOString().slice(0, 10), unit: '천 달러', etfs: out }, null, 0));
  console.log(`ETF ${out.length}개 저장(순자산 상위: ${out.slice(0, 8).map(x => x.y).join(' ')}), 이름으로 제외 ${skipped.length}개, 못 찾음/ETF 아님 ${miss.length}개`);
  console.log('제외:', skipped.join(' | '));
  console.log('못 찾음:', miss.join(' '));
  if (process.argv.includes('--gs')) console.log('var US_ETF = ' + JSON.stringify(out.filter(x => x.cap > 0).map(x => [x.y, x.reuters, x.name, x.cap])) + ';');
})();
