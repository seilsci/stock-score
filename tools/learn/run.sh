#!/usr/bin/env bash
# 월봉 10이평 매수 신호 학습 — PC Git Bash에서:   tools/learn/run.sh
#   시험으로 조금만:  LIMIT=60 tools/learn/run.sh        기본이 묻지 않고 올리기, 안 올리려면: tools/learn/run.sh --no-push
# 처음부터 0% → 끝나면 100%. 받은 월봉은 data/raw2에 남아서, 끊기면 다시 실행하면 이어서 받음.
set -eo pipefail
cd "$(dirname "$0")"
YES=1   # 기본: 끝나면 묻지 않고 결과를 올림(사용자 지시). 올리지 않으려면 --no-push
for a in "$@"; do [ "$a" = "--no-push" ] && YES=0; done
command -v node >/dev/null || { echo "node가 없어요. https://nodejs.org 에서 LTS 설치 후 다시"; exit 1; }
# 종목 범위(2026-11-25 사용자 지시: "당시 시총 기준"): 넓은 목록(한국 전 종목 + 미국 3000)을 받고, 매달 그 시점 시총 상위(코스피 300·코스닥 200·미국 500 = 사이트와 같은 개수)만 후보로 인정.
#   그때의 시총 ≈ 그 달 종가 × 오늘 주식 수(근사, 3_build.js). 사이트 목록(Apps Script)이 "오늘 시총 상위"라 구매 기준과 일치.
#   예전 방식: 거래대금 상위 → UNIVERSE=turnover LIQ_KR=500 LIQ_US=500 tools/learn/run.sh   /   현재 시총 목록 → WIDE=0 UNIVERSE= LIQ_KR=0 LIQ_US=0 tools/learn/run.sh
export WIDE=${WIDE-1} UNIVERSE=${UNIVERSE-cap} LIQ_KR=${LIQ_KR-0} LIQ_US=${LIQ_US-0}
export SCORE_MODEL=${SCORE_MODEL:-ridge}    # 점수 모델: ridge(옛 선형, 기본) 또는 gbm(트리: 보유 제외 적용 뒤 이득이 사라져 채택 보류). 매매일지·장부 점수도 이것을 씀
# 실행한 곳 표시: PC(Windows Git Bash)와 클라우드는 속도가 달라 실행 시간 기록·예상을 따로 관리(RUN_WHERE=pc|cloud로 바꿀 수 있음)
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) WHERE=${RUN_WHERE:-pc};; *) WHERE=${RUN_WHERE:-cloud};; esac
D=${DATA:-data}; mkdir -p "$D"
export T0=$(date +%s)
LOG=$D/run.log; : > $LOG
say(){ echo "$1" | tee -a $LOG; }
done_(){ echo; say "■ $1 끝 · 지금 $(date '+%H:%M') · 시작 후 $(( ($(date +%s)-T0)/60 ))분"; }
LAST=$(date +%s); : > $D/steptimes.new
mark(){ local n=$(date +%s); echo "$1 $((n-LAST))" >> $D/steptimes.new; LAST=$n; }
say "===== 학습 시작 $(date '+%Y-%m-%d %H:%M') ====="
RT=$D/runtimes.txt; touch "$RT"
PREV=$(grep " learn@$WHERE " "$RT" | tail -1 | sed -n 's/.*total=\([0-9]*\).*/\1/p')      # 지난 PC 실행의 실제 소요 시간(초) — 같은 PC에서 월봉이 이미 있을 때가 비교 기준
[ -n "$PREV" ] && say "지난 $WHERE 실행 실측: $((PREV/60))분 → 이번 100% 예상 $(date -d @$((T0+PREV)) '+%H:%M') (월봉을 새로 받는 양에 따라 달라짐, 진행 중에는 실측으로 계속 고침)" || say "($WHERE 실행 시간 기록이 아직 없어요. 이번 실행 시간을 기록해 다음부터 예상에 씁니다)"

PFROM=0 PTO=1 node 1_lists.js | tee -a $LOG
done_ "종목 목록 (1/8)"
eval "$(node plan.js)"      # 진행률 구간 B1~B7 (이미 받은 월봉은 거의 0%, 지난 실행의 단계별 실측 시간 반영)
LAST=$(date +%s); TDL=$LAST
[ -d "$D/raw" ] && { say "옛 월봉(3개월 간격 오류) 삭제"; rm -rf "$D/raw"; }
for k in 1 2 3; do
  PFROM=$B1 PTO=$B2 node 2_download.js | tee $D/dl.log || true; cat $D/dl.log >> $LOG
  grep -q '실패 0' $D/dl.log && break
  echo "실패한 것만 다시 받기 ($k/3)"
