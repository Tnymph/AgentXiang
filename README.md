# AgentXiang（小向）

> **这是 AI 作品**：代码与文档由 AI 编写，人类提需求、验收、运行。
> 要接手或深改，先读 [docs/交接文档.md](docs/交接文档.md)——架构、硬约定和踩过的坑都在里面。

跑在自己电脑上的 QQ 聊天机器人。本地 Web 界面 + [NapCat](https://github.com/NapNeko/NapCatQQ)（OneBot 11）+ DeepSeek，
**零 npm 依赖**，只用 Node 22 自带的模块（`node:sqlite`、内置 `WebSocket`、`fetch`、`node:crypto`）。

不是那种"接个 API 就完事"的玩具：它管会话、管花销、管频控，能学人说话的风格，
还能用本地的语音模型把回复发成语音。

## 它能干什么

- **聊天**：私聊/群聊、@它、被点名、主动搭话（可调概率）、复读检测、默认回复兜底
- **语音**：语音条识别（本地 SenseVoice，不花钱）、文字转语音（sherpa-onnx / CosyVoice2 两种引擎）、
  变声（RVC：先用标准音色读出来、再换成目标音色）
- **接话**：群里出现了指定词句就自动接一句（固定话术不花模型钱，API 没开也照常工作）
- **学习**：往界面里粘聊天记录、投喂音频/视频（本地识别转文字），机器人总结成"风格卡"；
  也能 /learn 标记具体一句话的改法
- **控制**：时段方案（一天多套开关）、名单（谁的话理、谁的话不理）、频控、花销统计与趋势
- **记忆**：按人分的长短期记忆、按人的印象（定期自动提炼，不塞进系统提示词）
- **界面**：全中文的本地 Web 控制台，模型密钥只显示掩码，日志可打包导出

## 需要什么

| | |
|---|---|
| **必需** | Node.js ≥ 22.5、一个 QQ 小号、[NapCat](https://github.com/NapNeko/NapCatQQ)（QQ 的 OneBot 实现） |
| **模型** | DeepSeek API 密钥（在界面上填，加密存在本机） |
| **可选** | 语音识别/合成/变声的本地模型（不装的话对应功能自动关闭，其余照常跑） |

为什么非得用 NapCat 而不是官方机器人 API：官方接口读不了**合并转发的聊天记录**，
而"别人转发一段聊天记录进来"是这个机器人最常见的使用场景之一。

## 快速开始

```bat
:: 1. 装 Node 22（只有这一个硬依赖）
:: 2. 把仓库放到任意目录，然后：
node scripts/test-all.mjs        :: 先跑一遍自检（全部套件应显示通过）

:: 3. 装好 NapCat 并登录 QQ 小号（see docs/文件与路径总账.md 第 1 节）
::    NapCat 默认监听 ws://127.0.0.1:3001

:: 4. 一键拉起全套（NapCat + 机器人本体；加 --asr 还会起语音识别）
scripts\start-all.cmd

:: 5. 打开界面 → 「接入与密钥」页填 DeepSeek 密钥 → 完事
::    http://127.0.0.1:6188
```

关掉全部：`scripts\stop-all.cmd`（它只杀本项目的进程，不会碰你自己的 QQ）。

手机（Termux）上的部署脚本在 `phone/` 目录。

## 路径可以自定义（模型放在哪都行）

默认所有东西都在项目目录里，但**模型动辄几十 GB，完全可以把它们放到别的盘**。
四个根目录 + QQ 程序位置都可以改，三种改法（优先级从高到低）：

1. **环境变量**：`AGENTXIANG_TOOLS_DIR` / `AGENTXIANG_DATA_DIR` / `AGENTXIANG_STYLE_DIR` /
   `AGENTXIANG_INBOX_DIR` / `AGENTXIANG_QQ_EXE`
2. **`paths.json`**（项目根，把 `paths.example.json` 复制成 `paths.json` 再改）
3. **界面「运行 → 位置」卡片**：改完写进 `paths.json`，重启程序生效

```jsonc
{
  "toolsDir": "D:\\models\\agentxiang",   // 引擎、模型、音色、NapCat、Python 环境
  "dataDir":  "data",                     // 数据库、密钥、日志（留空 = 默认）
  "styleDir": "style-samples",            // 学习素材
  "inboxDir": "inbox",                    // 导出的日志
  "qqExe":    "C:\\Program Files\\Tencent\\QQNT\\QQ.exe"
}
```

- 值是**绝对路径**（换盘）或**相对项目根**的路径；留空/不写 = 用默认。
- 改完需要**整个重启程序**才生效（界面上的「重启」按钮就是干这个的）。
- 换位置**不会自动搬数据**：把旧目录里的文件拷到新位置去。
- 启动脚本（`scripts\*.cmd`）会自动跟着 `paths.json` 走，不用手改批处理。

## 目录结构

```
src/            机器人本体（入口 src/index.js）
  modules/      一个功能一个文件（接话、复读、学习、语音……）
  web/          本地 Web 界面（public/ 是纯前端，无构建步骤）
scripts/        冒烟测试（smoke-*.mjs）、统一入口 test-all.mjs、启动脚本（*.cmd）
docs/           文件与路径总账（每个模型从哪来）、需求确认书（功能与默认值）
phone/          Termux 手机部署脚本
style-samples/  学习素材（音频不放仓库里，转录文本在）
paths.json      可选：路径配置（见上一节）；不提交
data/           运行数据：数据库、加密密钥、日志（不提交）
.tools/         引擎与模型默认放这里（不提交）
```

## 测试

```bat
node scripts/test-all.mjs        :: 全部（29 套，约 1200 项检查）
node scripts/smoke-paths.mjs     :: 只跑某套
```

测试都尽量用独立命名空间（临时数据库、测试用 QQ 号），不动正在运行的机器人数据。

仓库里**没有**模型、样音、讲稿音频（都在 `.tools/` 和 `style-samples/audio|wav/`，几百 MB 起），
所以刚 clone 下来跑测试会有几处红或跳过，属正常：

- `smoke-asr`、`smoke-pipeline`：打印「跳过」（识别服务没开着或缺样音时）
- `smoke-forge`、`smoke-cosyvoice`、`smoke-tts`：需要音频素材和本地模型的几项会失败

三样齐了才是全绿：装好 `.tools` 里的模型、`style-samples` 放上素材、开着识别服务（`scripts\asr-server.cmd`）。

## 安全设计（够用但不吹）

- **密钥**：AES-256-GCM 加密落盘，界面只显示掩码，日志里过一遍打码表
- **界面接口**：会启停进程的接口要求自定义请求头（跨域预检挡掉"别的网页偷偷调"）
- **子进程**：参数一律走数组白名单，目录名/QQ 号进命令行前过正则，不开 shell
- **路径**：从文件系统扫出来的路径必须落在配置的目录里才能进命令行

## 文档

- `docs/文件与路径总账.md` —— 每个目录、每个模型、每个安装步骤（含国内网络下的坑）
- `docs/需求确认书-v1.md` —— 功能清单与默认值

## 许可

尚未指定（保留所有权利）。要开源/商用请先联系仓库主人定个许可。
