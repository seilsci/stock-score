@echo off
rem stock-score: git pull + tools/learn/run.sh  (바탕화면에 복사해 두고 더블클릭)
rem 저장소 위치: E:\GitHub\stock-score 또는 C:\Users\사용자\stock-score 중 있는 곳
set "CMDLINE=( cd /e/GitHub/stock-score 2>/dev/null || cd /c/Users/$USERNAME/stock-score 2>/dev/null || cd ~/stock-score ) && git pull && tools/learn/run.sh; echo; echo '--- done: press Enter to close ---'; read"
if exist "%ProgramFiles%\Git\git-bash.exe" (
  start "" "%ProgramFiles%\Git\git-bash.exe" -c "%CMDLINE%"
  exit /b 0
)
if exist "%LocalAppData%\Programs\Git\git-bash.exe" (
  start "" "%LocalAppData%\Programs\Git\git-bash.exe" -c "%CMDLINE%"
  exit /b 0
)
if exist "C:\msys64\msys2_shell.cmd" (
  "C:\msys64\msys2_shell.cmd" -ucrt64 -c "%CMDLINE%"
  exit /b 0
)
echo Git Bash not found. In the bash window run:  cygpath -w /
echo and tell Claude the result.
pause
