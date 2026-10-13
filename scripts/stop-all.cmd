@echo off
rem Stop everything that start-all.cmd started.
rem
rem It kills ONLY this project's processes:
rem   - the bot node process   (command line contains src/index.js or src\index.js --
rem                             Windows accepts both, and which one shows up in the
rem                             process table depends on how it was launched)
rem   - the ASR server         (its own exe name)
rem   - NapCat's launcher
rem   - the QQ instances that run with .tools\qq-bot*-data as user-data-dir
rem
rem Your personal QQ is NOT touched: it runs with the default user-data-dir, so it
rem never matches *qq-bot*. That is also why this does not use "taskkill /im QQ.exe"
rem -- that would kill every QQ on the machine.
rem
rem ASCII-only on purpose: cmd.exe reads .cmd as system ANSI.
setlocal

echo Stopping the bot program ...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*src/index.js*' -or $_.CommandLine -like '*src\index.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo Stopping the ASR service ...
taskkill /f /im sherpa-onnx-offline-websocket-server.exe >nul 2>&1

rem Speech synthesis (CosyVoice2) runs in its own python env; match its script name
rem so no other python process on this machine is touched.
echo Stopping the speech synthesis service ...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -like '*zx-server.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

rem Voice conversion (RVC) runs rvc-api.exe from its own env; the exe name is unique
rem to this project, so matching the name cannot hit anything else.
echo Stopping the voice conversion service ...
taskkill /f /im rvc-api.exe >nul 2>&1

echo Stopping NapCat ...
taskkill /f /im NapCatWinBootMain.exe >nul 2>&1

echo Stopping the bot QQ instances ...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='QQ.exe'\" | Where-Object { $_.CommandLine -like '*qq-bot*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

rem The visible windows are cmd.exe hosts running our commands. Killing the process
rem inside them leaves the empty window sitting there, so close the hosts as well.
rem Only our own commands are matched, so a cmd window you opened yourself is safe.
rem $PID is excluded because this very command line contains those patterns.
echo Closing the console windows ...
powershell -NoProfile -Command "$me=$PID; Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.ProcessId -ne $me -and ([string]$_.CommandLine -match 'napcat-start\.cmd|asr-server\.cmd|cosyvoice-server\.cmd|rvc-server\.cmd|src[\\/]index\.js') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo.
echo Done. Your personal QQ was left alone.
echo The database uses WAL, so a hard kill does not corrupt it.
endlocal
