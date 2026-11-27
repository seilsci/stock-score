#!/usr/bin/env bash
# 시험 실행기: run_exp.bat(바탕화면 stock_exp.bat)이 git pull 뒤 이 파일을 실행. 새 시험을 할 때는 이 파일의 시험 이름만 바꿔 올리면 됨.
# 지금 시험: 시험 목록 전체 묶음(AD9, ad9.js) — 묶음 1~21을 차례로 돌려 결과를 data/exp_result.txt에 이어 붙이고 클립보드에 복사
#   묶음: 1 매수 신호 · 2 순위 · 3 점수 모델 · 4 비중·구성 · 5 매도 · 6 자금·비용·세금 · 7 체결·시점 · 8 종목 범위 · 9 검증 · 10 다른 전략과 비교
#   일부만: tools/learn/exp.sh 1 5   (묶음 1과 5만)   /   절반 되풀이 횟수: AD8_HALVES=4 tools/learn/exp.sh   (기본 6, 줄이면 빨라짐)
# (이전 시험 이름: AD8_MIX 한·미 비율, AD8_DIV 배당, AD8_REV 역배열 즉시 판매, AD8_ETF ETF 제외, AD8_TLH2·AD8_TLH 세금 줄이기, AD8_TP 익절 기준, AD8_TUNE 삼성전자·SK하이닉스, AD8_CASH, AD8_RISK, AD8_UNION, AD8_SKIP)
cd "$(dirname "$0")" || exit 1
# 실행한 곳 표시: PC(Windows Git Bash)와 클라우드는 속도가 달라 실행 시간 기록·예상을 따로 관리(RUN_WHERE=pc|cloud로 바꿀 수 있음)
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) WHERE=${RUN_WHERE:-pc};; *) WHERE=${RUN_WHERE:-cloud};; esac
export STAGE3=0 STAGE4=0 STAGE5=0 STAGE6=0 STAGE7=0 STAGE8=0 STAGE9=0 STAGE10=0 STAGE11=0 STAGE12=0 STAGE13=0 STAGE14=1 NODE_NO_WARNINGS=1
export AD8_HALVES="${AD8_HALVES:-6}"
# 돌릴 묶음: 인자가 있으면 그것, 없으면 exp_batches.txt(Claude가 그때그때 바꿔 올림 → 사용자는 stock_exp.bat만 켜면 됨), 그것도 없으면 전부
BATCHES="${*:-$(tr '\r\n' '  ' < exp_batches.txt 2>/dev/null)}"
[ -z "${BATCHES// /}" ] && BATCHES="1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28"
declare -A NAME=([1]="매수 신호" [2]="순위" [3]="점수 모델" [4]="비중·구성" [5]="매도" [6]="자금·비용·세금" [7]="체결·시점" [8]="종목 범위" [9]="검증" [10]="다른 전략과 비교" [11]="조합·일관성 점검" [12]="판매 기준 이평 파고들기" [13]="판매 규칙 2(5이평 흔들어 보기)" [14]="점수 학습 바꾸기" [15]="신호 쪽 이평 길이(events 다시 만듦)" [16]="일봉 판단(일봉 받기 포함)" [17]="미국 공매도(공매도 받기 포함)" [18]="남은 시험 모음(지수·EMA·쌍별 학습·확인 시점 지표·업종·S&P500)" [19]="점수 오답 분석·손실 걸러내기" [20]="지친 말 점수(보유 종목이 지쳤는지)" [21]="바벨 구성(점수 + 대박 칸)" [22]="매수 신호 2" [23]="후보 순위 2" [24]="점수 모델 2(GBM·kNN·분위·새 지표)" [25]="비중·포트폴리오 2" [26]="매도 2" [27]="체결·운용·검증·비교 전략" [28]="종목 범위(events 다시 만듦)" [29]="5번 후보 확인(위험 회피 판매·불타기)" [30]="매수 쉼 민감도·불타기 곡선" [31]="마무리 점검(걸어가며 고르기·큰 수익 종목 빼기)" [32]="양봉만 사기" [33]="꼬리 없는 짧은 양봉" [34]="같은 지수 ETF 하나만" [35]="한국 수급(외국인·기관 순매수)" [36]="수급 확인(둘 다 순매수 제외·앞뒤 나눔)" [37]="엇갈린 수급 튼튼한가(문턱·기간·큰 수익 빼기·무작위 대조)" [38]="네이버 수급 vs KRX 수급 비교(백테스트 아님)")
# 묶음 15: 신호·정답·지표를 n이평으로 다시 만든 events(3_build.js MA_N=n)로 시험 → 끝나면 원래 events.csv로 되돌림(중간에 멈춰도 다음 실행 때 events_keep.csv가 남아 있으면 자동 복구)
# events를 다시 만들 때는 stock_learn(run.sh)과 같은 종목 범위 환경변수를 써야 비교가 됨(옛 묶음 15는 이 환경변수 없이 만들어 다른 종목 범위 결과였음 → 2026-11-27 고침)
BUILD_ENV="WIDE=1 UNIVERSE=cap LIQ_KR=0 LIQ_US=0"
run15(){
  [ -f data/events_keep.csv ] && cp data/events_keep.csv data/events.csv   # 지난번에 중간에 멈췄다면 복구
  cp data/events.csv data/events_keep.csv || return 1
  trap 'cp data/events_keep.csv data/events.csv 2>/dev/null' EXIT
  : > data/exp_run_15.log; : > data/bt15.txt; local rc=0 n
  for n in ${MA15:-10 5 7 15 20}; do
    echo "   · 신호 ${n}이평 events 다시 만드는 중 $(date '+%H:%M')"
    if env $BUILD_ENV MA_N=$n node 3_build.js >> data/exp_run_15.log 2>&1 && MA_N=$n AD9=15 node 7_backtest.js >> data/exp_run_15.log 2>&1; then
      { echo "---- 신호 ${n}이평 ----"; awk '/^## (확인 매수 후속|1[2-9]|[23][0-9] )/{p=1} /^## 체결 가정/{p=0} p' data/backtest.txt; } >> data/bt15.txt
    else rc=1; echo "---- 신호 ${n}이평 실행 오류 ----" >> data/bt15.txt; tr '\r' '\n' < data/exp_run_15.log | tail -5 >> data/bt15.txt; fi
  done
  cp data/events_keep.csv data/events.csv && rm -f data/events_keep.csv; trap - EXIT
  return $rc
}
# 묶음 28: 종목 범위(시총 상위 개수)를 바꿔 events를 다시 만들어 시험(코스피·코스닥·미국 개수). 첫 줄 '기본'은 events를 다시 만들어도 지금 결과와 같은지 확인용
run28(){
  [ -f data/events_keep.csv ] && cp data/events_keep.csv data/events.csv
  cp data/events.csv data/events_keep.csv || return 1
  trap 'cp data/events_keep.csv data/events.csv 2>/dev/null' EXIT
  : > data/exp_run_28.log; : > data/bt28.txt; local rc=0 c lab kp kq us
  for c in ${CFG28:-기본:300:200:500 코스피100:100:200:500 코스피500:500:200:500 코스닥100:300:100:500 코스닥400:300:400:500 미국200:300:200:200 미국1000:300:200:1000 전체작게:100:100:200 전체크게:500:400:1000}; do
    IFS=: read lab kp kq us <<< "$c"
    echo "   · 종목 범위 $lab(코스피 $kp·코스닥 $kq·미국 $us) events 다시 만드는 중 $(date '+%H:%M')"
    if env $BUILD_ENV CAP_KOSPI=$kp CAP_KOSDAQ=$kq CAP_US=$us node 3_build.js >> data/exp_run_28.log 2>&1 && CAP_LABEL="$lab" AD9=28 node 7_backtest.js >> data/exp_run_28.log 2>&1; then
      { echo "---- 종목 범위 $lab (코스피 $kp · 코스닥 $kq · 미국 $us) ----"; awk '/^## (확인 매수 후속 28|28 )/{p=1} /^## 체결 가정/{p=0} p' data/backtest.txt; } >> data/bt28.txt
    else rc=1; echo "---- 종목 범위 $lab 실행 오류 ----" >> data/bt28.txt; tr '\r' '\n' < data/exp_run_28.log | tail -5 >> data/bt28.txt; fi
  done
  cp data/events_keep.csv data/events.csv && rm -f data/events_keep.csv; trap - EXIT
  return $rc
}
OUT=data/exp_result.txt
: > "$OUT"
RT=data/runtimes.txt; touch "$RT"
# 지난 같은 곳($WHERE) 실행의 묶음별 실측 시간(초): 기록이 없으면 어림값 70초(클라우드에서 잰 값)
prev_b(){ node eta.js exp "$WHERE" "$1"; }      # 같은 곳 최근 3번 중앙값(기록 없으면 70초)
NB=0; EXP_TOT=0; for B in $BATCHES; do NB=$((NB+1)); EXP_TOT=$((EXP_TOT + $(prev_b $B))); done
T0=$(date +%s); DONE_N=0; DONE_EXP=0; DONE_REAL=0; REC=""
hm(){ date -d @"$1" '+%H:%M'; }
echo "시험 시작: $(date '+%H:%M') — 묶음 ${BATCHES} · 지난 $WHERE 실측 기준 전체 약 $((EXP_TOT/60))분 → 100% 예상 $(hm $((T0+EXP_TOT)))"
for B in $BATCHES; do
  TB=$(date +%s)
  if [ "$B" = 16 ]; then echo "── 일봉 받기(이미 받은 종목은 건너뜀, 처음이면 10~20분) $(date '+%H:%M')"; node 2g_daily.js 2>&1; fi
  if [ "$B" = 17 ]; then echo "── 공매도 받기(FINRA 공개 파일, 이미 받은 달은 건너뜀, 처음이면 10~20분) $(date '+%H:%M')"; CONC=${SHORT_CONC:-12} node 2h_short.js 2>&1; fi
  if [ "$B" = 18 ]; then echo "── 업종·S&P500 자료 받기(키 불필요, 이미 받은 것은 건너뜀) $(date '+%H:%M')"; node 2j_sp500.js 2>&1; node 2i_sic.js 2>&1; fi
  case " 22 23 24 26 27 " in *" $B "*) [ -f data/sic.json ] || { echo "── 업종 자료 받기"; node 2j_sp500.js 2>&1; node 2i_sic.js 2>&1; }; [ -d data/daily ] || { echo "── 일봉 받기"; node 2g_daily.js 2>&1; };; esac
  echo "── 묶음 $B ${NAME[$B]} 시작 $(date '+%H:%M')"
  if { [ "$B" = 15 ] && run15; } || { [ "$B" = 28 ] && run28; } || { [ "$B" = 38 ] && node 2l_flow_naver.js > "data/exp_run_38.log" 2>&1; } || { [ "$B" != 15 ] && [ "$B" != 28 ] && [ "$B" != 38 ] && AD9="$B" node 7_backtest.js > "data/exp_run_$B.log" 2>&1; }; then
    { echo; echo "================ 묶음 $B · ${NAME[$B]} ================"; if [ "$B" = 15 ]; then cat data/bt15.txt; elif [ "$B" = 28 ]; then cat data/bt28.txt; elif [ "$B" = 38 ]; then cat data/flow_naver_cmp.txt; else awk '/^## (확인 매수 후속|9 검증|10 다른 전략|11 일관성|1[2-9]|[23][0-9] )/{p=1} /^## 체결 가정/{p=0} p' data/backtest.txt; fi; } >> "$OUT"
    echo "── 묶음 $B 끝"
  else
    { echo; echo "================ 묶음 $B · ${NAME[$B]} — 실행 오류 ================"; tr '\r' '\n' < "data/exp_run_$B.log" | tail -8; [ "$B" = 15 ] && cat data/bt15.txt; } >> "$OUT"
    echo "── 묶음 $B 실행 오류(data/exp_run_$B.log 마지막 줄을 결과에 적어 둠) — 다음 묶음으로 계속"
  fi
  SEC=$(( $(date +%s)-TB )); REC="$REC b$B=$SEC"
  DONE_N=$((DONE_N+1)); DONE_EXP=$((DONE_EXP + $(prev_b $B))); DONE_REAL=$((DONE_REAL+SEC))
  # 단계 진행 표시: 끝난 묶음의 실측/예상 비율로 남은 예상을 고침
  RATIO=$(awk -v r=$DONE_REAL -v e=$DONE_EXP 'BEGIN{ if(e<=0) print 1; else printf "%.3f", r/e }')
  LEFT=$(awk -v t=$EXP_TOT -v d=$DONE_EXP -v q=$RATIO 'BEGIN{ printf "%d", (t-d)*q }')
  NOW=$(date +%s)
  echo "■ 묶음 $B 끝 ($DONE_N/$NB) · 지금 $(hm $NOW) · 이 묶음 $((SEC/60))분 $((SEC%60))초 · 남은 예상 $((LEFT/60))분 · 100% 예상 $(hm $((NOW+LEFT)))"
