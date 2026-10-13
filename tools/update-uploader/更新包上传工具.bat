@echo off
rem ============================================================
rem  TongGuanBao Update Package Upload Tool launcher
rem  Starts the local node server (tools/update-uploader/server.mjs)
rem  and opens http://127.0.0.1:5278/ with Google Chrome.
rem  Falls back to the system default browser if Chrome is absent.
rem ============================================================
setlocal
set "PORT=5278"
set "URL=http://127.0.0.1:%PORT%/"
set "HERE=%~dp0"

rem Already running? Then just open the page.
curl -s -o nul %URL%
if %errorlevel%==0 goto open

where node >nul 2>nul
if not %errorlevel%==0 (
  echo [ERROR] node not found in PATH. Install Node.js first.
  pause
  exit /b 1
)

start "update-tool-server" /min node "%HERE%server.mjs"

set /a tries=0
:waitloop
timeout /t 1 /nobreak >nul
curl -s -o nul %URL%
if %errorlevel%==0 goto open
set /a tries+=1
if %tries% lss 15 goto waitloop
echo [ERROR] local server failed to start. Run "node %HERE%server.mjs" to see details.
pause
exit /b 1

:open
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if exist "%CHROME%" (
  start "" "%CHROME%" "%URL%"
) else (
  echo [INFO] Chrome not found, opening with the default browser...
  start "" "%URL%"
)
