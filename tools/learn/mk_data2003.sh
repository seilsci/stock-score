#!/usr/bin/env bash
# 옛 기간(2005~) 시험용 자료 폴더 data_2003 만들기 — 묶음 44~48이 씀. 이미 있으면 건너뜀(지우고 다시 만들려면 rm -rf data_2003).
# 지금 data/ 의 월봉(raw2, 2000년부터)·환율·금리·수급을 복사하고, 신호(MIN_YM=200301)·첫날 가격(FD_P1=2003-01)·지수(BENCH_FROM=200301)를 옛 기간까지 다시 만듦.
cd "$(dirname "$0")" || exit 1
D=$PWD/data_2003
if [ -f "$D/events.csv" ] && [ -f "$D/bars.json" ] && [ -d "$D/first" ] && [ -d "$D/etf" ]; then echo "data_2003 이미 있음"; exit 0; fi
mkdir -p "$D"
for f in lists.json macro.json rates.json fx.json; do [ -f data/$f ] && cp -n data/$f "$D/"; done
for d in raw2 macro krx_flow nv_flow; do [ -d data/$d ] && [ ! -d "$D/$d" ] && cp -r data/$d "$D/"; done
export DATA="$D" NODE_USE_ENV_PROXY=1
BUILD_ENV="WIDE=1 UNIVERSE=cap LIQ_KR=0 LIQ_US=0"
echo "· 옛 기간 events 만드는 중(MIN_YM=200301)"; env $BUILD_ENV MIN_YM=200301 node 3_build.js > "$D/mk_build.log" 2>&1 || { tail -5 "$D/mk_build.log"; exit 1; }
echo "· 첫날 가격 받기(2003-01~, 처음이면 10~20분)"; FD_P1=1041379200 node 2c_firstday.js > "$D/mk_first.log" 2>&1 || { tail -5 "$D/mk_first.log"; exit 1; }
echo "· 지수 월봉(BENCH_FROM=200301)"; BENCH_FROM=200301 node 8b_bench.js > "$D/mk_bench.log" 2>&1 || { tail -5 "$D/mk_bench.log"; exit 1; }
echo "· 차트 월봉(8_bars)"; node 8_bars.js > "$D/mk_bars.log" 2>&1 || { tail -5 "$D/mk_bars.log"; exit 1; }
echo "· 채권·금 ETF 월봉"; node 2n_etf.js
echo "data_2003 완료"
