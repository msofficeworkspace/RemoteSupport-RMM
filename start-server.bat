@echo off
setlocal
cd /d "%~dp0server"
title Remote Support Server
where node >nul 2>&1 || (echo Node.js 20+ is required. Install Node.js and try again.&echo.&pause&exit /b 1)
if "%TECHNICIAN_TOKEN%"=="" set "TECHNICIAN_TOKEN=CHANGE_ME_NOW"
if not exist node_modules (
  echo Installing server dependencies...
  call npm install
  if errorlevel 1 (echo.&echo npm install failed.&pause&exit /b 1)
)
echo.
echo Starting Remote Support server...
echo Dashboard: http://localhost:8000
if "%TECHNICIAN_TOKEN%"=="CHANGE_ME_NOW" echo WARNING: using default technician token CHANGE_ME_NOW
call npm run dev
set ERR=%ERRORLEVEL%
echo.
echo Server stopped with exit code %ERR%.
pause
exit /b %ERR%
