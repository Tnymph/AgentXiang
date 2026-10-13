#!/usr/bin/env bash
# 停止机器人（手机版）
#
#   bash stop-bot.sh           # 停机器人本体 + 语音识别服务
#   bash stop-bot.sh --napcat  # 连 NapCat 一起停
#
# 会先礼后兵：先发 TERM，等 3 秒还没走就 KILL。
# 数据库用的是 WAL，强杀也不会坏；这一个进程里没有别的子进程。

set -u
STOP_NAPCAT=0
[ "${1:-}" = "--napcat" ] && STOP_NAPCAT=1

pids_of() { # 关键词 → 逗号/空格分隔的 pid 列表
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -f "$1" 2>/dev/null || true
  elif command -v ps >/dev/null 2>&1; then
    # 没有 procps（pgrep）时拿 ps 顶一下
    ps -A -o pid,args 2>/dev/null | grep -F -- "$1" | grep -v -e grep -e 'ps -A' | awk '{print $1}' || true
  fi
}

kill_by() { # 模式 说明
  local pat="${1-}" label="${2-}"
  local pids
  pids="$(pids_of "$pat")"
  if [ -z "$pids" ]; then
    printf '  %s：没在跑\n' "$label"
    return
  fi
  printf '  %s：停 %s\n' "$label" "$pids"
  kill $pids 2>/dev/null || true
  sleep 3
  local left
  left="$(pids_of "$pat")"
  if [ -n "$left" ]; then
    printf '    还没走，强杀 %s\n' "$left"
    kill -9 $left 2>/dev/null || true
  fi
}

echo "停止 AgentXiang"
kill_by 'node --no-warnings src/index.js' '机器人本体'
kill_by 'sherpa-onnx' '语音识别服务'

# 后台的 screen 会话也收掉
if screen -list 2>/dev/null | grep -q 'agentxiang'; then
  screen -S agentxiang -X quit 2>/dev/null || true
  echo "  已关掉 screen 会话 agentxiang"
fi

if [ "$STOP_NAPCAT" -eq 1 ]; then
  if screen -list 2>/dev/null | grep -q 'napcat'; then
    screen -S napcat -X quit 2>/dev/null || true
    echo "  已关掉 screen 会话 napcat"
  fi
  kill_by 'proot-distro' 'NapCat 容器'
  kill_by 'opt/QQ/qq' 'QQ 本体'
else
  echo "  NapCat：没动（要停加 --napcat）"
fi

command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-unlock 2>/dev/null || true
echo "完成"