done
PFROM=$B2 PTO=$B2c node 2c_firstday.js | tee -a $LOG || true
PFROM=$B2c PTO=$B3 node 2d_sec.js | tee -a $LOG || true      # 미국 재무 공시(SEC) → data/sec (실패해도 계속: 재무 지표 실험만 빠짐)
PFROM=$B2c PTO=$B3 node 2b_macro.js | tee -a $LOG || true
PFROM=$B2c PTO=$B3 node 2e_rates.js | tee -a $LOG || true      # 미국 금리 하루 단위(FRED) → data/rates.json: 일지의 금리 판단(국채 10년 6개월 변화)에 씀. Node에서 FRED가 막히면 NODE_USE_ENV_PROXY=1
done_ "월봉·첫날 가격·거시 지표 받기 (2/8)"
LAST=$(date +%s)
PFROM=$B3 PTO=$B4 node 3_build.js | tee -a $LOG
done_ "매수 신호·정답·지표 (3/8)"; mark build
PFROM=$B4 PTO=$B5 node 4_train.js | tee -a $LOG
[ "$SCORE_MODEL" = gbm ] && { PFROM=$B4 PTO=$B5 node 4b_gbm.js | tee -a $LOG; }       # 사이트용 트리 점수 모델 → data/gbm.json (gbm 채택 때만. result/에 gbm.json이 있으면 사이트가 트리로 바뀜)
done_ "학습·검증 (4/8)"; mark train
PFROM=$B5 PTO=$B6 node 5_explore.js | tee -a $LOG
done_ "여러 실험 (5/8)"; mark explore
PFROM=$B6 PTO=$B7 node 6_check.js | tee -a $LOG
done_ "타이밍·종목 점검 (6/8)"; mark check
PFROM=$B7 PTO=100 node 7_backtest.js | tee -a $LOG
done_ "월 100만원 적립 시뮬레이션 (7/8)"; mark backtest
node 8b_bench.js > /dev/null 2>&1 || echo "지수 비교 자료(8b_bench.js)는 건너뜀"      # → data/bench.json (코스피·S&P500·나스닥100 월봉, 매매일지 비교용)
node 10_traits.js > /dev/null 2>&1 || echo "이긴·진 종목 공통점 분석(10_traits.js)은 건너뜀"      # → data/traits.txt (가격 지표 + 미국 재무 지표)
mv $D/steptimes.new $D/steptimes.txt      # 다음 실행의 진행률 계산에 씀
echo "$(date '+%Y-%m-%d %H:%M') learn@$WHERE total=$(( $(date +%s)-T0 )) $(tr '\n' ' ' < $D/steptimes.txt | sed 's/ *$//; s/ \([0-9]\)/=\1/g') download=$(( ${TDL:-0} > 0 ? $(date +%s)-TDL : 0 )) limit=${LIMIT:-0}" >> "$RT"; tail -40 "$RT" > "$RT.tmp" && mv "$RT.tmp" "$RT"      # 실행 시간 기록(다음 예상에 씀)
echo; cat $D/report.txt $D/explore.txt $D/check.txt $D/backtest.txt; cat $D/report.txt $D/explore.txt $D/check.txt $D/backtest.txt >> $LOG
echo; say "100% 완료 · 보고서: tools/learn/data/report.txt"

# 결과 올리기: 가중치·보고서만 result/에 복사해 커밋·push (사이트 코드는 안 건드림)
if [ -n "$LIMIT" ]; then say "시험 실행(LIMIT)이라 올리지 않아요."; exit 0; fi
if [ $YES = 0 ]; then A=n; else A=y; fi        # 묻지 않음: 기본은 올림(--no-push면 안 올림)
if [ "$A" = "y" ] || [ "$A" = "Y" ]; then
  mkdir -p result; [ -f $D/runtimes.txt ] && cp $D/runtimes.txt result/; cp $D/weights.json $D/report.txt $D/explore.txt $D/check.txt $D/backtest.txt result/; [ "$SCORE_MODEL" = gbm ] && [ -f $D/gbm.json ] && cp $D/gbm.json result/; for f in trades.json bars.json ledger.json traits.txt bench.json; do [ -f $D/$f ] && cp $D/$f result/ || true; done
  git -c core.safecrlf=false add result
  git commit -q -m "학습 결과: 월봉 10이평 매수 신호 가중치 ($(date '+%Y-%m-%d'))" && git pull --rebase --autostash -q && git push -q && say "■ 올림 끝 (8/8). Claude에게 '올렸어'라고 알려 주세요."
else
  say "올리지 않았어요(--no-push). 나중에: cd tools/learn && mkdir -p result && cp data/weights.json data/report.txt result/ && git add result && git commit -m 결과 && git push"
fi
