// 消息管线：把各模块串成一条处理链
//
// 顺序（每一步都可以单独停下来并记录原因）：
//   自己的机器人？ → 名单 → 建会话/人 → 存历史 → 命令
//   → 复读窗口 → 要不要说话 → 兜底 or 模型 → 频控 → 发送
//
// 缓存约束：system prompt 由 persona 模块产出且逐字节稳定；
// 印象、时间、在场信息、模式提示一律拼进本次的 tail，绝不进 system。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';
import * as log from './logger.js';
import * as llm from './llm.js';
import * as search from './modules/search.js';
import * as history from './history.js';
import * as net from './net.js';
import { normalizeEvent } from './message.js';
import * as names from './names.js';
import * as sch from './modules/schedule.js';
import * as lists from './modules/lists.js';
import * as rate from './modules/rateLimit.js';
import * as echo from './modules/repeatEcho.js';
import * as pickup from './modules/pickup.js';
import { randomInt } from 'node:crypto';

/** 0~1 的随机数（用 CSPRNG：这类判断不需要密码学强度，但扫描器会盯着 Math.random） */
const coin = () => randomInt(0, 1_000_000) / 1_000_000;
import * as fallback from './modules/fallback.js';
import * as speaking from './modules/speaking.js';
import * as persona from './modules/persona.js';
import * as impression from './modules/impression.js';
import * as cmds from './modules/commands.js';
import * as voice from './modules/voice.js';
import * as voiceOut from './modules/voice-out.js';
import * as talk from './modules/talk.js';
import * as jokes from './modules/jokes.js';
import * as forward from './modules/forward.js';
import { botSettings } from './config.js';

// 素材与提问常常分两条发：先甩一张图（或一段语音、一张转发卡片），再说话或 @ 一下。
// 所以只把**上一条**的内容暂存下来，供紧接着的下一条使用；不做链式累积。
const CARRY_WINDOW_MS = 180_000;

export class BotWorker {
  constructor({ bot, client, chatFn = null }) {
    this.botId = bot.id;
    this.botName = bot.name;
    this.client = client;
    // 允许注入模型调用：测试时用桩，生产时用真实客户端。
    // 这样行为断言不依赖线上服务，测试才可靠。
    this.chatFn = chatFn ?? llm.chat;
    this.selfId = null;
    this.nicknames = [];
    this.selfQqs = db.selfQqSet();
    this.lastError = null;
    this.sessionCtx = new Map();     // sessionKey -> 最近一条带内容的上下文
  }

  /**
   * 记住**上一条**消息的内容，并在合适时借给当前这条。
   *
   * 场景：用户先发一张图 / 一段语音 / 一张转发卡片，紧接着再说话或只 @ 一下。
   * 两条消息是分开的，不动手脚的话模型只会看到后面那条空消息。
   *
   * 只从上一条承接，不做链式累积——否则隔了两三条的旧图会被反复借出来，
   * 机器人会莫名其妙地反复分析一张早就聊过的图。
   */
  noteContext(msg, ownText) {
    const key = msg.sessionKey;
    const now = Date.now();
    const prev = this.sessionCtx.get(key);

    const ownImages = [...(msg.images ?? [])];
    const ownForwards = [...(msg.forwardIds ?? [])];
    const ownVoices = [...(msg.voices ?? [])];

    // 当前这条自己带了素材（图片/语音/转发/视频这类）时，就不该再借上一条的素材
    const hasOwnMedia = ownImages.length > 0
      || ownVoices.length > 0
      || ownForwards.length > 0
      || (msg.unsupported?.length ?? 0) > 0;

    if (prev && now - prev.at < CARRY_WINDOW_MS) {
      // 文字：只在当前这条完全没文字、也没带素材时借（就是「只发了个 @」那种）
      if (!msg.textClean && !hasOwnMedia && prev.text) {
        msg.textClean = prev.text;
        msg.textFromPrevious = true;
      }
      // 素材：他先发图、再打字问，是常见操作，所以只要当前没带素材就借
      if (!hasOwnMedia && prev.images.length) {
        msg.images = [...prev.images];
        msg.imagesFromPrevious = true;
      }
      if (!hasOwnMedia && prev.forwardIds.length) {
        msg.forwardIds = [...prev.forwardIds];
        msg.forwardsFromPrevious = true;
      }
    }

    this.sessionCtx.set(key, {
      at: now,
      text: ownText || '',
      images: ownImages,
      forwardIds: ownForwards,
    });
  }

  get settings() {
    return botSettings(this.botId);
  }

  /** 连接就绪：补齐自身信息 */
  async onReady(selfId) {
    this.selfId = String(selfId ?? '');
    try {
      const info = await this.client.getLoginInfo();
      this.nicknames = [info?.nickname, info?.nickname ? '' : null].filter(Boolean);
      log.info('worker', 'ready', { botId: this.botId, selfId: this.selfId, nicknames: this.nicknames });
    } catch (e) {
      log.warn('worker', '拿不到登录信息', String(e.message));
    }
  }

  // ---------- 入口 ----------

  /**
   * 刷新群成员花名册（后台进行，失败不影响主流程）。
   *
   * 为什么要它：NapCat 收消息时不发 at 段的 name 字段，我们只有 QQ 号。
   * 常说话的人库里已有名字，但**从没发过言的群友**就只能靠花名册。
   * 一次取一整群、缓存半小时，成本很低。
   */
  refreshRoster(groupId) {
    if (!names.rosterStale(this.botId, groupId)) return;
    names.markRosterPending(this.botId, groupId);
    this.client.call('get_group_member_list', { group_id: Number(groupId) }, 30000)
      .then((list) => names.rememberRoster(this.botId, groupId, list))
      .catch((e) => {
        names.markRosterFailed(this.botId, groupId);
        log.debug('names', '取群成员花名册失败', { botId: this.botId, groupId, err: String(e.message) });
      });
  }

