@echo off
rem Start a NapCat instance and show its login QR code.
rem
rem Usage (all args optional; defaults are the first bot):
rem   napcat-start.cmd                      -> .tools\napcat   + .tools\qq-bot-data
rem   napcat-start.cmd napcat2 3998561404 qq-bot2-data
rem        arg1 = folder name under .tools
rem        arg2 = QQ account for quick-login (also names the config file)
rem        arg3 = QQ data folder name under .tools (must differ per account!)
rem
rem Why this exists rather than the bundled launcher: the shipped one reads the QQ
rem install path from HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\...\Uninstall\QQ -- the
rem 32-bit hive. On a 64-bit QQ that lookup fails, so we take the path from
rem paths.json (key qqExe) instead; its default is the standard install location.
rem
rem One NapCat instance serves exactly ONE QQ account, so a second bot needs its own
rem folder, its own data folder and its own ws port. Sharing them makes two bots fight
rem over one account.
rem
rem ASCII-only on purpose: cmd.exe reads .cmd as system ANSI.
setlocal

rem Resolve configured dirs (paths.json / env / defaults). See scripts\_dirs.cmd.
call "%~dp0_dirs.cmd"
set "BASE=%AX_TOOLS%"
set "QQ_PATH=%AX_QQ%"

set "INST_DIR=%~1"
if "%INST_DIR%"=="" set "INST_DIR=napcat"
set "BOT_QQ=%~2"
if "%BOT_QQ%"=="" set "BOT_QQ=3046116373"
set "DATA_NAME=%~3"
if "%DATA_NAME%"=="" set "DATA_NAME=qq-bot-data"

set "NAPCAT_DIR=%BASE%\%INST_DIR%"
set "BOT_DATA=%BASE%\%DATA_NAME%"

if not exist "%QQ_PATH%" (
  echo [ERROR] QQ.exe not found at: %QQ_PATH%
  pause
  exit /b 1
)
if not exist "%NAPCAT_DIR%" (
  echo [ERROR] NapCat folder not found: %NAPCAT_DIR%
  pause
  exit /b 1
)

if /i "%~4"=="elevate" (
  net session >nul 2>&1
  if not %ERRORLEVEL% == 0 (
    echo Requesting administrator rights...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
  )
)

cd /d "%NAPCAT_DIR%"
if not exist "%BOT_DATA%" mkdir "%BOT_DATA%"
if not exist "%NAPCAT_DIR%\data\logs" mkdir "%NAPCAT_DIR%\data\logs"

set "NAPCAT_PATCH_PACKAGE=%NAPCAT_DIR%\qqnt.json"
set "NAPCAT_LOAD_PATH=%NAPCAT_DIR%\loadNapCat.js"
set "NAPCAT_INJECT_PATH=%NAPCAT_DIR%\NapCatWinBootHook.dll"
set "NAPCAT_LAUNCHER_PATH=%NAPCAT_DIR%\NapCatWinBootMain.exe"
set "NAPCAT_MAIN_PATH=%NAPCAT_DIR%\napcat.mjs"
set "NAPCAT_MAIN_PATH=%NAPCAT_MAIN_PATH:\=/%"

rem ACCOUNT tells NapCat whose saved session to reuse for quick login.
set "ACCOUNT=%BOT_QQ%"

echo (async () =^> {await import("file:///%NAPCAT_MAIN_PATH%")})() > "%NAPCAT_LOAD_PATH%"

echo.
echo  NapCat starting...
echo    instance    %NAPCAT_DIR%
echo    QQ client   %QQ_PATH%
echo    QQ data     %BOT_DATA%
echo    account     %BOT_QQ%
echo.
echo  Scan the QR below with the mobile QQ logged in as account %BOT_QQ%
echo  (NOT your personal account).
echo.

"%NAPCAT_LAUNCHER_PATH%" "%QQ_PATH%" "%NAPCAT_INJECT_PATH%" "--user-data-dir=%BOT_DATA%"

endlocal
