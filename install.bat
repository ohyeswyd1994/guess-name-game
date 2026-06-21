@echo off
cd /d "%~dp0"
echo Installing dependencies...
call npm install --no-audit --no-fund
echo.
echo Done. Press any key to exit.
pause >nul
