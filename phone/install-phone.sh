#!/usr/bin/env bash
# AgentXiang 手机安装（Termux 侧）
#
#   bash install-phone.sh
#
# 做三件事：装依赖、把程序放到 ~/agentxiang、放好启动脚本。
# **不替你执行下载来的脚本** —— NapCat 的安装命令会打印出来，你自己确认后再跑。
#
# 装到哪里：程序放 ~/agentxiang
# 数据放哪：~/agentxiang/data（聊天记录、配置；第一次是空的，之后从电脑同步过来）

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="${HOME:?找不到 HOME}"
TARGET="$HOME_DIR/agentxiang"

say() { printf '%s\n' "${1-}"; }
step() { printf '\n\033[36m==> %s\033[0m\n' "${1-}"; }
die() { printf '\033[31m%s\033[0m\n' "${1-}"; exit 1; }

# ---------- 0. 前置检查 ----------
[ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux ] || die "必须在 Termux 里跑"
[ "$(uname -m)" = "aarch64" ] || die "只支持 64 位 ARM（当前 $(uname -m)）"
[ -d "$HERE/app/src" ] || die "安装包里没有 app/src，解压不完整？"

# 目标目录必须是空的或已存在的 agentxiang，绝不接受空值
case "$TARGET" in
  "$HOME_DIR"/*) : ;;
  *) die "目标目录不对劲：$TARGET" ;;
esac

say "AgentXiang 手机安装"
say "  程序目录：$TARGET"
say "  安装包：  $HERE"

# ---------- 1. 基础依赖 ----------
step "1/4 安装基础依赖（node / proot-distro / screen / ffmpeg / curl / procps）"
if ! command -v pkg >/dev/null 2>&1; then
  die "找不到 pkg，这不是 Termux"
fi
pkg update -y || die "pkg update 失败"
# procps 提供 pgrep —— 停机器人、体检脚本靠它找进程；Termux 基础环境里不一定有
pkg install -y nodejs proot-distro screen termux-tools ffmpeg curl procps || die "pkg install 失败"
say "    node $(node -v)"

# ---------- 2. 程序本体 ----------
step "2/4 放置程序到 $TARGET"
mkdir -p "$TARGET"

# 只覆盖这三个代码目录；data/ 里的数据永远不碰
for d in src scripts docs; do
  if [ -d "$HERE/app/$d" ]; then
    rm -rf "$TARGET/$d"
    cp -R "$HERE/app/$d" "$TARGET/$d"
  fi
done
if [ -f "$HERE/app/package.json" ]; then
  cp -f "$HERE/app/package.json" "$TARGET/package.json"
fi
mkdir -p "$TARGET/data/logs" "$TARGET/data/tmp"
say "    代码已就位（data/ 保持原样）"

# 自检：用包里自带的检查脚本（不在命令行里拼代码，也顺带验了 node:sqlite）
if [ -f "$TARGET/scripts/phone-smoke.mjs" ]; then
  if node --no-warnings "$TARGET/scripts/phone-smoke.mjs" >/dev/null 2>&1; then
    say "    冒烟自检通过（能加载代码、能建库）"
  else
    say "    ! 冒烟自检没过，单独跑一下看原因："
    say "      node --no-warnings $TARGET/scripts/phone-smoke.mjs"
  fi
fi

# ---------- 3. 启动脚本 ----------
step "3/4 放置启动脚本"
for f in start-bot.sh stop-bot.sh verify-phone.sh check-phone.sh; do
  if [ -f "$HERE/$f" ]; then
    cp -f "$HERE/$f" "$TARGET/$f"
    chmod +x "$TARGET/$f"
    # 从 Windows 传过来的可能带 \r，会让 shebang 失效
    sed -i 's/\r$//' "$TARGET/$f" 2>/dev/null
  fi
done
say "    已放好 start-bot.sh / stop-bot.sh / verify-phone.sh / check-phone.sh"

# ---------- 4. NapCat ----------
step "4/4 NapCat（QQ 协议端）"
say "这一步我不替你跑 —— 它是从网上下脚本再执行，你确认过再动手更稳妥。"
say "在 Termux 里逐条敲："
say ""
say "  # 装 NapCat（约 1.5GB，装进 proot 容器，很久）"
say "  curl -o napcat.termux.sh https://nclatest.znin.net/NapNeko/NapCat-Installer/main/script/install.termux.sh"
say "  less napcat.termux.sh      # 想看一眼就看看，不想看直接下一步"
say "  bash napcat.termux.sh"
say ""

# ---------- 收尾 ----------
printf '\n\033[32m安装完成。\033[0m\n\n'
say "接下来按顺序做："
say ""
say "1) 启动 NapCat 扫码登录（第一次必须用另一台设备扫，手机扫不了自己）"
say "     proot-distro sh napcat -- bash -c \"xvfb-run -a /root/Napcat/opt/QQ/qq --no-sandbox\""
say "   扫完在 QQ 上勾选「下次登录无需手机确认」"
say ""
say "2) 以后用快速登录（后台跑，关掉终端也不停）"
say "     screen -dmS napcat bash -c 'proot-distro sh napcat -- bash -c \"xvfb-run -a /root/Napcat/opt/QQ/qq --no-sandbox -q 机器人QQ号\"'"
say "   回到这个会话：screen -r napcat     离开：Ctrl+A 然后 D"
say ""
say "3) 启动机器人本体"
say "     cd ~/agentxiang && bash start-bot.sh"
say "   然后在手机浏览器打开 http://127.0.0.1:6188"
say "   （密钥、NapCat 地址填 ws://127.0.0.1:3001）"
say ""
say "4) 体检装完的状态"
say "     bash ~/agentxiang/verify-phone.sh"
say ""
