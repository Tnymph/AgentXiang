#!/usr/bin/env bash
# 启动机器人（手机版）
#
#   bash start-bot.sh              # 前台跑，日志直接打屏；Ctrl+C 停
#   bash start-bot.sh --screen     # 丢到后台跑（screen 会话名 agentxiang）
#
# 干的事：拿住 CPU 别被系统睡掉 → 起语音识别服务（如果装了）→ 起机器人本体。

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE" || exit 1

# 后台模式：把自己塞进一个 screen 会话重跑一遍
if [ "${1:-}" = "--screen" ]; then
  if screen -list 2>/dev/null | grep -q 'agentxiang'; then
    echo "已经在后台跑了。进去看：screen -r agentxiang"
    exit 0
  fi
  screen -dmS agentxiang bash "$HERE/start-bot.sh"
  echo "已丢到后台（screen 会话：agentxiang）"
  echo "  看日志：screen -r agentxiang    离开：Ctrl+A 然后 D"
  exit 0
fi

# 防止息屏后被系统挂起（华为/荣耀尤其需要）
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock

echo "启动 AgentXiang"
echo "  目录：$HERE"

# 语音识别服务：装了才起，没装不影响（语音条会走「默认回复」里的语音兜底）
ASR_BIN="$HERE/.tools/asr/bin/sherpa-onnx-offline-websocket-server"
if [ -x "$ASR_BIN" ]; then
  if ! (command -v pgrep >/dev/null 2>&1 && pgrep -f sherpa-onnx >/dev/null 2>&1); then
    echo "  启动语音识别服务…"
    "$ASR_BIN" > "$HERE/data/logs/asr-server.log" 2>&1 &
    sleep 2
  fi
  echo "  语音识别服务：已启动"
else
  echo "  语音识别服务：没装（语音条会走兜底回复，不影响文字聊天）"
fi

echo "  机器人本体：$(node -v)"
echo "  管理界面： http://127.0.0.1:6188"
echo ""
exec node --no-warnings src/index.js
