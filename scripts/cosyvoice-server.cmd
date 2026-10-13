@echo off
rem Start the local speech synthesis service (CosyVoice2) on 127.0.0.1:6011.
rem
rem It loads a 4.4GB model at startup (about 20s) and then answers /synth.
rem Voice picks that start with "cosy:" use this service; other voices still use sherpa.
rem Voice conversion (rvc:) also needs this one: its source voice comes from here.
rem ASCII-only on purpose: cmd.exe reads .cmd as system ANSI, and a single Chinese
rem character makes it mis-parse the whole file (measured 2026-09-27: every line
rem after it ran as a command). Keep paths out of these comments or write them in
rem English; the Chinese path ledger lives in docs and in the code comments.
setlocal

rem Resolve configured dirs (paths.json / env / defaults). See scripts\_dirs.cmd.
call "%~dp0_dirs.cmd"
set "ROOT=%AX_ROOT%"
set "PY=%AX_TOOLS%\miniconda3\envs\cosy\python.exe"
set "SERVER=%AX_TOOLS%\CosyVoice\zx-server.py"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=6011"

if not exist "%PY%" (
  echo [ERROR] python env not found: %PY%
  echo         see section 9 of the file-and-path ledger in docs for the recipe
  pause
  exit /b 1
)
if not exist "%SERVER%" (
  echo [ERROR] server script not found: %SERVER%
  pause
  exit /b 1
)

netstat -ano | findstr /c:"LISTENING" | findstr /c:":%PORT% " >nul 2>&1 && (
  echo [cosy] already listening on %PORT% -- skip
  exit /b 0
)

echo [cosy] starting CosyVoice2 on 127.0.0.1:%PORT% (model load takes about 20s)
set "COSY_VOICE_DIR=%AX_TOOLS%\cosy-voices"
"%PY%" "%SERVER%" --port %PORT%
endlocal
