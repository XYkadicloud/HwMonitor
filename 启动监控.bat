@echo off
setlocal enabledelayedexpansion

REM ===========================================================================
REM  HwMonitor launcher  --  PURE ASCII, DO NOT ADD NON-ASCII TEXT HERE
REM
REM  cmd.exe parses a .bat file using the console codepage in effect when the
REM  file is read. Any non-ASCII byte inside this file -- even inside a quoted
REM  command string on the same line -- corrupts the batch script, producing
REM  bogus tokens and broken control flow.
REM
REM  All user-facing Chinese text is therefore printed by lib\launcher-msg.js via
REM  Node, which reads source as UTF-8 unconditionally. (PowerShell 5.1 would
REM  need a UTF-8 BOM, which is easy to lose on a re-save.)
REM
REM  Behaviour:
REM   - Cleans up a leftover process from a previous crash using the PID file the
REM     server writes (data\server.pid). Command-line keyword matching is
REM     deliberately avoided: a launcher whose own command line contains the
REM     project path would match itself and kill its own shell.
REM   - Starts the server detached, with no console window left behind.
REM   - Does NOT open a browser.
REM ===========================================================================

cd /d "%~dp0"
set "ROOT=%~dp0"
set "PIDFILE=%ROOT%data\server.pid"
set "MSG=%ROOT%lib\launcher-msg.js"

REM ------------------------------------------------------------- Node.js
set "NODE_EXE="
for /f "delims=" %%p in ('where node 2^>nul') do (
  if not defined NODE_EXE set "NODE_EXE=%%p"
)
if not defined NODE_EXE (
  for %%c in ("%ProgramFiles%\nodejs\node.exe" "%ProgramFiles(x86)%\nodejs\node.exe" "%LOCALAPPDATA%\Programs\nodejs\node.exe") do (
    if not defined NODE_EXE if exist %%c set "NODE_EXE=%%c"
  )
)
if not defined NODE_EXE (
  echo.
  echo   [ERROR] Node.js not found. Install from https://nodejs.org/
  echo.
  goto :done
)

REM ---------------------------------------------------------------- port
set "PORT=8080"
if exist "data\config.json" (
  for /f "usebackq tokens=2 delims=:," %%p in (`findstr /r /c:"\"port\"" "data\config.json" 2^>nul`) do set "PORT=%%p"
)
set "PORT=%PORT: =%"

REM ------------------------------------------------------- stale cleanup
set "STALE_PID="
if exist "%PIDFILE%" (
  for /f "usebackq tokens=2 delims=:," %%a in (`findstr /c:"\"pid\"" "%PIDFILE%" 2^>nul`) do set "STALE_PID=%%a"
  set "STALE_PID=%STALE_PID: =%"
)

if defined STALE_PID (
  set "VERDICT="
  for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=!STALE_PID!' -ErrorAction SilentlyContinue; if (-not $p) { 'gone' } elseif ($p.CommandLine -match 'server\.js') { 'ours' } else { 'other' }"`) do set "VERDICT=%%v"

  if "!VERDICT!"=="ours" (
    taskkill /PID !STALE_PID! /T /F >nul 2>nul
    ping -n 3 127.0.0.1 >nul 2>nul
    "%NODE_EXE%" "%MSG%" cleanup detail=stopped
  )
  if "!VERDICT!"=="gone" (
    del "%PIDFILE%" >nul 2>nul
    "%NODE_EXE%" "%MSG%" cleanup detail=stale-record-removed
  )
  if "!VERDICT!"=="other" (
    "%NODE_EXE%" "%MSG%" cleanup detail=pid-reused-!STALE_PID!
  )
)

REM If something still holds the port, deal with it before starting, so we never
REM silently launch a second instance that would fail to bind.
set "PORTHOLDER="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /c:":%PORT% "') do set "PORTHOLDER=%%a"

if defined PORTHOLDER (
  set "HOLDER_VERDICT="
  for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=%PORTHOLDER%' -ErrorAction SilentlyContinue; if ($p -and $p.CommandLine -match 'server\.js') { 'ours' } else { 'other' }"`) do set "HOLDER_VERDICT=%%v"

  if "!HOLDER_VERDICT!"=="ours" (
    taskkill /PID %PORTHOLDER% /T /F >nul 2>nul
    ping -n 3 127.0.0.1 >nul 2>nul
    "%NODE_EXE%" "%MSG%" cleanup detail=stopped
  ) else (
    "%NODE_EXE%" "%MSG%" port-busy port=%PORT% detail=%PORTHOLDER%
    goto :done
  )
)

REM ------------------------------------------------------------- start
REM Detached and hidden, so no console window lingers on the desktop. The server
REM writes its own PID file, which the next run uses for cleanup.
powershell -NoProfile -Command "Start-Process -FilePath '%NODE_EXE%' -ArgumentList 'server.js' -WorkingDirectory '%ROOT%' -WindowStyle Hidden"

REM Wait for the port to come up (up to 30s; this machine warms up slowly).
set "READY="
for /l %%i in (1,1,30) do (
  if not defined READY (
    ping -n 2 127.0.0.1 >nul 2>nul
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /c:":%PORT% "') do set "READY=1"
  )
)

if not defined READY (
  "%NODE_EXE%" "%MSG%" fail port=%PORT%
  goto :done
)

set "LAN_IP="
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1).IPAddress"`) do set "LAN_IP=%%v"

"%NODE_EXE%" "%MSG%" ok port=%PORT% lanip=%LAN_IP%

:done
REM Brief pause so a double-click shows the result, then close.
ping -n 9 127.0.0.1 >nul 2>nul
exit /b 0