  async onMessage(event) {
    const settings = this.settings;

    // 昵称别名随时可改，所以每次按当前设置拼，而不是只在连接时算一次。
    // 用户往往只叫名字的一部分（「客服小向」被叫成「小向」），不配别名就会漏触发。
    const settingsAliases = settings?.speak?.aliases;
    const nicknames = [
      ...this.nicknames,
      ...(Array.isArray(settingsAliases) ? settingsAliases.filter(Boolean) : []),
    ];

    // NapCat 的 at 段只给 QQ 号不给名字，得我们自己补（见 src/names.js）。
    // 花名册是异步取的，所以本条消息可能还用不上——库里见过的名字会先兜住。
    const groupId = event.message_type === 'group' ? String(event.group_id ?? '') : '';
    if (groupId) this.refreshRoster(groupId);

    const msg = normalizeEvent(event, {
      selfId: this.selfId,
      nicknames,
      // 命令前的 @ 只有指向我们自己机器人的才算「指名」（见 cmdline.js）
      isBot: (qq) => this.selfQqs.has(String(qq)),
      resolveName: (qq) => names.resolveName(this.botId, qq, {
        groupId: groupId || null,
        selfId: this.selfId,
        selfNames: nicknames,
      }),
    });
    if (!msg) return;
    msg.botId = this.botId;

    // AI 互聊是否有开（全局开关，/talk on|off 切的）
    const talkCfg = talk.talkConfig();
    // 这条是不是我们自己的另一个机器人发来的
    const fromOurBot = this.selfQqs.has(msg.senderQq);

    // 1) 我们自己的一批机器人：默认互不响应，连历史都不记（当对方不存在）。
    //    开了 /talk 才往下走——必须让对方的话进历史，否则这边根本看不见它说了啥。
    if (fromOurBot && !talkCfg.enabled) {
      return this.skip(msg, '自己的机器人');
    }

    // 2) 名单。自己人（我们自己的另一个机器人）不受名单管——
    //    名单是用来管「外人」的；拦下自己的另一个号，只会让 /talk 开了却静默失效。
    if (!fromOurBot) {
      const access = lists.canInteract(this.botId, {
        kind: msg.kind, senderQq: msg.senderQq, groupId: msg.kind === 'group' ? msg.peerId : null,
      });
      if (!access.accept) return this.skip(msg, access.reason);
    }

    // 2.5) 语音条识别：识别成功就把文字并进消息，后续流程当普通文本处理。
    //      识别不成功则标记为无法处理，让兜底回复接手，而不是拿空消息去问模型。
    if (msg.voices.length) {
      const v = await voice.transcribeVoices(this.client, msg, settings);
      if (v.text) {
        voice.mergeVoiceText(msg, v.text);
        log.chat({ bot: this.botId, session: msg.sessionKey, direction: 'in', who: msg.senderName || msg.senderQq, text: msg.textClean, branch: 'asr:ok' });
      } else {
        if (!msg.unsupported.includes('voice')) msg.unsupported.push('voice');
        log.chat({
          bot: this.botId, session: msg.sessionKey, direction: 'in',
          who: msg.senderName || msg.senderQq, text: '(语音)', branch: 'asr:fail',
          extra: v.errors.join('；').slice(0, 160),
        });
      }
    }

    // 3) 会话与人
    const session = db.ensureSession(this.botId, msg.kind, msg.peerId);
    const personId = db.ensurePersonByQq(this.botId, msg.senderQq);
    db.touchSession(session.id);

    // 3.5) 素材与文字可能在两条消息里，先做一次上下文借用
    this.noteContext(msg, msg.textClean);

    // 4) 存历史（命令消息打标记，读取记忆时会被排除）
    const isCommand = !!msg.command;
    const flags = [
      isCommand ? 'command' : '',
      // 文字是从上一条借来的（典型场景：先发图/语音，再单独发一个 @）。
      // 这类消息在历史里读起来自然，但它并不是这个人在这条消息里说的话，
      // 提炼人物档案时要把它们排除，否则同一句会被算两次。
      msg.textFromPrevious || msg.imagesFromPrevious || msg.forwardsFromPrevious ? 'carried' : '',
      msg.images.length ? 'image' : '',
      msg.voices.length ? 'voice' : '',
      msg.forwardIds.length ? 'forward' : '',
      // 另一个机器人发来的：进历史（互聊要靠它看对方说了什么），
      // 但不算「这个人说的话」，也不计入连续发言长度里的真人那一侧
      fromOurBot ? 'frombot' : '',
    ].filter(Boolean).join(',');
    const textForHistory = msg.textClean || msg.text;
    const savedId = history.saveUserMessage({
      botId: this.botId, sessionId: session.id, msgId: msg.messageId, personId,
      senderQq: msg.senderQq, senderName: msg.senderName, text: textForHistory, flags,
      // 图片地址单独存一列：聊天记录靠它显示图片，但它不能进 text（会被当成聊天内容）
      media: (msg.images ?? []).map((img) => ({ kind: 'image', url: img.url || img.file })),
    });
    log.chat({
      bot: this.botId, session: msg.sessionKey, direction: 'in', who: msg.senderName || msg.senderQq,
      text: textForHistory || '(无文本)', branch: isCommand ? 'command' : '',
      // 原始文本与「借用后」的文本不一致时都记下来。
      // 之前排查命令没生效时就卡在这里：数据库里存的是借用后的文本，
      // 看起来完全正常，但实际收到的内容并不是这个。
      extra: msg.text === textForHistory ? '' : `原始=${JSON.stringify(msg.text).slice(0, 60)}`,
    });

    // 4.5) AI 互聊的刹车：连续几条都是机器人在自说自话就停下，等真人开口。
    //      没有这一条，两个机器人会一直来回接话，烧到额度耗尽为止。
    if (fromOurBot) {
      if (msg.kind !== 'group') return this.skip(msg, 'AI 互聊只在群里');
      if (String(msg.senderQq) === String(this.selfId ?? '')) return this.skip(msg, '自己发的');
      const chain = history.botChainLength(this.botId, session.id);
      if (chain >= talkCfg.maxChain) {
        return this.skip(msg, `AI 互聊连到上限(${chain}/${talkCfg.maxChain})`);
      }
    }

    // 5) 命令
    if (isCommand) {
      // 命令指名了别的机器人 → 这条不是给我的，完全别吭声。
      // （否则群里一个命令会得到两份回复，另一个号还会把这句当普通聊天接话）
      const responder = msg.command.responder;
      if (responder && String(responder) !== String(this.selfId ?? '')) {
        return this.skip(msg, '命令指名了别的机器人');
      }
      const done = await this.handleCommand(msg, session, personId, settings, savedId);
      if (done) return;
    }

    // 6) 复读窗口（群里每条都要记，机器人自己的发言也要记）
    if (msg.kind === 'group') {
      echo.noteMessage(this.botId, msg.peerId, {
        senderQq: msg.senderQq, text: textForHistory, isBot: false,
      });
    }

    // 7) 决定要不要说话
    await this.considerReply(msg, session, personId, settings);
  }

