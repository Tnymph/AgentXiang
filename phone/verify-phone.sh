#!/usr/bin/env bash
# 装完之后体检：程序、NapCat、界面各自是什么状态
#
#   bash verify-phone.sh
#
# 只看，不改。哪一步不对就照着提示往回查。

ok=0; bad=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; ok=$((ok+1)); }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; bad=$((bad+1)); }
info() { printf '      %s\n' "$1"; }
head_() { printf '\n[%s]\n' "$1"; }

HERE="$(cd "$(dirname "$0")" && pwd)"

# 进程检查靠 pgrep（在 procps 包里）。没有就跳过这一块，别报假故障。
HAVE_PGREP=0
command -v pgrep >/dev/null 2>&1 && HAVE_PGREP=1

printf '\nAgentXiang 装完体检\n'
printf '====================\n'

head_ 程序
if [ -d "$HERE/src" ]; then
  pass "代码在 $HERE"
else
  fail "找不到 $HERE/src"
  info "把安装包解压后重跑：bash install-phone.sh"
fi
if command -v node >/dev/null 2>&1; then
  pass "node $(node -v)"
else
  fail "没装 node"
  info "pkg install nodejs"
fi
if [ -f "$HERE/scripts/phone-smoke.mjs" ]; then
  if node --no-warnings "$HERE/scripts/phone-smoke.mjs" >/dev/null 2>&1; then
    pass "冒烟自检通过"
  else
    fail "冒烟自检没过，单独跑看原因："
    info "node --no-warnings $HERE/scripts/phone-smoke.mjs"
  fi
fi
if [ -f "$HERE/data/agentxiang.sqlite" ]; then
  pass "数据库已建（$(du -h "$HERE/data/agentxiang.sqlite" 2>/dev/null | cut -f1)）"
else
  fail "还没有数据库"
  info "第一次启动程序时会自动建；先跑 bash start-bot.sh"
fi

head_ 机器人进程
if [ "$HAVE_PGREP" -eq 1 ]; then
  if pgrep -f 'node --no-warnings src/index.js' >/dev/null 2>&1; then
    pass "机器人本体在跑（pid $(pgrep -f 'node --no-warnings src/index.js' | tr '\n' ' ')）"
  else
    fail "机器人本体没在跑"
    info "cd $HERE && bash start-bot.sh"
    info "（想丢后台：bash start-bot.sh --screen）"
  fi
else
  info "跳过进程检查：没装 procps。装它：pkg install procps"
fi
if command -v curl >/dev/null 2>&1 && curl -s -m 5 -o /dev/null http://127.0.0.1:6188/ 2>/dev/null; then
  pass "管理界面能打开（http://127.0.0.1:6188）"
else
  fail "管理界面连不上"
  info "程序在跑但界面打不开，通常是端口被占；看日志："
  info "tail -30 $HERE/data/logs/system-\$(date +%F).log"
fi

head_ NapCat
if command -v proot-distro >/dev/null 2>&1; then
  if proot-distro list 2>/dev/null | grep -q napcat; then
    pass "napcat 容器已装"
  else
    fail "没有 napcat 容器"
    info "curl -o napcat.termux.sh https://nclatest.znin.net/NapNeko/NapCat-Installer/main/script/install.termux.sh"
    info "bash napcat.termux.sh"
  fi
else
  fail "没装 proot-distro"
  info "pkg install proot-distro"
fi
if [ "$HAVE_PGREP" -eq 1 ]; then
  if pgrep -f 'opt/QQ/qq' >/dev/null 2>&1; then
    pass "QQ 本体在跑"
  else
    fail "QQ 本体没在跑"
    info "快速登录（后台）："
    info "screen -dmS napcat bash -c 'proot-distro sh napcat -- bash -c \"xvfb-run -a /root/Napcat/opt/QQ/qq --no-sandbox -q 机器人QQ号\"'"
  fi
else
  info "跳过进程检查：没装 procps"
fi
if command -v curl >/dev/null 2>&1 && curl -s -m 5 -o /dev/null http://127.0.0.1:3001 2>/dev/null; then
  pass "OneBot 端口 3001 有响应"
  info "程序里 NapCat 地址填 ws://127.0.0.1:3001"
else
  fail "OneBot 端口 3001 没响应"
  info "可能是 NapCat 的 WS 端口没开或端口不是 3001"
  info "在 NapCat 的 WebUI 里看「网络配置」的端口号，然后填进程序的接入设置"
fi

head_ 语音识别（可以先不管）
if [ "$HAVE_PGREP" -eq 0 ]; then
  info "跳过进程检查：没装 procps"
elif pgrep -f sherpa-onnx >/dev/null 2>&1; then
  pass "识别服务在跑"
else
  fail "识别服务没跑"
  info "还没装的话不影响文字聊天：语音条会走「默认回复」里的语音兜底"
fi

printf '\n====================\n'
printf '通过 %d 项，失败 %d 项\n' "$ok" "$bad"
printf '====================\n'
if [ "$bad" -eq 0 ]; then
  printf '\033[32m装好了，去 QQ 里 @ 它试试。\033[0m\n\n'
else
  printf '\033[33m还有 %d 项没过，照着上面的提示查；卡住就把这段输出发我。\033[0m\n\n' "$bad"
fi
