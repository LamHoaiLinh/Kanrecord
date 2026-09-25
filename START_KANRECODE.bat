@echo off
setlocal
cd /d "%~dp0"
set "PORT=8765"

echo ==========================================
echo   KANRECODE - LOCAL SCREEN RECORDER
echo ==========================================
echo.
echo Dang khoi dong tai http://127.0.0.1:%PORT%

where py >nul 2>nul
if %errorlevel%==0 (
  start "Kanrecode Local Server" /min py -3 -m http.server %PORT% --bind 127.0.0.1
  goto :OPEN
)

where python >nul 2>nul
if %errorlevel%==0 (
  start "Kanrecode Local Server" /min python -m http.server %PORT% --bind 127.0.0.1
  goto :OPEN
)

echo.
echo KHONG TIM THAY PYTHON.
echo Hay cai Python hoac chay Kanrecode bang mot local web server khac.
pause
exit /b 1

:OPEN
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:%PORT%"
exit /b 0