  skip(msg, reason) {
    log.chat({
      bot: this.botId, session: msg.sessionKey, direction: 'in',
      who: msg.senderName || msg.senderQq, text: msg.textClean || msg.text, branch: `skip:${reason}`,
    });
    return null;
  }

  // ---------- 命令 ----------

  async handleCommand(msg, session, personId, settings, savedId) {
    const def = cmds.findCommand(msg.command.name);
    if (!def) {
      log.chat({ bot: this.botId, session: msg.sessionKey, direction: 'in', who: msg.senderQq, text: msg.text, branch: 'unknown-command' });
      return false;                       // 未知命令不当命令处理，交给后面的流程
    }
    if (!cmds.isAdminOnly(def.name) || cmds.admins.isAdmin(this.botId, msg.senderQq)) {
      const ctx = this.makeCommandCtx(msg, session, personId, settings);
      let result;
      try {
        result = await def.handler(ctx, msg.command.args ?? []);
      } catch (e) {
        log.error('worker', '命令执行抛错', { command: def.name, err: String(e.message) });
        result = { effect: { kind: 'none' }, error: '命令执行出错' };
      }

      const logId = cmds.logCommand({
        botId: this.botId, sessionId: session.id, actorQq: msg.senderQq,
        command: def.name, args: msg.command.argText ?? '',
        cmdMsgId: msg.messageId, outMsgId: result?.effect?.outMsgId ?? null,
        effect: result?.effect ?? { kind: 'none' },
      });
      ctx.commandLogId = logId;

      // 失败才吭声，成功默认静默（避免「已撤销」这类消息本身又成为可撤销目标）
      if (result?.error) {
        try { await ctx.send(result.error); } catch { /* 忽略 */ }
      }
      log.chat({
        bot: this.botId, session: msg.sessionKey, direction: 'in', who: msg.senderQq,
        text: msg.text, branch: `command:${def.name}${result?.error ? ':err' : ':ok'}`,
      });
      return true;
    }

    // 非管理员：完全静默，不暴露
    log.chat({ bot: this.botId, session: msg.sessionKey, direction: 'in', who: msg.senderQq, text: msg.text, branch: 'command:non-admin' });
    return true;
  }

  makeCommandCtx(msg, session, personId, settings) {
    return {
      botId: this.botId, settings, sessionId: session.id, personId,
      senderQq: msg.senderQq, senderName: msg.senderName,
      kind: msg.kind, peerId: msg.peerId, msg, client: this.client,
      quoteId: msg.replyId,
      // 命令里要读图（比如 /learn quote 引用一张截图）时用得上
      chatFn: this.chatFn,
      prepareImages: this.prepareImages.bind(this),
      commandLogId: null,
      send: async (text) => this.send(msg.kind, msg.peerId, text),
    };
  }

  // ---------- 说话决策 ----------

