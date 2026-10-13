@echo off
rem Start the local voice-conversion service (RVC) on 127.0.0.1:6012.
rem
rem Converts synthesized audio into a target timbre (one voice folder holds a
rem model.pth plus an optional model.index). Voices whose id starts with "rvc:"
rem go through here; their source audio is normally a CosyVoice voice, configured
rem in .tools\rvc-voices\NAME\voice.json as sourceVoice.
rem The working directory matters: rvc looks for assets\models (rmvpe.pt,
rem contentvec_base.pt) under the current directory, and those two are
rem pre-downloaded into .tools\rvc-work, so we cd there first.
rem No angle brackets anywhere on purpose: cmd would read them as redirection.
rem ASCII-only on purpose: cmd.exe reads .cmd as system ANSI.
setlocal

rem Resolve configured dirs (paths.json / env / defaults). See scripts\_dirs.cmd.
call "%~dp0_dirs.cmd"
set "ROOT=%AX_ROOT%"
set "API=%AX_TOOLS%\miniconda3\envs\rvc\Scripts\rvc-api.exe"
set "WORK=%AX_TOOLS%\rvc-work"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=6012"

if not exist "%API%" (
  echo [ERROR] rvc env not found: %API%
  echo         see docs section 9 for how it was installed
  pause
  exit /b 1
)
if not exist "%WORK%\assets\models\rmvpe.pt" (
  echo [ERROR] missing %WORK%\assets\models\rmvpe.pt
  echo         run: node scripts\get-rvc-assets.mjs
  pause
  exit /b 1
)
if not exist "%WORK%\assets\models\contentvec_base.pt" (
  echo [ERROR] missing %WORK%\assets\models\contentvec_base.pt
  echo         run: node scripts\get-rvc-assets.mjs
  pause
  exit /b 1
)

netstat -ano | findstr /c:"LISTENING" | findstr /c:":%PORT% " >nul 2>&1 && (
  echo [rvc] already listening on %PORT% -- skip
  exit /b 0
)

echo [rvc] starting RVC on 127.0.0.1:%PORT% (models load on first convert)
cd /d "%WORK%"
"%API%" --host 127.0.0.1 --port %PORT%
endlocal
