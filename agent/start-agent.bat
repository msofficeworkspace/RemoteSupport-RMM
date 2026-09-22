@echo off
setlocal
cd /d "%~dp0"
title Remote Support Agent
if not exist "%ProgramData%\RemoteSupport\agent.json" echo No installed agent configuration found. Run install-agent.bat first.&pause&exit /b 1
dotnet run
pause