  async considerReply(msg, session, personId, settings) {
    const kind = msg.kind;
    const groupId = kind === 'group' ? msg.peerId : null;
    const mode = speaking.decideMode(settings, { kind, peerId: msg.peerId });

    if (mode === 'off') return this.skip(msg, '该会话已关闭发言');

    // 被动触发：被 @ 或被叫名字。私聊里没有 @ 这回事，所以私聊的被动 = 每条都回。
    let trigger = msg.atSelf ? 'passive' : null;
    if (!trigger && kind === 'private') trigger = 'passive';
    let echoCandidate = null;

    // API 没接入时**绝不主动说话**。
    // 主动发言和复读都要先送模型判断「这句要不要接」，模型不在场就只剩一句兜底话术，
    // 拿去接一句不相干的话，看起来像机器人坏了——它本来就不该有反应。
    // 被点名（被动）不受影响，那条路径下面会走默认回复。
    const apiState = sch.isApiActive(this.botId, settings);
    const canSpeakUp = apiState.active;

    // 接话：命中你配好的触发词就一定接一句。
    // 放在复读/主动之前：规则是你写死的，优先级比「随机粗筛」和「涌现式复读」高。
    // **@ 了也接**（覆盖被动触发）：实测用户 @ 着说触发词时，等的是那句固定回答，
    // 而不是模型的自由发挥 —— 一开始做成「被 @ 不抢」，他直接反馈「回复不了」（2026-09-27）。
    // 私聊里 kind 不是 group，所以接话仍只在群里生效。
    let pickupHit = null;
    if (groupId) {
      const pk = pickup.cfg(settings);
      if (pk.enabled) {
        const hit = pickup.matchEligible(this.botId, msg.textClean || msg.text, settings);
        if (hit.rule) {
          // 「自己接自己」：对方说的这句里已经含有这条规则要回的话（例如规则「原神 → 原神怎么你了」，
          // 而对方正好说了「原神怎么你了」）。照接会像复读机，所以只按 selfChance 的概率接。
          const self = pickup.isSelfCase(hit.rule, msg.textClean || msg.text);
          if (self && coin() >= pk.selfChance) {
            log.chat({
              bot: this.botId, session: msg.sessionKey, direction: 'in', who: msg.senderName,
              text: msg.textClean, branch: `pickup:self-skip:${hit.rule.id}`,
            });
          } else if (hit.rule.mode === 'ai' && !canSpeakUp) {
            // ai 模式要模型在场才接得动；固定话术不需要 API，等下面直接发
            log.chat({
              bot: this.botId, session: msg.sessionKey, direction: 'in', who: msg.senderName,
              text: msg.textClean, branch: `pickup:ai:api_off:${hit.rule.id}`,
            });
          } else {
            trigger = 'pickup';
            pickupHit = hit.rule;
          }
        } else if (hit.cooling) {
          log.chat({
            bot: this.botId, session: msg.sessionKey, direction: 'in', who: msg.senderName,
            text: msg.textClean, branch: `pickup:cooling:${hit.cooling.retryInSec}s`,
          });
        }
      }
    }

    // AI 互聊：自己人（我们自己的另一个机器人）发来的话一律接。
    // 不接的话这个功能等于没用——群里是主动模式的话靠随机粗筛，被动模式则永远不响应。
    // 安全性靠另外两道闸门：/talk 的连续上限，以及按人/全局的频控。
    // API 没接入时不接：那样只会拿兜底话术和另一个机器人来回刷屏。
    if (!trigger && canSpeakUp && talk.talkConfig().enabled && this.selfQqs.has(msg.senderQq)) {
      trigger = 'talk';
    }

    // 复读候选（仅在主动模式）
    if (!trigger && canSpeakUp && groupId && speaking.echoAllowed(settings, groupId)) {
      const c = echo.detect(this.botId, groupId, settings);
      if (c) { trigger = 'echo'; echoCandidate = c; }
    }

    // 主动发言：本地粗筛
    if (!trigger && canSpeakUp && groupId && mode === 'active') {
      const pf = speaking.prefilter(msg, settings);
      if (pf.pass) trigger = 'active';
      else return this.skip(msg, `粗筛:${pf.reason}`);
    }

    if (!trigger) {
      if (!canSpeakUp && mode === 'active') return this.skip(msg, 'API 未接入，不主动说话');
      return this.skip(msg, mode === 'active' ? '未触发' : '非主动模式且未提及');
    }
    // 回复名单同样不管自己人（理由同上面的接受名单）
    if (!this.selfQqs.has(msg.senderQq) && !accessReply(this.botId, msg)) {
      return this.skip(msg, '回复名单未放行');
    }

    // 接了固定话术：本地直接发。不花模型钱，也不要求 API 在线
    //（和兜底话术同一类东西：模型不在场时唯一还能说人话的路径）。
    if (pickupHit && pickupHit.mode === 'fixed') {
      // 一句话可以配好几种回法：随机挑一种，且**这段对话里挑过的先不挑**，
      // 全挑过一轮才允许重复（否则同一个词连着出现时它会一直说同一句）。
      const picked = pickup.pickVariant(this.botId, session.id, pickupHit);
      const text = String(picked.text ?? '').trim();
      if (!text) return this.skip(msg, '接话规则没有话术');
      const gate = rate.allow(this.botId, settings, {
        personId, text, kind, peerId: msg.peerId,
        repeatMatchMode: settings.repeatEcho?.matchMode,
      });
      if (!gate.ok) {
        log.chat({ bot: this.botId, session: msg.sessionKey, direction: 'in', who: msg.senderName, text: msg.textClean, branch: `pickup:ratelimited:${gate.reason}` });
        return null;
      }
      const booked = pickup.commit(this.botId, pickupHit, settings);
      if (!booked.ok) {
        log.chat({ bot: this.botId, session: msg.sessionKey, direction: 'in', who: msg.senderName, text: msg.textClean, branch: `pickup:quota:${booked.why}` });
        return null;
      }
      pickup.noteHit(this.botId, pickupHit.id);
      log.chat({
        bot: this.botId, session: msg.sessionKey, direction: 'in', who: msg.senderName,
        text: msg.textClean, branch: `pickup:fixed:${pickupHit.id}`, extra: JSON.stringify(pickupHit.pattern),
      });
      return this.sendReply(kind, msg.peerId, text, {
        personId, trigger: `pickup:${pickupHit.id}`, sessionId: session.id, settings, question: msg.textClean,
      });
    }

    // API 未接入 → 走默认回复（能走到这里说明是被点名的）
    if (!apiState.active) {
      return this.sendFallback(msg, personId, settings, 'api_off', apiState.reason);
    }

    // 接话的 ai 模式要花模型钱，所以**动手之前**先记账：生成失败也不退。
    // 和语音配额一个思路 —— 宁可少接一句，也不要群里每命中一次就白调一次模型。
    if (trigger === 'pickup' && pickupHit) {
      const booked = pickup.commit(this.botId, pickupHit, settings);
      if (!booked.ok) {
        log.chat({ bot: this.botId, session: msg.sessionKey, direction: 'in', who: msg.senderName, text: msg.textClean, branch: `pickup:quota:${booked.why}` });
        return null;
      }
      pickup.noteHit(this.botId, pickupHit.id);
    }

    // 纯无法处理的消息 → 走类型兜底
    if (speaking.isUnprocessable(msg)) {
      const scene = speaking.fallbackScene(msg) ?? 'other';
      return this.sendFallback(msg, personId, settings, scene, `无法处理:${scene}`);
    }

    // 准备合并转发内容。转发里的图也要送去识别——
    // 只给模型看「[图片]」两个字，它没法回答「这聊天记录里说了啥」。
    let forwardText = '';
    let forwardImages = { list: [], total: 0 };
    if (msg.forwardIds?.length) {
      const maxImages = Number(settings.api?.vision?.forwardMaxImages ?? forward.DEFAULT_MAX_FORWARD_IMAGES);
      const f = await forward.readAllForwards(this.client, msg.forwardIds, { maxImages });
      if (f.ok) {
        forwardText = f.text;
        forwardImages = { list: f.images ?? [], total: f.imageTotal ?? 0 };
      }
    }

    // 准备图片：本条消息自己带的 + 转发里的，一起走同一个成本闸门
    const prepared = await this.prepareImages(msg, settings, forwardImages.list);
    const images = prepared.images;

    // 从网上抓一条好笑的当素材（默认关）。两种触发：
    //  · 他明摆着在要个乐子（本地关键词判，不花模型调用）
    //  · 主动模式下抽冷子自己讲一个（randomRate，默认 0 = 不主动讲）
    const joke = await this.maybeFetchJoke(msg, settings, trigger);

    // 组装并请求
    const tail = this.buildTail({
      msg, personId, settings, trigger, echoCandidate, pickupHit,
      hasImages: images.length > 0,
      forwardText,
      forwardImageTotal: forwardImages.total,
      forwardImagesRead: prepared.forwardRead,
      joke,
    });
    const system = persona.buildSystemPrompt(this.botId, { botName: this.botName, settings });
    const hist = history.recentHistory(this.botId, session.id, settings?.context?.rounds ?? 20, {
      withSpeaker: kind === 'group',
    });

    const apiKey = (await import('./secrets.js')).getApiKey(this.botId);
    // 认字的场景自动升高清晰度：低清档会把图缩到 512×512，小字会糊掉
    const detail = pickImageDetail(`${msg.textClean ?? ''} ${msg.text ?? ''}`, settings.api.vision.detail ?? 'auto');
    // 联网搜索：开着才把工具交给模型，由它自己决定要不要查
    const searchCfg = settings.api.search ?? {};
    const toolsOn = searchCfg.enabled === true;
    const tools = toolsOn ? [search.TOOL_SPEC] : undefined;

    const buildCall = (maxTokens, extraHistory) => ({
      botId: this.botId, apiKey,
      baseUrl: settings.api.baseUrl, model: settings.api.model,
      scene: 'chat',
      system, history: extraHistory ? [...hist, ...extraHistory] : hist,
      tail: images.length ? llm.withImages(tail, images, detail) : tail,
      effort: llm.pickEffort(settings.api.effortMode, 'chat'),
      maxTokens,
      tools,
    });

    let r = await this.chatFn(buildCall(llm.DEFAULT_MAX_TOKENS));

    // 工具回路：模型要求查资料，就先替它查，把结果当成 role:'tool' 的消息再问一轮。
    // 查不到、超上限、没配密钥，都照样回一句实话给它 —— 这样它至少不会瞎编，
    // 而不是卡在这里不吭声。轮数、每小时次数都有上限，免得它搜上瘾。
    if (toolsOn && r.ok) {
      let extra = [];
      const maxRounds = Math.max(1, Number(searchCfg.maxRounds) || 2);
      for (let round = 0; round < maxRounds; round++) {
        // 一轮里模型可能同时要调好几个工具。接口要求每个 tool_call_id 都有对应的
        // tool 消息回来，少一个整个请求就 400 —— 所以这里必须逐个回答，不能只答一个。
        const calls = (r.toolCalls ?? []).filter((c) => c?.id);
        if (!calls.length) break;
        const answers = [];
        for (const call of calls) {
          let note;
          if (call.function?.name !== 'web_search') {
            note = `没有「${call.function?.name}」这个工具。`;
          } else {
            let args = {};
            try { args = JSON.parse(String(call.function?.arguments ?? '{}')); } catch { args = {}; }
            const query = search.cleanQuery(args.query);
            const quota = search.searchQuota(this.botId, Number(searchCfg.perHourLimit) || 30);
            if (!query) {
              note = '搜索词是空的。换一个更具体的说法再试，或者直接用你已有的知识回答。';
            } else if (!quota.ok) {
              note = '这一小时查得太多了，先用你已经知道的东西回答，并说明没有联网核实。';
            } else {
              const searchKey = (await import('./secrets.js')).getSearchKey();
              const res = await search.searchWeb(query, {
                apiKey: searchKey,
                provider: searchCfg.provider,
                count: Number(searchCfg.count) || 5,
                timeoutMs: Number(searchCfg.timeoutMs) || 12000,
              });
              if (res.ok) {
                search.noteSearch(this.botId);
                note = search.formatForModel(res.results);
              } else {
                note = `搜索没成功（${res.error}）。别编造，直接说没查到。`;
              }
              log.info('worker', 'web_search', { botId: this.botId, query, ok: res.ok, reason: res.ok ? '' : res.error });
            }
          }
          answers.push({ role: 'tool', tool_call_id: call.id, content: note });
        }
        extra = [
          ...extra,
          { role: 'assistant', content: r.text ?? '', tool_calls: r.toolCalls },
          ...answers,
        ];
        r = await this.chatFn(buildCall(llm.DEFAULT_MAX_TOKENS, extra));
      }
      // 搜到轮数用完它还在要工具、一句话没说 —— 收掉工具，逼它用现有信息回答
      if (r.ok && !String(r.text ?? '').trim() && (r.toolCalls ?? []).length) {
        r = await this.chatFn({ ...buildCall(llm.RETRY_MAX_TOKENS, extra), tools: undefined });
      }
    }

    // 思考与可见输出共享 token 预算。预算不足时会被思考吃光、返回空字符串，
    // 这里必须识别出来并翻倍重试，否则表现为「机器人明明在线却不说话」。
    // 注意：要调工具时 text 本来就是空的（finish_reason 是 tool_calls），别误判成预算不够。
    const burnedByReasoning = r.ok
      && r.finishReason !== 'tool_calls'
      && (!r.text || !r.text.trim())
      && (r.finishReason === 'length' || (r.usage?.reasoning ?? 0) > 0);
    if (burnedByReasoning) {
      log.warn('worker', '思考吃光了输出预算，扩大后重试', {
        botId: this.botId, scene: 'chat',
        first: r.usage?.completion, reasoning: r.usage?.reasoning, finish: r.finishReason,
      });
      r = await this.chatFn(buildCall(llm.RETRY_MAX_TOKENS));
    }

    if (!r.ok) {
      this.lastError = r.error;
      log.error('worker', '模型调用失败', { botId: this.botId, err: r.error });
      return;
    }

    let text = normalizeReply(r.text);
    if (!text) {
      log.chat({
        bot: this.botId, session: msg.sessionKey, direction: 'bot', text: '', branch: `${trigger}:empty`,
        extra: `completion=${r.usage?.completion} reasoning=${r.usage?.reasoning} finish=${r.finishReason}`,
      });
      return;
    }

    // 模型想「只回一个字」（被找茬时）：记号在哪儿出现都剥掉，**不管开关开没开** ——
    // 绝不让 [急] 泄漏到群里（语音记号那次泄漏过，教训）；剥完按配置的概率决定发哪个。
    const annoyed = pickup.annoyedCfg(settings);
    const a = pickup.extractAnnoyed(text);
    if (a.marked) {
      if (!annoyed.enabled) {
        text = a.cleaned;
        if (!text) return;                        // 剥完什么都不剩 → 按空回复处理（不吭声）
      } else if (!pickup.annoyedUsable(a.cleaned)) {
        text = a.cleaned;                         // 旁边还有一大段正文 → 当成顺手写的记号，照正文发
      } else if (coin() < annoyed.chance) {
        log.chat({
          bot: this.botId, session: msg.sessionKey, direction: 'bot', text: annoyed.text,
          branch: `${trigger}:annoyed`, extra: `dropped=${a.cleaned.slice(0, 40)}`,
        });
        text = annoyed.text;
      } else {
        text = a.cleaned || annoyed.text;         // 概率没中：发原正文；正文是空的就还是把那一个字发出去
      }
    }

    // 频控
    const gate = rate.allow(this.botId, settings, {
      personId, text, kind, peerId: msg.peerId,
      repeatMatchMode: settings.repeatEcho?.matchMode,
    });
    if (!gate.ok) {
      log.chat({ bot: this.botId, session: msg.sessionKey, direction: 'bot', text, branch: `${trigger}:ratelimited:${gate.reason}` });
      return;
    }
    if (trigger === 'active') {
      const g = rate.allowActiveSpeak(this.botId, settings, groupId);
      if (!g.ok) return this.skip(msg, `主动频控:${g.reason}`);
    }

    await this.sendReply(kind, msg.peerId, text, {
      personId, trigger, sessionId: session.id, settings, question: msg.textClean,
    });
  }

