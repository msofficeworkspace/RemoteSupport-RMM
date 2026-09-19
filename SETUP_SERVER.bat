@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Remote Support - First Time Setup
where node >nul 2>&1 || (echo Node.js 20+ is required. Install it from https://nodejs.org/ then run this again.&pause&exit /b 1)
for /f "delims=" %%v in ('node -p "process.versions.node"') do set NODE_VERSION=%%v
echo Node.js %NODE_VERSION% detected.
if "%TECHNICIAN_TOKEN%"=="" set /p TECHNICIAN_TOKEN=Create technician token (do not use CHANGE_ME_NOW): 
if "%TECHNICIAN_TOKEN%"=="" set "TECHNICIAN_TOKEN=CHANGE_ME_NOW"
setx TECHNICIAN_TOKEN "%TECHNICIAN_TOKEN%" >nul
cd server
if not exist node_modules call npm install
if errorlevel 1 (echo Dependency installation failed.&pause&exit /b 1)
echo.
echo Setup complete.
echo Technician token saved for future terminals.
echo Run start-server.bat to start the dashboard.
pause
