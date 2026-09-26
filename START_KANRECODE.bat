@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo   KANRECODE - DESKTOP HELPER
echo ==========================================
echo.
echo Helper se mo Kanrecode tai:
echo http://127.0.0.1:8765
echo.
echo Thu muc video dai:
echo %%USERPROFILE%%\Videos\Kanrecode
echo.

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 kanrecode_server.py
  exit /b %errorlevel%
)

where python >nul 2>nul
if %errorlevel%==0 (
  python kanrecode_server.py
  exit /b %errorlevel%
)

echo KHONG TIM THAY PYTHON.
echo Hay cai Python 3 hoac chay Kanrecode bang mot local web server khac.
pause
exit /b 1