  /**
   * 发回复。按句子在本地拆成几条分开发，读起来像人一句一句往外蹦。
   * 讲解类问题放宽每条消息的句子数（由 pickSentenceLimit 判断）。
   */
  async sendReply(kind, peerId, text, { personId, trigger, sessionId, settings, question = '' }) {
    const shape = speaking.replyShape(settings);
    const limit = speaking.pickSentenceLimit(question, settings);

    // 语音四档：先剥记号（ai 档靠它决定），再决定这一条到底发语音还是文字
    const vcfg = voiceOut.cfg(settings);
    const marked = voiceOut.stripMarker(text);
    const said = voiceOut.decide({ cfg: vcfg, text: marked.text, detailed: limit.detailed, forced: marked.forced });
    text = marked.text;

    const textSegments = shape.split
      ? speaking.splitReply(text, { maxSentences: limit.maxSentences, maxMessages: shape.maxMessages })
      : [text];

    // 决定发语音后，切法要换成「按语音条的长度切」——
    // 文字档一条 45 字，念出来 20 秒，所以语音档重新切（20~30 字一条，最多两条）
    let why = said.why;
    let voiceParts = null;
    if (said.voice) {
      const p = voiceOut.plan(text, vcfg, { forced: marked.forced });
      if (!p.ok) {
        why = `${said.why}/${p.why}`;
      } else {
        const afford = voiceOut.canAfford(this.botId, vcfg, p.parts.length);
        if (afford.ok) voiceParts = p.parts;
        else why = `${said.why}/${afford.why}`;
      }
    }

    // 要发语音就**先把所有分句都合成好再发**：中途失败或配额被占走就整条退回文字。
    // 不做「发一条再试下一条」—— 那会出现「前半语音、后半文字」的混合回复（用户反馈过）。
    let synth = null;
    if (voiceParts) {
      const done = [];
      for (const seg of voiceParts) {
        const v = await voiceOut.speak(seg, { cfg: vcfg, botId: this.botId, detailed: limit.detailed });
        if (!v.ok) {
          log.warn('worker', '语音没合成出来，整条改发文字', { stage: v.stage, err: v.error, parts: voiceParts.length });
          why = `${said.why}/合成失败:${v.stage}`;
          break;
        }
        done.push(v);
      }
      if (done.length === voiceParts.length) synth = done;
    }

    const useVoice = !!synth;
    const segments = useVoice ? voiceParts : textSegments;

    log.debug('worker', 'reply split', {
      detailed: limit.detailed, matched: limit.matched, voice: useVoice, voiceWhy: why,
      sentences: speaking.splitSentences(text).length, messages: segments.length,
    });

    let last = '';

    for (let i = 0; i < segments.length; i++) {
      if (i > 0) {
        // 多发出去的那几条同样要占全局防风控配额，占不到就停手，宁可不发也不刷屏
        const gMin = rate.hit(`g:${this.botId}:m`, 60_000, settings?.rate?.global?.perMinute ?? 10);
        const gHour = rate.hit(`g:${this.botId}:h`, 3600_000, settings?.rate?.global?.perHour ?? 300);
        if (!gMin.ok || !gHour.ok) {
          log.warn('worker', '分条发送占不到配额，剩余部分不发了', { sent: i, total: segments.length });
          break;
        }
        if (shape.segmentDelayMs) await new Promise((r) => setTimeout(r, shape.segmentDelayMs));
      }
      const partTrigger = i === 0 ? trigger : `${trigger}:part${i + 1}`;

      if (useVoice) {
        const v = synth[i];
        last = await this.send(kind, peerId, segments[i], {
          personId, trigger: `${partTrigger}:voice`, sessionId, voicePath: v.path,
        });
        log.debug('worker', 'voice sent', { voice: v.voice, quality: v.quality, pauseMs: v.pauseMs, sec: v.seconds, ms: v.ms, remaining: v.remaining });
        continue;
      }

      last = await this.send(kind, peerId, segments[i], { personId, trigger: partTrigger, sessionId });
    }
    return last;
  }

