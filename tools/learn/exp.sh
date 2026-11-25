#!/usr/bin/env bash
# 시험 실행기: run_exp.bat(바탕화면 stock_exp.bat)이 git pull 뒤 이 파일을 실행. 새 시험을 할 때는 이 파일의 시험 이름만 바꿔 올리면 됨.
# 지금 시험: 시험 목록 전체 묶음(AD9, ad9.js) — 묶음 1~10을 차례로 돌려 결과를 data/exp_result.txt에 이어 붙이고 클립보드에 복사
#   묶음: 1 매수 신호 · 2 순위 · 3 점수 모델 · 4 비중·구성 · 5 매도 · 6 자금·비용·세금 · 7 체결·시점 · 8 종목 범위 · 9 검증 · 10 다른 전략과 비교
#   일부만: tools/learn/exp.sh 1 5   (묶음 1과 5만)   /   절반 되풀이 횟수: AD8_HALVES=4 tools/learn/exp.sh   (기본 6, 줄이면 빨라짐)
# (이전 시험 이름: AD8_MIX 한·미 비율, AD8_DIV 배당, AD8_REV 역배열 즉시 판매, AD8_ETF ETF 제외, AD8_TLH2·AD8_TLH 세금 줄이기, AD8_TP 익절 기준, AD8_TUNE 삼성전자·SK하이닉스, AD8_CASH, AD8_RISK, AD8_UNION, AD8_SKIP)
cd "$(dirname "$0")" || exit 1
export STAGE3=0 STAGE4=0 STAGE5=0 STAGE6=0 STAGE7=0 STAGE8=0 STAGE9=0 STAGE10=0 STAGE11=0 STAGE12=0 STAGE13=0 STAGE14=1 NODE_NO_WARNINGS=1
export AD8_HALVES="${AD8_HALVES:-6}"
BATCHES="${*:-1 2 3 4 5 6 7 8 9 10 11}"
declare -A NAME=([1]="매수 신호" [2]="순위" [3]="점수 모델" [4]="비중·구성" [5]="매도" [6]="자금·비용·세금" [7]="체결·시점" [8]="종목 범위" [9]="검증" [10]="다른 전략과 비교" [11]="조합·일관성 점검")
OUT=data/exp_result.txt
: > "$OUT"
echo "시험 시작: $(date '+%H:%M') — 묶음 ${BATCHES} (묶음마다 1~2분, 전체 15~30분)"
for B in $BATCHES; do
  echo "── 묶음 $B ${NAME[$B]} 시작 $(date '+%H:%M')"
  if AD9="$B" node 7_backtest.js > "data/exp_run_$B.log" 2>&1; then
    { echo; echo "================ 묶음 $B · ${NAME[$B]} ================"; awk '/^## (확인 매수 후속|9 검증|10 다른 전략|11 일관성)/{p=1} /^## 체결 가정/{p=0} p' data/backtest.txt; } >> "$OUT"
    echo "── 묶음 $B 끝 $(date '+%H:%M')"
  else
    { echo; echo "================ 묶음 $B · ${NAME[$B]} — 실행 오류 ================"; tr '\r' '\n' < "data/exp_run_$B.log" | tail -8; } >> "$OUT"
    echo "── 묶음 $B 실행 오류(data/exp_run_$B.log 마지막 줄을 결과에 적어 둠) — 다음 묶음으로 계속"
  fi
done
cat "$OUT"
# 클립보드 복사: Windows clip은 UTF-8 한글이 깨지므로 PowerShell Set-Clipboard(UTF-8로 읽기) 우선, 없으면 UTF-16으로 바꿔 clip에 넣음
if command -v powershell.exe >/dev/null 2>&1; then
  powershell.exe -NoProfile -Command "Get-Content -Raw -Encoding UTF8 'data/exp_result.txt' | Set-Clipboard" && echo "[결과를 클립보드에 복사했어요. 채팅에 붙여넣기 하세요. 너무 길면 data/exp_result.txt 파일을 열어 나눠 붙이세요]"
elif command -v clip >/dev/null 2>&1 && command -v iconv >/dev/null 2>&1; then
  { printf '\xff\xfe'; iconv -f UTF-8 -t UTF-16LE data/exp_result.txt; } | clip && echo "[결과를 클립보드에 복사했어요. 채팅에 붙여넣기 하세요]"
fi
echo "끝: $(date '+%H:%M')"
