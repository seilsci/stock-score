# 매수 신호 학습·시뮬레이션 — PC에서 돌리기 (Git Bash)

필요: Node 18 이상, Git Bash. 추가 설치 없음. (더블클릭: `run_learn.bat`)

```bash
cd stock-score
git pull
tools/learn/run.sh          # 0% → 100%, 끝나면 "결과를 올릴까요? (y/N)"
```
- 단계(8): 종목 목록 → 월봉·거시 받기 → 매수 신호·지표 → 학습 → 여러 실험 → 타이밍·종목 점검 → 월 100만원 적립 시뮬 → 올리기
- 받은 월봉은 `tools/learn/data/raw2`에 남아 다시 돌리면 빠름. 끊겨도 이어서.
- 시험으로 조금만: `LIMIT=600 tools/learn/run.sh` (안 올림). 묻지 않고 올리기: `--yes`.
- 결과 `tools/learn/result/`: report(학습) · explore(실험 순위) · check(타이밍 vs 종목 고르기) · backtest(적립 시뮬) · weights.json
- 대상 범위는 **사이트와 같게**(코스피 300 + 코스닥 200 + 미국 500). 넓게 보려면 `WIDE=1 tools/learn/run.sh`(한국 전 종목 + 미국 3000).
- 비용·세금은 `costs.json`에서 고침(한국 수수료·연도별 거래세, 미국 수수료·환전·양도세).
- 정답 = 매수 신호 달 종가 → 매도 신호 달 종가 수익(log). 학습은 해마다 그해 1월 1일에 알던 정답만. 기간 2008-12 이후.
- 야후 월봉은 `period1=2000&interval=1mo`(range=max는 오래된 종목을 3개월 간격으로 줘서 못 씀). 간격 검사 통과분만 저장.
- 주의: 지금 상장·시총 상위 종목만 대상 → 상장폐지 종목 없음, 결과 과장 가능. 방법끼리 비교가 더 믿을 만함.