  /** 回复名单（独立于接受名单） */
  // 见 accessReply

  async sendFallback(msg, personId, settings, scene, reason) {
    if (!accessReply(this.botId, msg)) return this.skip(msg, '回复名单未放行');
    const cd = fallback.allowCooldown(this.botId, personId, settings);
    if (!cd.ok) return this.skip(msg, `兜底冷却(${cd.retryInSec}s)`);
    const text = fallback.pickReply(this.botId, scene);
    if (!text) return this.skip(msg, `兜底无可用回复:${scene}`);
    await this.send(msg.kind, msg.peerId, text, { personId, trigger: `fallback:${scene}`, sessionId: null });
    log.chat({ bot: this.botId, session: msg.sessionKey, direction: 'bot', text, branch: `fallback:${scene}`, extra: reason });
  }

  // ---------- tail 组装（缓存关键：动态内容只能出现在这里） ----------

  buildTail({ msg, personId, settings, trigger, echoCandidate, pickupHit = null, hasImages, forwardText = '', forwardImageTotal = 0, forwardImagesRead = 0, joke = null }) {
    const parts = [];

    const imp = impression.formatForPrompt(this.botId, personId);
    if (imp) parts.push(`〔关于正在说话的人〕\n${imp}`);

    // 场景要讲清楚：不说的话，模型会把群里那套称呼（「大家」）带进一对一私聊。
    if (msg.kind === 'group' && msg.senderName) {
      parts.push(`〔现在在群里〕说话的人是「${msg.senderName}」。`);
    } else if (msg.kind === 'private') {
      const who = msg.senderName ? `，对方叫「${msg.senderName}」` : '';
      parts.push(`〔现在是一对一的私聊，没有别人在场${who}。〕`);
    }

    // 联网搜索开着时，得明确说「该查就查」。只给工具是不够的：这个人的性格是
    // 「网友、不爱查资料」，被问价格时会直接回「我不查这个」把人打发走（实测过）。
    // 放在尾部而不是系统提示里：系统提示要保持冻结才能命中前缀缓存。
    if (settings?.api?.search?.enabled === true) {
      parts.push('〔能力〕你现在能联网搜索。被问到具体价格、新闻、赛事、某人的近况、确切数据这类会过期的信息时，先查再回答；不要用「我不查这个」「你自己去看」把人打发走。查不到就直说没查到，别编。');
    }

    // 语音档开着（且由模型自己决定）时，把「怎么要求语音」讲清楚。
    // 同样放尾部：系统提示冻结着才命中前缀缓存。
    // 语音只在说话短的时候合适，所以要说清「长了就老实发文字」，不然它会把
    // 一整段讲解塞进语音里 —— 本地合成一条 11 秒，发十条没人等。
    if (settings?.speak?.voice?.mode === 'ai') {
      const vc = voiceOut.cfg(settings);
      const maxChars = vc.maxChars;
      const maxTotal = maxChars * vc.maxMessages;
      parts.push(`〔语音〕你可以用语音说话。想用语音，就在回复里写一个 [语音]（写在哪儿都行，和其它话放一起也行；方括号圆括号都认），本地会把记号去掉、把它合成成语音发出去。`
        + `但整条要短，最多 ${maxTotal} 字左右（超了本地只能发文字）。要讲一大段、要列步骤、要给例子的时候，就不要写这个记号，老老实实发文字。`);
    }

    // 被找茬时回一个字（配置开的时候才说）：语义判断交给模型，本地只按概率放行。
    // 放尾部而不是系统提示里：系统提示要保持冻结才能命中前缀缓存。
    if (pickup.annoyedCfg(settings).enabled) {
      const a = pickup.annoyedCfg(settings);
      parts.push(
        `〔情形〕${a.when}。这种时候你可以什么都不说，也可以只回一个字「${a.text}」——`
        + `想这么回就在回复里写一个 [${a.text}]（写在哪儿都行，方括号圆括号都认），本地会把其它内容丢掉、只发这一个字。`
        + '拿不准算不算这种程度，就别用这个记号，正常回话就行。',
      );
    }

    // 接话（ai 模式）：告诉你为什么现在开口 —— 有人说了你被设定的触发词。
    // 说清「别解释自己在接话、别复述规则」，否则模型会写成「检测到关键词，我来接一句」。
    if (trigger === 'pickup' && pickupHit) {
      parts.push(
        `〔情形〕群里有人说了「${pickupHit.pattern}」，这是你被设定好的接话点，顺着接一句。` +
        '别解释自己在接话、别提「关键词/触发」这类词、也别复述这句话本身，就像普通聊天那样接。',
      );
    }

    if (trigger === 'echo' && echoCandidate) {
      parts.push(
        `〔情形〕群里已经有好几个人（${echoCandidate.people} 个）说了同一句话：「${echoCandidate.text}」。` +
        '你可以选择跟着说这一句，也可以不接。要跟就原样说出这句话。',
      );
    }

    if (trigger === 'active') {
      parts.push('〔情形〕没人点名找你。你可以选择接一句，也可以不接——不想说就只回复 <pass> 三个字符，不要输出别的。');
    }

    // 素材与文字分开两条发是常见操作，这里说明一下来源，免得模型以为在没话找话
    const before = [];
    if (msg.imagesFromPrevious) before.push('图片');
    if (msg.forwardsFromPrevious) before.push('聊天记录');
    if (msg.textFromPrevious) before.push('文字');
    if (before.length) {
      parts.push(`〔注意〕他刚刚先发了${before.join('和')}，现在这条只是补充说明，要结合起来看。`);
    }

    if (hasImages) parts.push('〔图片〕本条消息附带图片，内容已一并给你。');
    // 网上抓来的素材：说明来源与用法，否则模型会以为自己「本来就知道」这句话，
    // 或者原样照搬一句跟当下话题无关的语录。
    if (joke?.ok) {
      parts.push(`〔网上刚刷到的一句话，出处是「${joke.from || '网友'}」〕\n${joke.text}\n` +
        '（要不要用随你。想用就用你自己的话说出来，别原样念出处；跟当下话题不搭就别硬塞。）');
    }
    if (forwardText) {
      parts.push(`〔转发的聊天记录，共 ${forwardText.split('\n').length} 条〕\n${forwardText}`);
      // 说清楚图是从这段转发里来的、读到了几张。不说的话模型会以为
      // 附带的图片是对方单独发的，跟这段记录对不上。
      if (forwardImageTotal > 0) {
        const read = forwardImagesRead > 0
          ? `其中 ${forwardImagesRead} 张已连同图片给你`
          : '但一张都没能取到内容';
        parts.push(`〔说明〕上面这段转发里带了 ${forwardImageTotal} 张图，${read}。`);
      }
    }

    const body = msg.textClean || (hasImages || forwardText ? '(他没写文字，只说要看上面这些内容)' : '(没有内容)');
    parts.push(`〔他说〕${body}`);
    return parts.join('\n\n');
  }

