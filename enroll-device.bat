@echo off
setlocal
cd /d "%~dp0"
if "%TECHNICIAN_TOKEN%"=="" set /p TECHNICIAN_TOKEN=Technician token: 
if "%REMOTE_SUPPORT_SERVER%"=="" set /p REMOTE_SUPPORT_SERVER=Server URL [http://localhost:8000]: 
if "%REMOTE_SUPPORT_SERVER%"=="" set "REMOTE_SUPPORT_SERVER=http://localhost:8000"
node scripts\enroll-device.js
pause
