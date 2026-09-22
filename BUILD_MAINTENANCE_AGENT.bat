@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "INSTALLER=agent\install-agent.bat"
if not exist "%INSTALLER%" echo ERROR: %INSTALLER% not found.& exit /b 1
for /f "tokens=1" %%H in ('certutil -hashfile "%INSTALLER%" SHA256 ^| findstr /r /i "^[0-9a-f][0-9a-f]"') do set "HASH_BEFORE=%%H"
where dotnet >nul 2>&1
if errorlevel 1 echo ERROR: .NET SDK is required.& exit /b 1
dotnet --version
if errorlevel 1 exit /b 1
echo.
echo Building the Windows agent with Maintenance support...
dotnet publish "agent\RemoteSupportAgent.csproj" -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true /p:IncludeNativeLibrariesForSelfExtract=true /p:UseWindowsForms=true
if errorlevel 1 echo ERROR: dotnet publish failed.& exit /b 1
set "PUBLISH=agent\bin\Release\net8.0-windows\win-x64\publish"
if not exist "%PUBLISH%\RemoteSupportAgent.exe" echo ERROR: Published RemoteSupportAgent.exe not found.& exit /b 1
copy /y "%PUBLISH%\RemoteSupportAgent.exe" "agent\publish\RemoteSupportAgent.exe" >nul
if errorlevel 1 exit /b 1
for /f "tokens=1" %%H in ('certutil -hashfile "%INSTALLER%" SHA256 ^| findstr /r /i "^[0-9a-f][0-9a-f]"') do set "HASH_AFTER=%%H"
if /i not "%HASH_BEFORE%"=="%HASH_AFTER%" echo ERROR: agent\install-agent.bat changed during the build. Aborting.& exit /b 2
echo.
echo SUCCESS: RemoteSupportAgent.exe rebuilt with Maintenance support.
echo VERIFIED: agent\install-agent.bat was NOT changed.
exit /b 0