  // ---------- 图片 ----------

  /**
   * 取图片内容给模型看。
   *
   * 两个来源：本条消息自己带的图（最多 3 张），以及合并转发里的图
   * （forwardedSources，条数由设置封顶——转发里常有二十几张，全读太贵）。
   *
   * 成本闸门统一在这里：总开关、按群关闭、每小时张数上限。
   * 计数按**张**算，不按消息算：一条转发里可能一次就带好几张，
   * 按消息计数会把成本低估一个数量级。
   */
  async prepareImages(msg, settings, forwardedSources = []) {
    const v = settings?.api?.vision ?? {};
    const ownCount = Math.min((msg.images ?? []).length, 3);
    if (!v.enabled) return { images: [], forwardRead: 0 };
    const sources = [
      ...(msg.images ?? []).slice(0, 3).map((i) => i.url || i.file),
      ...(forwardedSources ?? []),
    ];
    if (sources.length === 0) return { images: [], forwardRead: 0 };
    if (msg.kind === 'group' && (v.groupsOff ?? []).includes(String(msg.peerId))) {
      return { images: [], forwardRead: 0 };
    }

    const out = [];
    let forwardRead = 0;
    for (const [idx, src] of sources.entries()) {
      const limiter = rate.hit(`vis:${this.botId}`, 3600_000, v.perHourLimit ?? 60);
      if (!limiter.ok) {
        log.debug('worker', '图片识别达到每小时上限', { botId: this.botId, read: out.length, want: sources.length });
        break;
      }
      const data = await loadImageAsDataUrl(src);
      if (data) {
        out.push(data);
        if (idx >= ownCount) forwardRead++;
      }
    }
    return { images: out, forwardRead };
  }

  // ---------- 网上素材 ----------

