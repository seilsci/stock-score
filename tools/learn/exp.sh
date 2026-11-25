#!/usr/bin/env bash
# 시험 실행기: run_exp.bat(바탕화면 stock_exp.bat)이 git pull 뒤 이 파일을 실행. 새 시험을 할 때는 이 파일의 시험 이름만 바꿔 올리면 됨.
# 지금 시험: 익절 기준 2배(지금)·2.5·3·4배·없음 비교 + 삼성전자·SK하이닉스 거래(AD8_TP) — 현재 data/events.csv(= 마지막 stock_learn 결과, 당시 시총 기준)로 계산
# (이전 시험: AD8_TUNE=1 삼성전자·SK하이닉스 잡기, AD8_CASH=1 후보 적은 달 현금 유지·현금 이자, AD8_RISK=1 지수 필터·보유 상한, AD8_UNION=1 후보 묶기, AD8_SKIP=1 산 달 말 판매)
cd "$(dirname "$0")" || exit 1
export STAGE3=0 STAGE4=0 STAGE5=0 STAGE6=0 STAGE7=0 STAGE8=0 STAGE9=0 STAGE10=0 STAGE11=0 STAGE12=0 STAGE13=0 STAGE14=1 AD8_TP=1 AD8_HALVES=8 NODE_NO_WARNINGS=1
echo "시험 시작: $(date '+%H:%M')  (몇 분 걸려요)"
node 7_backtest.js > data/exp_run.log 2>&1 || { echo "실행 오류. data/exp_run.log 마지막 줄:"; tail -5 data/exp_run.log; exit 1; }
awk '/^## (확인 매수 후속|삼성전자)/{p=1} /^## 체결 가정/{p=0} p' data/backtest.txt > data/exp_result.txt
cat data/exp_result.txt
# 클립보드 복사: Windows clip은 UTF-8 한글이 깨지므로 PowerShell Set-Clipboard(UTF-8로 읽기) 우선, 없으면 UTF-16으로 바꿔 clip에 넣음
if command -v powershell.exe >/dev/null 2>&1; then
  powershell.exe -NoProfile -Command "Get-Content -Raw -Encoding UTF8 'data/exp_result.txt' | Set-Clipboard" && echo "[결과를 클립보드에 복사했어요. 채팅에 붙여넣기 하세요]"
elif command -v clip >/dev/null 2>&1 && command -v iconv >/dev/null 2>&1; then
  { printf '\xff\xfe'; iconv -f UTF-8 -t UTF-16LE data/exp_result.txt; } | clip && echo "[결과를 클립보드에 복사했어요. 채팅에 붙여넣기 하세요]"
fi
echo "끝: $(date '+%H:%M')"
