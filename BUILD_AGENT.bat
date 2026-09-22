@echo off
setlocal
cd /d "%~dp0agent"
where dotnet >nul 2>&1 || (echo .NET 8 SDK is required.&pause&exit /b 1)
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o publish
if errorlevel 1 (echo Build failed.&pause&exit /b 1)
echo.
echo Agent published to:
echo %CD%\publish\RemoteSupportAgent.exe
pause
