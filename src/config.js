// 配置：全局设置 + 每机器人独立设置
// 默认值来源 = docs/需求确认书-v1.md 第十三节「默认值清单」
import fs from 'node:fs';
import { CONFIG_FILE, DATA_DIR } from './paths.js';
import * as log from './logger.js';
import * as db from './db.js';

/** 一个机器人一份的默认设置 */
export function defaultBotSettings() {
  return {
    // ---- API 接入 ----
    api: {
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
      // 三态手动覆盖：force_on | force_off | auto（按时段）
      mode: 'auto',
      // 思考档位：low | high | auto
      effortMode: 'auto',
      vision: {
        enabled: true,
        // auto = 看这句话是不是在要求认字：认字切 high，其余用省钱的 low。
        // 低清档会把图缩到 512×512，长截图上的小字会糊掉。
        detail: 'auto',           // auto | low | high
        perHourLimit: 60,
        groupsOff: [],            // 这些群里不看图
        // 别人转发一段聊天记录进来时，里面的图读前几张送去识别。
        // 转发里动辄十几二十张图，全读一次就上万 token，所以默认封在 8 张。
        // 设 0 = 完全不读转发里的图（只把文字给他）。
        forwardMaxImages: 8,
      },
      voiceAsr: { enabled: true, maxSeconds: 60, timeoutMs: 30000 },
      // 从网上抓一条好笑的当聊天素材（只用一言，实测连通的那个）。
      // 默认关：开了才在「他像是在要个乐子」时去抓，randomRate 是
      // 主动模式下抽冷子自己讲一个的概率（0 = 只在他要的时候抓）。
      webJokes: { enabled: false, randomRate: 0, timeoutMs: 9000 },
      keepAlive: { enabled: false, intervalMin: 4 },   // 保温，默认关

      // 联网搜索：以工具（function call）的形式给模型，由它自己决定要不要查。
      // 关着就完全不带工具，行为和以前一模一样。密钥是全局一份，存在加密的
      // __global 槽位里，不在这个文件里。perHourLimit 防的是「模型搜上瘾」，
      // maxRounds 限制一次回复里最多搜几轮。
      search: {
        enabled: false,
        provider: 'bing',     // 必应免密钥；想更全就换 bocha（要密钥）
        count: 5,
        perHourLimit: 30,
        maxRounds: 2,
        timeoutMs: 12000,
      },
    },

    // ---- 语音识别服务（常驻进程，由 scripts/asr-server.cmd 启动）----
    asr: {
      host: '127.0.0.1',
      port: 6007,
    },

    // ---- 语音合成服务（CosyVoice2，常驻进程，由 scripts/cosyvoice-server.cmd 启动）----
    // 用哪个引擎由「音色」决定：音色 id 带 cosy: 前缀走这个服务，其余走 sherpa。
    cosy: {
      host: '127.0.0.1',
      port: 6011,
    },

    // ---- 变声服务（RVC，常驻进程，由 scripts/rvc-server.cmd 启动）----
    // 音色 id 带 rvc: 前缀时：先用上面那个 CosyVoice 服务按标准普通话念出来，
    // 再交给这个服务换成目标音色（声源在 .tools/rvc-voices/<名字>/voice.json 里配）。
    rvc: {
      host: '127.0.0.1',
      port: 6012,
    },

    // ---- 本机的 NapCat 地址 ----
    // 留空则用全局设置里的那个。多个机器人时**每个号必须配自己的地址**——
    // 一个 NapCat 实例只对应一个 QQ 号，共用同一个地址会让两个机器人抢同一条连接。
    napcatWsUrl: '',
    // 这个号用的是 .tools 下哪个 NapCat 目录（扫码登录页按它找二维码）
    napcatDir: 'napcat',
    // 这个号的 QQ 数据目录（QQNT 的 user-data-dir，登录态就存这里）。
    // 「运行」页的启动按钮用它拉起 NapCat；两个号必须各用各的，共用会让 QQ 反复被顶下线。
    napcatDataDir: 'qq-bot-data',

    // ---- 时段 ----
    schedule: {
      activeSlot: 1,
      // 方案切换立即生效，不做缓存
    },

    // ---- 发言控制 ----
    speak: {
      defaultGroupMode: 'passive',   // active | passive | off
      groupModes: {},                // 群号 -> active|passive|off
      privateMode: 'passive',        // 私聊只做被动
      // 昵称别名：群里没人会喊全名，通常只叫名字的一部分。
      // 不配的话「客服小向」被叫「小向」就触发不了。
      aliases: [],
      active: {
        perGroupPerHour: 5,          // 主动发言频控
        minGapSec: 60,
        minMessageLength: 2,         // 粗筛：太短不看
        randomRate: 0.15,            // 粗筛：随机命中率
      },

      // 单条消息的字数与切分。真人是一条一句往外蹦的，
      // 一大段话一口气发出来很「机器」，所以超长时本地按句拆开分几条发。
      replyMaxChars: 45,             // 提示词里的目标字数（同一条消息）
      // 讲题/举例时的目标字数。必须比上面大，否则模型会把例题也压成
      // 一句话的概括——表现就是「只答了一半、没给具体例子」。
      replyMaxCharsDetailed: 200,
      splitLongReplies: true,        // 超长时本地拆成几条
      maxSentences: 1,               // 日常闲聊：一条消息最多几句
      maxSentencesDetailed: 3,       // 讲解/专业问题：放宽到几句
      maxMessages: 3,                // 一次回复最多拆几条，防止刷屏
      segmentDelayMs: 350,           // 两条之间隔多久
      // 命中这些词就按「讲解」档处理。留空则用内置清单。
      detailedKeywords: [],

      // /learn 标记成功后的回话（可改）
      learnReplies: {
        goodex: '好，我记住这种说法了。',
        badex: '我知道了，会改变语言风格的。',
      },

      // 语音回复（本地合成，不花钱，但一条要 11 秒 CPU，所以护栏很紧）。
      // 四档：text 只发文字 / voice 全语音 / prob 按概率 / ai 由模型自己决定
      // 音色是共享资源（.tools/tts/<名字>/），这里只记用哪一个。
      voice: {
        mode: 'text',
        prob: 0.3,          // prob 档的命中率
        voiceId: '',        // 空 = 用清单里的第一个音色
        sid: 0,             // 多说话人音色的说话人编号
        quality: 'normal',  // normal | high | auto（auto = 讲题用高质量，其余用默认档）
        // 语速：0 = 用档位默认（克隆音色默认 0.82）。用户嫌快就调小（更小 = 更慢）
        speed: 0,
        maxChars: 26,       // 单条语音字数（20~30 字合适：一条约 11 秒）
        maxMessages: 2,     // 一次回复最多几条语音，超了整条退回文字
        // 模型自己点名要用语音时（ai 档写了 [语音]）放宽到这个条数。
        // 群里让人「朗读」一段诗是明确要求，被 2 条卡掉会显得答非所问。
        maxMessagesForced: 4,
        perHour: 20,        // 每小时语音条数上限
        // 句间补的静音毫秒数。vits 音色的停顿烧在模型里、参数调不动（实测），
        // 所以靠逐句合成再拼来补；代价是每个分句多起一次程序，克隆音色别开。
        pauseMs: 0,
        // 掐掉开头伪影（ZipVoice 类模型会在开头吐 0.5~1.5 秒不稳定音频）。
        // 靠识别回读定位正题从第几秒开始；trimExtraMs 是多切一点，trimFallbackMs 是定位不到时的保守硬切。
        // 掐完会再回读一次自检，内容掉太多自动还原。
        trimOnset: true,
        trimExtraMs: 250,
        trimFallbackMs: 900,
      },
    },

    // ---- 复读 ----
    repeatEcho: {
      enabled: true,
      minPeople: 2,                  // 至少几个不同的人
      maxGapMessages: 3,             // 允许中间隔几条消息
      windowMessages: 15,            // 检测窗口
      // 默认用最宽松档：复读时各人加的标点往往不一样，
      // 「这也太真实了」和「这也太真实了！！」必须算同一句，否则功能形同虚设。
      // 该档位同时用于频控的「重复内容」判断。
      matchMode: 'loosest',          // strict | loose | loosest
      minLength: 2,
      onlyActiveMode: true,          // 只在主动模式群生效
      followOnce: true,              // 只跟一次（写死也行，留字段便于以后放开）
      perGroup: {},                  // 群号 -> 覆盖项
    },

    // ---- 频控（三档，阈值全局单一值，按人计数）----
    rate: {
      repeat: { windowSec: 60, max: 1 },      // 重复内容：更严
      unique: { windowSec: 3600, max: 20 },   // 非重复内容
      global: { perMinute: 10, perHour: 300 },// 防风控，不分人
    },

    // ---- 上下文 ----
    context: {
      rounds: 20,                    // 记忆容量
      summary: { enabled: false, everyKRounds: 5 },
    },

    // ---- 印象 ----
    impression: { autoEnabled: true, maxChars: 300 },

    // ---- 历史 ----
    history: { retainDays: 30, maxPerSession: 2000 },

    // ---- 兜底回复 ----
    fallback: { cooldownSec: 30, sharedPool: true },

    // ---- 接话 ----
    // 命中触发词就主动接一句（规则在「接话」页里配，每个机器人一套）
    pickup: {
      enabled: true,             // 总开关（没配规则时本来也不会接）
      defaultCooldownSec: 60,    // 每条规则默认冷却秒数（单条规则可覆盖）
      maxPerHour: 20,            // 每小时最多接多少次，防规则太宽把群刷了
      // 「自己接自己」的概率：对方已经说了你要回的那句话时，只按这个概率接（0=从不，1=照接）
      selfChance: 0.3,
      // 被找茬时回一个字：语义判断交给模型（提示词里写 [急] 记号），本地只按概率放行。
      // 只认「直接挨骂」（nmsl/sb/nmd 那种程度），而且很少回 —— 一成。
      annoyed: {
        enabled: true,
        chance: 0.1,             // 模型想回时，真的发出去的概率（很少回）
        text: '急',              // 要回的那一个字/一句话
        when: '',                // 留空用内置描述（「直接挨骂」那段）
      },
    },

    // ---- 学习 ----
    learning: {
      sourceA: true,                 // 从机器人自己的历史回复学（可随时开关）
      sourceB: true,                 // 从手动标记的例子里学
      autoApply: false,              // 采纳默认全部人工审核
      trigger: 'manual',             // manual | daily | everyNDays
      everyNDays: 7,
      autoSnapshotKeep: 20,
    },

    // ---- 识别 ----
    visionGroupsOff: [],

    // ---- 命令 ----
    // 正文与页脚可在界面上改；descriptions 用来覆盖自动生成的命令说明，键形如 'learn.goodex'
    help: {
      body: '',
      footer: '',
      descriptions: {},
    },

    // ---- 语音生成 ----
    // 开关在 speak.voice 下（和发言控制放一起，因为它是「怎么说」的一部分）

    // ---- 日志 ----
    logs: { retainDays: 30, maxMB: 50, debug: false },
  };
}