  /**
   * 需要时从网上抓一条好笑的当素材。
   * 抓不到就返回 null——素材没有不影响回复，别让它变成一个错误。
   */
  async maybeFetchJoke(msg, settings, trigger) {
    const cfg = settings?.api?.webJokes ?? {};
    if (!cfg.enabled) return null;
    const asked = jokes.looksLikeAsking(msg.textClean);
    const random = Number(cfg.randomRate ?? 0);
    // Math.random 在这里只是「抽不抽空讲个段子」的概率闸门，不参与任何安全判断，
    // 不需要密码学随机数（粗筛里的 randomRate 同理）。
    const lucky = !asked && trigger === 'active' && random > 0 && Math.random() < random;
    if (!asked && !lucky) return null;

    const r = await jokes.fetchOne({ timeoutMs: Number(cfg.timeoutMs ?? 9000) });
    if (!r.ok) {
      log.debug('jokes', '没取到素材', { botId: this.botId, reason: r.reason });
      return null;
    }
    log.debug('jokes', '素材已取', { botId: this.botId, source: r.source, asked, lucky });
    return r;
  }

  // ---------- 发送 ----------

  async send(kind, peerId, text, { personId = null, trigger = '', sessionId = null, voicePath = '' } = {}) {
    try {
      // AI 互聊模式下给同一个群里的机器人发言排队：两次之间至少隔 minGapMs。
      // 计时按「群」记，几个机器人共用一个表，所以管的是它们之间的间隔。
      const talkCfg = talk.talkConfig();
      if (talkCfg.enabled && kind === 'group') {
        const waited = await talk.waitForGap(`g:${peerId}`, talkCfg.minGapMs);
        if (waited > 0) {
          log.debug('talk', '排队等待', { botId: this.botId, group: peerId, waitedMs: waited });
        }
      }

      // 语音条：NapCat 按 file:// 读本机文件，所以发之前不能删这个 wav
      const payload = voicePath
        ? [{ type: 'record', data: { file: voiceOut.fileUrl(voicePath) } }]
        : [{ type: 'text', data: { text } }];
      // 日志里带 [语音] 前缀，方便人回看时分清；**入库不带**。
      // 带过前缀，结果模型从自己的历史里学会了这个记号，往正文中间写了一个
      // [语音] 发到群里（2026-09-24 实测一次）。模型看的和日志要分开。
      const shown = voicePath ? `[语音] ${text}` : text;

      const res = await this.client.sendTo(kind, peerId, payload);
      const outMsgId = String(res?.message_id ?? '');
      if (sessionId) {
        history.saveBotMessage({ botId: this.botId, sessionId, msgId: outMsgId, text });
      }
      if (personId !== null && personId !== undefined) {
        // 判重、复读用「说出口的话」本身，不用带前缀的日志文本
        rate.rememberReply(this.botId, personId, text);
      }
      if (kind === 'group') {
        echo.noteMessage(this.botId, peerId, { senderQq: this.selfId, text, isBot: true });
      }
      log.chat({ bot: this.botId, session: `${kind}:${peerId}`, direction: 'out', who: 'bot', text: shown, branch: trigger });
      return outMsgId;
    } catch (e) {
      log.error('worker', '发送失败', { kind, peerId, err: String(e.message) });
      return '';
    }
  }
}

/** 回复名单检查（独立函数，避免和接受名单混在一起） */
export function accessReply(botId, msg) {
  const r = lists.canInteract(botId, {
    kind: msg.kind, senderQq: msg.senderQq, groupId: msg.kind === 'group' ? msg.peerId : null,
  });
  return r.reply;
}

const IMAGE_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
};

// 要认字的场景：低清档会把图缩到 512×512，长截图上的小字直接糊掉
const OCR_HINT = /字|文字|写的?了?什么|截图|识别|读一下|念一下|标题|内容|上面说|图里|图上的|翻译/;

/**
 * 选图片清晰度档位。
 * auto 时看这句话是不是在要求认字——认字就用高清，否则用省钱的低清。
 * 用户显式设了 low / high 就完全听用户的。
 */
export function pickImageDetail(text, setting = 'auto') {
  if (setting === 'high' || setting === 'low') return setting;
  return OCR_HINT.test(String(text ?? '')) ? 'high' : 'low';
}

/**
 * 把一张图片取成 data URL，供视觉模型使用。
 *
 * 三种来源都要认：
 *  - http(s) 链接：走 net.fetchRemote（拒绝内网地址，防伪造外链探测内网）
 *  - file:// 或本机绝对路径：NapCat 开了「本地文件直链」后常给这种。
 *    机器人通常与 NapCat 同机，直接读盘比绕一圈网络更快也更稳。
 */
export async function loadImageAsDataUrl(src, { maxBytes = 8 * 1024 * 1024 } = {}) {
  const s = String(src ?? '').trim();
  if (!s) return null;

  let localPath = '';
  if (s.startsWith('file://')) {
    try { localPath = fileURLToPath(s); } catch { localPath = ''; }
  } else if (path.isAbsolute(s)) {
    localPath = s;
  }

  if (localPath) {
    try {
      const st = fs.statSync(localPath);
      if (!st.isFile()) return null;
      if (st.size > maxBytes) {
        log.debug('worker', '图片过大，跳过', { size: st.size });
        return null;
      }
      const mime = IMAGE_MIME[path.extname(localPath).toLowerCase()] ?? 'image/jpeg';
      return `data:${mime};base64,${fs.readFileSync(localPath).toString('base64')}`;
    } catch (e) {
      log.debug('worker', '读取本地图片失败', { err: String(e.message) });
      return null;
    }
  }

  if (!/^https?:\/\//i.test(s)) return null;
  const r = await net.fetchRemote(s, { maxBytes, timeoutMs: 15000 });
  if (!r.ok) {
    log.debug('worker', '图片下载失败', { reason: r.reason });
    return null;
  }
  const mime = (r.contentType?.split(';')[0] || 'image/jpeg').trim();
  return `data:${mime};base64,${r.buffer.toString('base64')}`;
}

/** 清洗模型输出：去掉包裹标记、静默标记、多余的空白 */
export function normalizeReply(raw) {
  let t = String(raw ?? '').trim();
  if (!t) return '';
  if (/^<pass>$/i.test(t) || /^<pass>\s/i.test(t)) return '';
  // 去掉整体包裹的引号或代码块
  t = t.replace(/^```[a-z]*\n?|```$/gi, '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('「') && t.endsWith('」'))) {
    t = t.slice(1, -1).trim();
  }
  // 去掉可能的旁白括号（只在整句都是旁白时）
  if (/^[（(][^）)]*[）)]$/.test(t)) return '';
  return t.slice(0, 500);
}