done
TOTAL=$(( $(date +%s)-T0 ))
echo "$(date '+%Y-%m-%d %H:%M') exp@$WHERE total=$TOTAL$REC" >> "$RT"; tail -40 "$RT" > "$RT.tmp" && mv "$RT.tmp" "$RT"      # 실행 시간 기록(다음 예상에 씀)
{ echo; echo "================ 실행 시간 기록($WHERE) ================"; echo "이번 시험 전체 $((TOTAL/60))분 $((TOTAL%60))초 ·$REC (초)"; } >> "$OUT"
cat "$OUT"
# 클립보드 복사: Windows clip은 UTF-8 한글이 깨지므로 PowerShell Set-Clipboard(UTF-8로 읽기) 우선, 없으면 UTF-16으로 바꿔 clip에 넣음
if command -v powershell.exe >/dev/null 2>&1; then
  powershell.exe -NoProfile -Command "Get-Content -Raw -Encoding UTF8 'data/exp_result.txt' | Set-Clipboard" && echo "[결과를 클립보드에 복사했어요. 채팅에 붙여넣기 하세요. 너무 길면 data/exp_result.txt 파일을 열어 나눠 붙이세요]"
elif command -v clip >/dev/null 2>&1 && command -v iconv >/dev/null 2>&1; then
  { printf '\xff\xfe'; iconv -f UTF-8 -t UTF-16LE data/exp_result.txt; } | clip && echo "[결과를 클립보드에 복사했어요. 채팅에 붙여넣기 하세요]"
fi
echo "끝: $(date '+%H:%M')"
