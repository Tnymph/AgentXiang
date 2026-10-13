@echo off
rem Shared helper: resolve this project's directories into AX_* variables.
rem Call it from the launchers:   call "%~dp0_dirs.cmd"
rem
rem Sets:  AX_ROOT AX_TOOLS AX_DATA AX_STYLE AX_INBOX AX_QQ
rem
rem Values come from scripts\print-dir.mjs, which reads (in order) environment
rem variables, paths.json, built-in defaults -- so moving .tools to another drive
rem is a one-line edit in paths.json and every launcher follows.
rem If node is missing we fall back to the default locations, so a plain
rem double-click still starts a stock install.
rem
rem It does NOT setlocal: the caller's setlocal keeps these variables scoped.
rem ASCII-only on purpose: cmd.exe reads .cmd as system ANSI.
set "AX_ROOT=%~dp0.."

for /f "tokens=1,* delims==" %%a in ('node --no-warnings "%AX_ROOT%\scripts\print-dir.mjs" all 2^>nul') do set "AX_%%a=%%b"

if not defined AX_ROOT set "AX_ROOT=%~dp0.."
if not defined AX_TOOLS set "AX_TOOLS=%AX_ROOT%\.tools"
if not defined AX_DATA set "AX_DATA=%AX_ROOT%\data"
if not defined AX_STYLE set "AX_STYLE=%AX_ROOT%\style-samples"
if not defined AX_INBOX set "AX_INBOX=%AX_ROOT%\inbox"
if not defined AX_QQ set "AX_QQ=C:\Program Files\Tencent\QQNT\QQ.exe"
