#!/usr/bin/env bash
# AgentXiang 手机体检 —— 在 Termux 里跑，不需要先装任何东西
#
#   bash check-phone.sh
#
# 它会告诉你：这台机器能不能跑这个机器人、还缺什么、下一步该敲哪条命令。
# 只读检测，不改你系统里的任何东西。

ok=0; warn=0; bad=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; ok=$((ok+1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; warn=$((warn+1)); }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; bad=$((bad+1)); }
info() { printf '      %s\n' "$1"; }
head_() { printf '\n[%s]\n' "$1"; }

printf '\nAgentXiang 手机体检\n'
printf '====================\n'

# ---------- 1. 环境 ----------
head_ 环境
if [ -n "$TERMUX_VERSION" ] || [ -d /data/data/com.termux ]; then
  pass "在 Termux 里（版本 ${TERMUX_VERSION:-未知}）"
else
  fail "不是在 Termux 里"
  info "这个程序必须跑在 Termux 里。普通安卓终端 App 不行，"
  info "因为要用到 proot 容器和包管理器。"
  info "Termux 请从 F-Droid 装（应用商店那个版本早废弃了，装不上包）。"
  info "f-droid.org 国内多半打不开，用清华镜像直接下这个："
  info "  https://mirrors.tuna.tsinghua.edu.cn/fdroid/repo/com.termux_1002.apk"
  info "（或者用另给的 termux-apk.zip 里那份，我校验过哈希）"
fi

ARCH="$(uname -m 2>/dev/null)"
if [ "$ARCH" = "aarch64" ]; then
  pass "架构 $ARCH（NapCat 和语音识别都有对应的 arm64 版本）"
else
  fail "架构是 $ARCH，不是 aarch64"
  info "这套东西只在 64 位 ARM 上验证过。"
fi

if command -v getprop >/dev/null 2>&1; then
  ANDROID_RAW="$(getprop ro.build.version.release 2>/dev/null)"
  MODEL="$(getprop ro.product.model 2>/dev/null)"
  [ -n "$MODEL" ] && info "机型：$MODEL"
  # 有的系统返回 "15.0"、"12L" 这种，取前面的整数再比
  ANDROID="$(printf '%s' "$ANDROID_RAW" | sed 's/[^0-9].*$//')"
  if [ -n "$ANDROID" ]; then
    if [ "$ANDROID" -ge 7 ] 2>/dev/null; then
      pass "安卓版本 $ANDROID_RAW（NapCat 要求 7.0 以上）"
    else
      fail "安卓版本 $ANDROID_RAW，太低（NapCat 要求 7.0 以上）"
    fi
  fi
fi

# ---------- 2. 硬件 ----------
head_ 硬件
if [ -r /proc/meminfo ]; then
  MEM_KB="$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null)"
  if [ -n "$MEM_KB" ]; then
    MEM_GB=$((MEM_KB / 1024 / 1024))
    if [ "$MEM_GB" -ge 4 ]; then
      pass "内存 ${MEM_GB}GB（够跑一个机器人：NapCat 约 0.5~1GB + 程序约 0.2GB）"
    else
      warn "内存只有 ${MEM_GB}GB，偏紧（建议 4GB 以上）"
    fi
    if [ "$MEM_GB" -ge 6 ]; then
      info "6GB 以上：跑一个号很宽裕；两个号（两套 NapCat）会很紧，建议先跑一个"
    fi
  fi
fi

CORES="$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null)"
[ -n "$CORES" ] && info "CPU 核心数：$CORES"

if command -v df >/dev/null 2>&1; then
  FREE_KB="$(df -k "$HOME" 2>/dev/null | awk 'NR==2{print $4}')"
  if [ -n "$FREE_KB" ]; then
    FREE_GB=$((FREE_KB / 1024 / 1024))
    if [ "$FREE_GB" -ge 5 ]; then
      pass "可用存储 ${FREE_GB}GB（一个号约 2GB：NapCat 1.5GB + 程序 0.1GB + 语音模型 0.3GB）"
    else
      warn "可用存储只有 ${FREE_GB}GB，偏少（建议留 5GB 以上）"
    fi
  fi
fi

