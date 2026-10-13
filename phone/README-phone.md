# AgentXiang 手机部署清单

目标机器：6GB 运存 / Kirin 970（arm64）/ 安卓或鸿蒙兼容版
全程**不需要 root**（华为那代机器也解不了 BL 锁，这条很重要）。

---

## 零、装 Termux（这一步的网站在国内打不开）

Termux 是唯一能跑这套东西的终端环境。**应用商店那个版本早就废弃了，装不上包。**
官方渠道是 F-Droid，但 `f-droid.org` 国内基本连不上，所以走清华的镜像：

| 组件 | 版本 | 直链（手机浏览器直接开） |
|---|---|---|
| **Termux（本体，必须）** | 0.118.3 稳定版 | <https://mirrors.tuna.tsinghua.edu.cn/fdroid/repo/com.termux_1002.apk> |
| Termux:Boot（开机自启，可选） | 0.8.1 | <https://mirrors.tuna.tsinghua.edu.cn/fdroid/repo/com.termux.boot_1000.apk> |
| Termux:Widget（桌面图标，可选） | 0.15.0 | <https://mirrors.tuna.tsinghua.edu.cn/fdroid/repo/com.termux.widget_1001.apk> |

或者用我下好并校验过的那三个（在 `termux-apk.zip` 里，sha256 跟 F-Droid 索引逐字节一致）：
`Termux-0.118.3.apk` / `Termux-Boot-0.8.1.apk` / `Termux-Widget-0.15.0.apk`。

装之前要在手机设置里**允许安装未知来源的应用**（华为：设置 → 安全 → 更多安全设置 → 安装外部来源应用）。

⚠️ 这三样必须来自同一个渠道（上面都是 F-Droid 签名的），别拿 GitHub 上下的版本混着装——签名不一样，会提示「应用未安装」。以后升级也用这个镜像，别换渠道。

装完先打开一次 Termux（首次启动要联网下它的基础包）。

---

## 零点五、把程序包弄进去，先体检

用 QQ 把 `agentxiang-phone.zip` 发给自己（或云盘下载到手机），然后在 **Termux** 里：

```bash
termux-setup-storage          # 弹权限框，点「允许」，让 Termux 能读手机存储
mkdir -p ~/pkg && cd ~/pkg
cp /sdcard/Download/agentxiang-phone.zip .   # 文件名按实际下载位置改
unzip agentxiang-phone.zip                    # 提示没有 unzip 就先 pkg install unzip
bash check-phone.sh
```

它会逐项体检并告诉你还差什么。**先只做这一步**，把输出发我，我再判断要不要往下走。

体检会看这些：

| 项 | 要求 | 不过会怎样 |
|---|---|---|
| 在 Termux 里 | 必须 | 别的终端 App 跑不了（要用 proot 容器） |
| 架构 | aarch64 | x86 机器没有对应的 NapCat/语音模型 |
| 安卓版本 | ≥ 7 | NapCat 跑不起来 |
| 内存 | ≥ 4GB | 一个号约需 0.7~1.2GB |
| 存储 | ≥ 5GB | NapCat 一个实例就 1.5GB |
| **`node:sqlite`** | **必须有** | **程序存不了数据，这是唯一的硬依赖** |
| 能连 api.deepseek.com | 必须 | 机器人没法回话 |

---

## 一、装依赖和程序

```bash
bash install-phone.sh
```

做三件事：装 `nodejs / proot-distro / screen / ffmpeg / curl / procps`、把程序放到 `~/agentxiang`、放好启动脚本。
**它不会替你执行从网上下载的脚本**——NapCat 那一步会打印命令，你自己确认后跑。

> 程序目录里的 `scripts/` 有一堆开发期用的一次性脚本（`fix-*`、`add-*`、`diag-*`……），
> 手机上**一个都不用跑**，照着这份清单走就行，那些是我调试时用的。

---

## 二、装 NapCat（QQ 协议端）

```bash
# 约 1.5GB，装进 proot 容器里，很久
curl -o napcat.termux.sh https://nclatest.znin.net/NapNeko/NapCat-Installer/main/script/install.termux.sh
less napcat.termux.sh        # 想看一眼就看，不想看直接下一步
bash napcat.termux.sh
```

装完先**前台启动一次扫码**（手机不能扫自己屏幕，用另一台设备扫）：

```bash
proot-distro sh napcat -- bash -c "xvfb-run -a /root/Napcat/opt/QQ/qq --no-sandbox"
```

扫完在 QQ 上勾选「下次登录无需手机确认」——**这一步做了以后就不用再扫码了**。

以后用快速登录，丢后台跑（关掉终端也不停）：

```bash
screen -dmS napcat bash -c 'proot-distro sh napcat -- bash -c "xvfb-run -a /root/Napcat/opt/QQ/qq --no-sandbox -q 机器人QQ号"'
```

- 回到这个会话看输出：`screen -r napcat`
- 离开但不关掉：**Ctrl+A 然后按 D**

---

## 三、启动机器人

```bash
cd ~/agentxiang
bash start-bot.sh            # 前台跑，日志直接打屏
bash start-bot.sh --screen   # 丢后台
```

