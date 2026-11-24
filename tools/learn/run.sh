#!/usr/bin/env bash
# 월봉 10이평 매수 신호 학습 — PC Git Bash에서:   tools/learn/run.sh
#   시험으로 조금만:  LIMIT=60 tools/learn/run.sh        묻지 않고 올리기: tools/learn/run.sh --yes
# 처음부터 0% → 끝나면 100%. 받은 월봉은 data/raw2에 남아서, 끊기면 다시 실행하면 이어서 받음.
set -eo pipefail
cd "$(dirname "$0")"
YES=0; [ "$1" = "--yes" ] || [ "$1" = "-y" ] && YES=1
command -v node >/dev/null || { echo "node가 없어요. https://nodejs.org 에서 LTS 설치 후 다시"; exit 1; }
D=${DATA:-data}; mkdir -p "$D"
export T0=$(date +%s)
LOG=$D/run.log; : > $LOG
say(){ echo "$1" | tee -a $LOG; }
done_(){ echo; say "■ $1 끝 · $(TZ=Asia/Seoul date '+%H:%M' 2>/dev/null || date '+%H:%M') · 경과 $(( ($(date +%s)-T0)/60 ))분"; }
say "===== 학습 시작 $(date '+%Y-%m-%d %H:%M') ====="

PFROM=0 PTO=2 node 1_lists.js | tee -a $LOG
done_ "종목 목록 (1/8)"
[ -d "$D/raw" ] && { say "옛 월봉(3개월 간격 오류) 삭제"; rm -rf "$D/raw"; }
for k in 1 2 3; do
  PFROM=2 PTO=60 node 2_download.js | tee $D/dl.log || true; cat $D/dl.log >> $LOG
  grep -q '실패 0' $D/dl.log && break
  echo "실패한 것만 다시 받기 ($k/3)"
done
PFROM=60 PTO=61 node 2b_macro.js | tee -a $LOG || true
done_ "월봉·거시 지표 받기 (2/8)"
PFROM=61 PTO=66 node 3_build.js | tee -a $LOG
done_ "매수 신호·정답·지표 (3/8)"
PFROM=66 PTO=70 node 4_train.js | tee -a $LOG
done_ "학습·검증 (4/8)"
PFROM=70 PTO=86 node 5_explore.js | tee -a $LOG
done_ "여러 실험 (5/8)"
PFROM=86 PTO=92 node 6_check.js | tee -a $LOG
done_ "타이밍·종목 점검 (6/8)"
PFROM=92 PTO=100 node 7_backtest.js | tee -a $LOG
done_ "월 100만원 적립 시뮬레이션 (7/8)"
echo; cat $D/report.txt $D/explore.txt $D/check.txt $D/backtest.txt; cat $D/report.txt $D/explore.txt $D/check.txt $D/backtest.txt >> $LOG
echo; say "100% 완료 · 보고서: tools/learn/data/report.txt"

# 결과 올리기: 가중치·보고서만 result/에 복사해 커밋·push (사이트 코드는 안 건드림)
if [ -n "$LIMIT" ]; then say "시험 실행(LIMIT)이라 올리지 않아요."; exit 0; fi
if [ $YES = 0 ]; then read -r -p "결과를 올릴까요? (y/N) " A </dev/tty || A=n; else A=y; fi
if [ "$A" = "y" ] || [ "$A" = "Y" ]; then
  mkdir -p result; cp $D/weights.json $D/report.txt $D/explore.txt $D/check.txt $D/backtest.txt result/
  git -c core.safecrlf=false add result
  git commit -q -m "학습 결과: 월봉 10이평 매수 신호 가중치 ($(date '+%Y-%m-%d'))" && git push -q && say "■ 올림 끝 (8/8). Claude에게 '올렸어'라고 알려 주세요."
else
  say "올리지 않았어요. 나중에: cd tools/learn && mkdir -p result && cp data/weights.json data/report.txt result/ && git add result && git commit -m 결과 && git push"
fi