# ---------- 3. Node ----------
head_ Node
if command -v node >/dev/null 2>&1; then
  NODE_V="$(node -v 2>/dev/null)"
  pass "已装 node $NODE_V"
  MAJOR="$(printf '%s' "$NODE_V" | sed 's/^v//' | cut -d. -f1)"
  MINOR="$(printf '%s' "$NODE_V" | sed 's/^v//' | cut -d. -f2)"
  # node:sqlite 免 --experimental-sqlite 是从 22.13 / 23.4 起（22.5~22.12 得额外加标志）
  if [ "${MAJOR:-0}" -gt 22 ] || { [ "${MAJOR:-0}" -eq 22 ] && [ "${MINOR:-0}" -ge 13 ]; }; then
    pass "版本够（要 22.13 以上）"
  else
    fail "版本太低，需要 22.13 以上（22.5~22.12 要额外加 --experimental-sqlite）"
    info "跑：pkg upgrade nodejs"
    info "装不上或想用 LTS：pkg install nodejs-lts"
  fi
  # 最关键的一项：数据库用的是 Node 自带的 node:sqlite
  if node -e "require('node:sqlite')" >/dev/null 2>&1; then
    pass "node:sqlite 可用（数据库靠它，这项必须过）"
  else
    fail "node:sqlite 用不了 —— 这是最关键的依赖"
    info "试试：pkg upgrade nodejs   （或 pkg install nodejs-lts）"
    info "还不行就把这行结果发我：node -e \"require('node:sqlite')\""
  fi
else
  warn "还没装 node"
  info "装它：pkg install nodejs"
fi

# ---------- 4. 其它工具 ----------
head_ 其它工具
for t in ffmpeg proot-distro screen pgrep curl awk; do
  if command -v "$t" >/dev/null 2>&1; then
    pass "$t 已装"
  else
    pkg_name="$t"
    [ "$t" = pgrep ] && pkg_name=procps
    [ "$t" = awk ] && pkg_name=gawk
    warn "$t 没装"
    info "装它：pkg install $pkg_name"
  fi
done
if command -v termux-wake-lock >/dev/null 2>&1; then
  pass "termux-wake-lock 可用（防后台被杀）"
else
  warn "termux-wake-lock 没有，跑：pkg install termux-tools"
fi

# ---------- 5. 网络 ----------
head_ 网络
# 用 bash 自带的 /dev/tcp 探一下，不依赖 curl
tcp() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 6 bash -c "exec 3<>/dev/tcp/$1/$2" >/dev/null 2>&1
  else
    bash -c "exec 3<>/dev/tcp/$1/$2" >/dev/null 2>&1
  fi
}
if tcp api.deepseek.com 443; then
  pass "能连 api.deepseek.com:443（模型接口）"
else
  fail "连不上 api.deepseek.com:443 —— 机器人没法回话"
  info "检查手机的网络、或者是否有代理挡着"
fi
if tcp nclatest.znin.net 443; then
  pass "能连 nclatest.znin.net:443（NapCat 安装源）"
else
  warn "连不上 nclatest.znin.net:443，NapCat 可能装不上"
fi
if tcp ghfast.top 443; then
  pass "能连 ghfast.top:443（GitHub 代理，语音识别模型从这里下）"
else
  warn "连不上 ghfast.top:443（只是语音识别要用，可以先不管）"
fi

# ---------- 汇总 ----------
printf '\n====================\n'
printf '通过 %d 项，警告 %d 项，失败 %d 项\n' "$ok" "$warn" "$bad"
printf '====================\n\n'

if [ "$bad" -eq 0 ]; then
  printf '\033[32m这台机器可以跑。\033[0m\n\n'
  if ! command -v node >/dev/null 2>&1; then
    printf '下一步：\n'
    printf '  pkg update && pkg install nodejs proot-distro screen termux-tools ffmpeg curl procps\n'
    printf '  然后把这个体检再跑一遍\n'
  else
    printf '下一步：装 NapCat（约 1.5GB，很久）\n'
    printf '  curl -o napcat.termux.sh https://nclatest.znin.net/NapNeko/NapCat-Installer/main/script/install.termux.sh && bash napcat.termux.sh\n'
  fi
else
  printf '\033[31m还有 %d 项没过，先解决上面标 ✗ 的。\033[0m\n' "$bad"
  printf '把这份输出发我，我来判断。\n'
fi
printf '\n'