然后在**手机浏览器**打开 `http://127.0.0.1:6188`：

1. 「接入与密钥」里填 DeepSeek 密钥
2. 「接入与密钥」里把 NapCat 地址填 `ws://127.0.0.1:3001`
3. 「名单」里把你自己和要用的群加进去（不加它不会理任何人）

---

## 四、装完体检

```bash
bash ~/agentxiang/verify-phone.sh
```

---

## 手机特有的坑

**① 两台设备才能完成首次登录。** 手机扫不了自己屏幕上的二维码，第一次要用另一台设备扫。

**② 华为/荣耀特别会杀后台。** 必须做两件事：
- Termux 里跑 `termux-wake-lock`（`start-bot.sh` 已经自动做了）
- 系统设置 → 应用 → Termux → 电池 → 关掉「智能省电」/ 允许后台活动

**③ 息屏会降频。** 语音识别是 CPU 推理，息屏后可能慢好几倍。要让它一直精神，得把屏幕设成常亮（充电时）。

**④ 只跑一个号。** 一个 NapCat 实例 = 一个 proot 容器 + 一个 Electron 版 QQ，官方标的存储占用就是 1.5GB。两个号在 6GB 机器上会很紧，而且第二个实例要手动克隆容器、改端口——安装器只管一个。**建议手机上先只跑一个号**，另一个继续留在电脑上。

**⑤ 别用应用商店的 Termux。** 那个版本早就废弃了，装不上包。

**⑥ 程序需要 Node ≥ 22.13**（22.5~22.12 得额外加 `--experimental-sqlite`），因为用了 Node 自带的 `node:sqlite`（好处是**零 npm 依赖**，手机上不用编译任何原生模块）。Termux 现在的 `pkg install nodejs` 给的是 24 以上，直接装就行；万一装出来偏旧，`pkg install nodejs-lts` 换个 LTS。

---

## 可选：让它开机就自己跑（最接近「装个 App」的玩法）

这个程序没法做成 APK——它底下要跑一个 Linux 容器里的 QQ 客户端（NapCat），
安卓的 APK 装不下这东西（详情见最后一节）。最接近「像个 App」的做法是装两个官方附加组件，
都在 F-Droid 上搜得到：

| 组件 | 作用 | 装完要注意 |
|---|---|---|
| Termux:Boot | 开机后自动把机器人拉起来 | 装完**先手动打开一次**，否则不生效；开机脚本放 `~/.termux/boot/` |
| Termux:Widget | 桌面上放个图标，点一下就启动 | 脚本放 `~/.shortcuts/` |

**这三样（Termux + 两个组件）必须都从 F-Droid 装。** 它们共用同一个签名，
混装别的来源（比如 GitHub 上下的）会提示签名不一致、装不上。

开机脚本长这样，存成 `~/.termux/boot/agentxiang.sh`（记得 `chmod +x`）：

```bash
#!/usr/bin/env bash
termux-wake-lock
sleep 20                                  # 等开机那阵忙完
cd ~/agentxiang
bash start-bot.sh --screen                # 机器人本体
screen -dmS napcat bash -c 'proot-distro sh napcat -- bash -c "xvfb-run -a /root/Napcat/opt/QQ/qq --no-sandbox -q 机器人QQ号"'
```

前提是 NapCat 已经**手动跑过一次并扫码登录**（见第二节），否则开机起来还是登不进去。

---

## 数据怎么过来

`data/` 里是你的聊天记录、配置、印象。安装包里**没有**这部分：

- 第一次启动会自动建新库（空的，机器人不认识任何人）
- 要把电脑上的记忆搬过来：把电脑的 `data/agentxiang.sqlite` 传过来覆盖
- **密钥不用搬**——它用 DPAPI 加密，只在那台电脑上解得开，手机上要重新填一次
- 「时段 / 名单 / 默认回复」也可以在界面上用「从另一个机器人复制配置」重建，不必搬文件

---

## 出问题了怎么查

```bash
# 程序日志
tail -50 ~/agentxiang/data/logs/system-$(date +%F).log
# 聊天日志（谁说了什么、为什么没回）
tail -50 ~/agentxiang/data/logs/chat-$(date +%F).log
# 代码本身能不能跑
node --no-warnings ~/agentxiang/scripts/phone-smoke.mjs
```

卡住就把输出发我。

---

## 为什么没有 APK

**做不出来，而且做出来也没用。**

1. **这台电脑没有打包环境。** 有 JDK，但没有 Android SDK、没有 Gradle、没有 adb，`ANDROID_HOME` 也没设。从零装齐要下 1GB 以上，而且 Gradle/AGP 跟新版 JDK 的兼容性没保证。
2. **更关键：APK 装不下需要的东西。** 机器人要连 QQ，靠的是 NapCat —— 它本质是「一个 Linux 容器里跑着 Electron 版 QQNT」。安卓 APK 的沙箱里跑不了这套；硬做一个 APK，它也只能是个壳，最后还是得把 Termux 那套重做一遍。
3. **所以最省事的路子是 Termux + 两个官方组件**（上一节「可选」）：桌面有图标、开机自启、后台常驻，用起来就是个装在手机上的程序。
