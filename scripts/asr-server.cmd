@echo off
rem Start the local ASR service (sherpa-onnx persistent websocket server).
rem The model is loaded once, so every later transcription is milliseconds.
rem This file is intentionally ASCII-only: cmd.exe reads .cmd as system ANSI,
rem and non-ASCII bytes here break the parser on non-UTF8 locales.
setlocal enabledelayedexpansion

rem Resolve configured dirs (paths.json / env / defaults). See scripts\_dirs.cmd.
call "%~dp0_dirs.cmd"
set "ROOT=%AX_ROOT%"
set "TOOLS=%AX_TOOLS%"
set "PORT=%~1"
if "%PORT%"=="" set "PORT=6007"

rem --- locate sherpa runtime (folder name carries the version) ---
set "SHERPA_BIN="
for /d %%D in ("%TOOLS%\sherpa\*") do (
  if exist "%%D\bin\sherpa-onnx-offline-websocket-server.exe" set "SHERPA_BIN=%%D\bin"
)
if not defined SHERPA_BIN (
  if exist "%TOOLS%\sherpa\bin\sherpa-onnx-offline-websocket-server.exe" set "SHERPA_BIN=%TOOLS%\sherpa\bin"
)
if not defined SHERPA_BIN (
  echo [ERROR] sherpa-onnx runtime not found under %TOOLS%\sherpa
  exit /b 1
)

rem --- locate SenseVoice model ---
set "MODEL_DIR="
for /d %%D in ("%TOOLS%\model-sense-voice\*") do (
  if exist "%%D\model.int8.onnx" set "MODEL_DIR=%%D"
  if exist "%%D\model.onnx" set "MODEL_DIR=%%D"
)
if not defined MODEL_DIR (
  echo [ERROR] SenseVoice model not found under %TOOLS%\model-sense-voice
  exit /b 1
)

set "MODEL_FILE=%MODEL_DIR%\model.int8.onnx"
if not exist "%MODEL_FILE%" set "MODEL_FILE=%MODEL_DIR%\model.onnx"

if not exist "%AX_DATA%\logs" mkdir "%AX_DATA%\logs"

echo.
echo  ASR service starting...
echo    port  %PORT%
echo    model %MODEL_FILE%
echo  Press Ctrl+C to stop.
echo.

"%SHERPA_BIN%\sherpa-onnx-offline-websocket-server.exe" --port=%PORT% --sense-voice-model="%MODEL_FILE%" --tokens="%MODEL_DIR%\tokens.txt" --sense-voice-language=zh --num-threads=4 --log-file="%AX_DATA%\logs\asr-server.log"

endlocal
