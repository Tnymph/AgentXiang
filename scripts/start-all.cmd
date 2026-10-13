@echo off
rem Start the whole stack after a reboot: NapCat x2, then the bot program.
rem
rem   start-all.cmd           -> two NapCat instances + the bot program
rem   start-all.cmd --asr     -> also start the local ASR service
rem
rem One NapCat instance serves exactly one QQ account, so there are two windows
rem (3046116373 -> ws 3001, 3998561404 -> ws 3011).
rem The bot program retries its websocket by itself, so the exact ordering is not
rem critical -- the 15s wait below is only so QQ has time to log in first.
rem
rem ASCII-only on purpose: cmd.exe reads .cmd as system ANSI.
setlocal
call "%~dp0_dirs.cmd"
set "ROOT=%AX_ROOT%"

rem Idempotent: if something already listens on that port, skip starting a second
rem copy. Two NapCat instances for one account fight and QQ kicks one offline;
rem two bot processes fight over port 6188. Running this twice is now harmless.
set "SKIP1="
set "SKIP2="
set "SKIP3="
netstat -ano | findstr /c:"LISTENING" | findstr /c:":3001 " >nul 2>&1 && set "SKIP1=1"
netstat -ano | findstr /c:"LISTENING" | findstr /c:":3011 " >nul 2>&1 && set "SKIP2=1"
netstat -ano | findstr /c:"LISTENING" | findstr /c:":6188 " >nul 2>&1 && set "SKIP3=1"

if defined SKIP1 (
  echo [1/6] NapCat 3046116373 already listening on 3001 -- skip
) else (
  echo [1/6] start NapCat 3046116373 - ws port 3001
  start "NapCat 3046116373" /D "%ROOT%" cmd /k "scripts\napcat-start.cmd napcat 3046116373 qq-bot-data"
)

if defined SKIP2 (
  echo [2/6] NapCat 3998561404 already listening on 3011 -- skip
) else (
  echo [2/6] start NapCat 3998561404 - ws port 3011
  start "NapCat 3998561404" /D "%ROOT%" cmd /k "scripts\napcat-start.cmd napcat2 3998561404 qq-bot2-data"
)

if /i "%~1"=="--asr" (
  set "SKIPASR="
  netstat -ano | findstr /c:"LISTENING" | findstr /c:":6007 " >nul 2>&1 && set "SKIPASR=1"
  if defined SKIPASR (
    echo [3/6] ASR already listening on 6007 -- skip
  ) else (
    echo [3/6] start ASR service
    start "AgentXiang ASR" /D "%ROOT%" cmd /k "scripts\asr-server.cmd"
  )
) else (
  echo [3/6] ASR skipped -- pass --asr to start it
)

rem Speech synthesis (CosyVoice2). Voices whose id starts with "cosy:" need it;
rem other voices still work without it. Skipped with --no-tts.
set "SKIPTTS="
netstat -ano | findstr /c:"LISTENING" | findstr /c:":6011 " >nul 2>&1 && set "SKIPTTS=1"
if /i "%~1"=="--no-tts" (
  echo [4/6] speech synthesis skipped -- --no-tts given
) else (
  if defined SKIPTTS (
    echo [4/6] speech synthesis already listening on 6011 -- skip
  ) else (
    echo [4/6] start speech synthesis service
    start "AgentXiang TTS" /D "%ROOT%" cmd /k "scripts\cosyvoice-server.cmd"
  )
)

rem Voice conversion (RVC). Voices whose id starts with "rvc:" need it, and they
rem also need the synthesis service above (the source voice is a CosyVoice voice).
set "SKIPRVC="
netstat -ano | findstr /c:"LISTENING" | findstr /c:":6012 " >nul 2>&1 && set "SKIPRVC=1"
if /i "%~1"=="--no-tts" (
  echo [5/6] voice conversion skipped -- --no-tts given
) else (
  if defined SKIPRVC (
    echo [5/6] voice conversion already listening on 6012 -- skip
  ) else (
    echo [5/6] start voice conversion service
    start "AgentXiang RVC" /D "%ROOT%" cmd /k "scripts\rvc-server.cmd"
  )
)

if defined SKIP1 if defined SKIP2 goto :skipwait
echo       waiting 15s for QQ to log in ...
rem ping as a sleep instead of timeout: timeout aborts when stdin is redirected
ping -n 16 127.0.0.1 >nul
:skipwait

if defined SKIP3 (
  echo [6/6] bot program already listening on 6188 -- skip
) else (
  echo [6/6] start bot program
  start "AgentXiang" /D "%ROOT%" cmd /k "node --no-warnings src/index.js"
)

echo.
echo   Web UI   http://127.0.0.1:6188
echo   Logs     %AX_DATA%\logs\
echo   Stop     scripts\stop-all.cmd
echo.
echo Keep these windows open. Closing one stops only that piece.
endlocal
