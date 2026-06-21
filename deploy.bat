@echo off
cd /d "%~dp0"

echo.
echo ========================================
echo   Deploy Guess-Name-Game to Render
echo ========================================
echo.

echo [1/4] Current changes:
git status --short
echo.

set /p MSG="[2/4] Commit message (press Enter for default): "
if "%MSG%"=="" set MSG=update

echo.
echo [3/4] Committing...
git add .
git commit -m "%MSG%"
if errorlevel 1 (
    echo.
    echo [!] Nothing to commit, or commit failed.
    pause
    exit /b 1
)

echo.
echo [4/4] Pushing to GitHub...
git push

if errorlevel 1 (
    echo.
    echo [!] Push failed. Check network or GitHub login.
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Done! Render will auto-deploy in 1-2 min
echo   Dashboard: https://dashboard.render.com
echo   Live URL:  https://guess-name-game.onrender.com
echo ========================================
echo.
pause