/** 全局默认设置（跨机器人的） */
export function defaultGlobalSettings() {
  return {
    ui: { host: '127.0.0.1', port: 6188 },
    napcat: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '' },
    logs: { retainDays: 30, maxMB: 50 },
    // AI 互聊：同一群里几个机器人互相接话。默认关，用 /talk on|off 全体切换。
    // maxChain 是刹车：连续这么多条都是机器人说的就停下，等真人开口。
    // 没有它两个号会一直来回说，直到把额度烧完。
    talk: {
      enabled: false,
      minGapMs: 1500,      // 同一个群里，机器人两次发言至少隔这么多毫秒
      maxChain: 6,         // 连续几条都是机器人在说就停
    },
  };
}

// ---------- 深合并 ----------

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 把 patch 深合并进 base，返回新对象（不改动入参） */
export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

// ---------- 全局设置 ----------

let globalCache = null;

export function loadGlobal() {
  if (globalCache) return globalCache;
  let raw = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    log.warn('config', 'global config unreadable, using defaults', String(e.message));
  }
  globalCache = deepMerge(defaultGlobalSettings(), raw);
  return globalCache;
}

export function saveGlobal(patch) {
  globalCache = deepMerge(loadGlobal(), patch ?? {});
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(globalCache, null, 2), 'utf8');
  log.info('config', 'global saved');
  return globalCache;
}

// ---------- 每机器人设置 ----------

/** 读某机器人的设置（默认值 + 库里的覆盖） */
export function botSettings(botId) {
  const row = db.getBot(botId);
  let stored = {};
  if (row?.settings) {
    try { stored = JSON.parse(row.settings); } catch { stored = {}; }
  }
  return deepMerge(defaultBotSettings(), stored);
}

/** 写某机器人的设置（深合并 patch） */
export function saveBotSettings(botId, patch) {
  const next = deepMerge(botSettings(botId), patch ?? {});
  db.updateBotSettings(botId, next);
  log.info('config', 'bot settings saved', { botId });
  return next;
}
