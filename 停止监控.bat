@echo off
setlocal enabledelayedexpansion

REM ===========================================================================
REM  HwMonitor stopper  --  PURE ASCII, DO NOT ADD NON-ASCII TEXT HERE
REM
REM  Same constraint as the launcher: cmd.exe mis-parses non-ASCII bytes in a
REM  batch file, so all Chinese output is printed by lib\launcher-msg.js.
REM
REM  Stops the server using the PID file it writes, verifying the process really
REM  is our server before terminating it. Never matches on command-line keywords.
REM ===========================================================================

cd /d "%~dp0"
set "ROOT=%~dp0"
set "PIDFILE=%ROOT%data\server.pid"
set "MSG=%ROOT%\lib\launcher-msg.js"

set "NODE_EXE="
for /f "delims=" %%p in ('where node 2^>nul') do (
  if not defined NODE_EXE set "NODE_EXE=%%p"
)
if not defined NODE_EXE (
  if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
)

REM ------------------------------------------------- from the PID file
set "TARGET_PID="
if exist "%PIDFILE%" (
  for /f "usebackq tokens=2 delims=:," %%a in (`findstr /c:"\"pid\"" "%PIDFILE%" 2^>nul`) do set "TARGET_PID=%%a"
  set "TARGET_PID=%TARGET_PID: =%"
)

if defined TARGET_PID (
  set "VERDICT="
  for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=!TARGET_PID!' -ErrorAction SilentlyContinue; if (-not $p) { 'gone' } elseif ($p.CommandLine -match 'server\.js') { 'ours' } else { 'other' }"`) do set "VERDICT=%%v"

  if "!VERDICT!"=="ours" (
    taskkill /PID !TARGET_PID! /T /F >nul 2>nul
    del "%PIDFILE%" >nul 2>nul
    ping -n 2 127.0.0.1 >nul 2>nul
    if defined NODE_EXE "%NODE_EXE%" "%MSG%" stopped
    goto :done
  )
  if "!VERDICT!"=="gone" (
    del "%PIDFILE%" >nul 2>nul
  )
)

REM ------------------------------------------- fall back to the port holder
set "PORT=8080"
if exist "data\config.json" (
  for /f "usebackq tokens=2 delims=:," %%p in (`findstr /r /c:"\"port\"" "data\config.json" 2^>nul`) do set "PORT=%%p"
)
set "PORT=%PORT: =%"

set "PORTHOLDER="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /c:":%PORT% "') do set "PORTHOLDER=%%a"

if defined PORTHOLDER (
  set "HOLDER_VERDICT="
  for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=%PORTHOLDER%' -ErrorAction SilentlyContinue; if ($p -and $p.CommandLine -match 'server\.js') { 'ours' } else { 'other' }"`) do set "HOLDER_VERDICT=%%v"

  if "!HOLDER_VERDICT!"=="ours" (
    taskkill /PID %PORTHOLDER% /T /F >nul 2>nul
    del "%PIDFILE%" >nul 2>nul
    ping -n 2 127.0.0.1 >nul 2>nul
    if defined NODE_EXE "%NODE_EXE%" "%MSG%" stopped
    goto :done
  )
)

if defined NODE_EXE "%NODE_EXE%" "%MSG%" not-running

:done
ping -n 7 127.0.0.1 >nul 2>nul
exit /b 0
