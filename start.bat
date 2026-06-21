@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo First-time setup: installing dependencies...
  call npm install --no-audit --no-fund
)
echo.
echo Starting Guess Name game server...
echo.
node server.js
pause
