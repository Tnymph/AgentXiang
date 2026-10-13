// 命令系统：可扩展的注册表 + 当前四个命令
//
// 扩展方式：调 defineCommand() 加一条，help 文本与参数解析自动跟上，
// 不需要改管线、也不需要改别的命令。
import * as db from '../db.js';
import * as log from '../logger.js';
import * as admins from './admins.js';
import * as llm from '../llm.js';
import * as message from '../message.js';
import * as voice from './voice.js';
import * as learning from './learning.js';
import * as voiceOut from './voice-out.js';
import { saveBotSettings, loadGlobal, saveGlobal } from '../config.js';

const registry = new Map();      // 小写名 -> 定义（含别名）

const DEFAULT_HELP_BODY = '我能听懂这几个口令（要引用我说的某句话再发，不然我不知道你指的是哪条）：';
const DEFAULT_HELP_FORMAT = '群里有两个机器人时，在口令前面 @ 你想指挥的那个（@我 /help），只有它响应；不 @ 则都会响应。';
const DEFAULT_HELP_FOOTER = '口令只对管理员开放。';
const RECALL_WINDOW_MS = 120_000;   // 腾讯侧消息撤回时限：2 分钟

/** /learn 标记成功后的默认回话，可在界面上改 */
const DEFAULT_LEARN_REPLY = {
  goodex: '好，我记住这种说法了。',
  badex: '我知道了，会改变语言风格的。',
};

/** 注册一个命令 */
export function defineCommand(def) {
  const norm = { ...def, name: String(def.name) };
  registry.set(norm.name.toLowerCase(), norm);
  for (const a of def.aliases ?? []) registry.set(String(a).toLowerCase(), norm);
  return norm;
}

/** 按名字查找（不区分大小写） */
export function findCommand(name) {
  return registry.get(String(name ?? '').toLowerCase()) ?? null;
}

/** 去重后的命令清单（注册表里含别名，这里只留唯一定义） */
export function uniqueCommands() {
  const seen = new Set();
  const out = [];
  for (const def of registry.values()) {
    if (seen.has(def.name)) continue;
    seen.add(def.name);
    out.push(def);
  }
  return out;
}

/** 渲染 /help 文本：可编辑正文 + 自动生成的命令列表 + 可编辑页脚 */
export function renderHelp(settings) {
  const h = settings?.help ?? {};
  const lines = [h.body?.trim() || DEFAULT_HELP_BODY, ''];
  for (const def of uniqueCommands()) {
    for (const u of def.usages ?? []) {
      const desc = h.descriptions?.[u.key] ?? u.desc;
      lines.push(`${u.text} —— ${desc}`);
    }
  }
  lines.push('', h.format?.trim() || DEFAULT_HELP_FORMAT);
  lines.push(h.footer?.trim() || DEFAULT_HELP_FOOTER);
  return lines.join('\n');
}

// ---------- 命令历史（/undo 依赖它定位） ----------

export function logCommand({ botId, sessionId, actorQq, command, args, cmdMsgId, outMsgId, effect }) {
  const r = db.run(`insert into command_log
    (bot_id, session_id, actor_qq, command, args, cmd_msg_id, out_msg_id, effect, undone, created_at)
    values (?,?,?,?,?,?,?,?,0,?)`,
    botId, sessionId, String(actorQq), command, args ?? '', cmdMsgId ?? null, outMsgId ?? null,
    JSON.stringify(effect ?? { kind: 'none' }), Date.now());
  return Number(r.lastInsertRowid);
}

/** 用「被引用的消息 ID」反查命令：命令消息本身或它产出的消息都认 */
export function findByRef(botId, sessionId, refMsgId) {
  const id = String(refMsgId ?? '');
  if (!id) return null;
  return db.one(`select * from command_log
                 where bot_id = ? and session_id = ? and undone = 0
                   and (cmd_msg_id = ? or out_msg_id = ?)
                 order by created_at desc limit 1`, botId, sessionId, id, id);
}

export function markUndone(logId) {
  db.run('update command_log set undone = 1 where id = ?', logId);
}

export function recentCommands(botId, sessionId, limit = 10) {
  return db.all('select * from command_log where bot_id = ? and session_id = ? order by created_at desc limit ?',
    botId, sessionId, limit);
}

// ---------- 命令实现 ----------

/**
 * 引用消息里的图片 → 交给视觉模型读一遍，转成文字。
 * 聊天截图和段子截图里的对话是很好的素材，所以不能一句「图片看不出说话方式」就拒掉；
 * 表情包也让它描述成"什么场合回什么图"。用高清档：低清会把图缩到 512，小字会糊。
 */
async function describeImages(ctx, norm) {
  const prepared = ctx.prepareImages ? await ctx.prepareImages(norm, ctx.settings) : null;
  const imgs = prepared?.images ?? [];
  if (!imgs.length) return '';
  const key = (await import('../secrets.js')).getApiKey(ctx.botId);
  if (!key) return '';
  const r = await (ctx.chatFn ?? llm.chat)({
    botId: ctx.botId, apiKey: key,
    baseUrl: ctx.settings?.api?.baseUrl, model: ctx.settings?.api?.model,
    scene: 'chat',
    system: '你在帮主人整理聊天素材。把图片内容如实转成文字：有文字就逐字抄下来（有对话就按说话人顺序排好），'
      + '是表情包或梗图就简短描述画的是什么、一般用来表达什么情绪。不要评论，不要扩写，不要加自己的话。',
    history: [],
    tail: llm.withImages('把这张图的内容转成文字。', imgs, 'high'),
    effort: 'low', maxTokens: 900, temperature: 0.2,
  });
  if (!r.ok) {
    log.warn('commands', '图片识图失败', { botId: ctx.botId, err: r.error });
    return '';
  }
  return String(r.text ?? '').trim().slice(0, 4000);
}

/**
 * /learn quote
 * 引用某条消息（可以是别人发的）→ 把里面的内容收进语料，学习时作为参考。
 * 文字直接取；语音先转写；图片交给视觉模型读；合并转发里的文字也取。
 */
export async function captureQuote(ctx) {
  if (!ctx.quoteId) return { effect: { kind: 'none' }, error: '要引用一条消息再用 /learn quote' };
  const client = ctx.client;
  if (!client?.getMsg) return { effect: { kind: 'none' }, error: '当前连接取不到被引用的消息' };

  let raw;
  try { raw = await client.getMsg(ctx.quoteId); } catch (e) {
    return { effect: { kind: 'none' }, error: '取不到被引用的那条：' + String(e.message).slice(0, 60) };
  }
  if (!raw) return { effect: { kind: 'none' }, error: '取不到被引用的那条（可能已经过期了）' };

  // get_msg 返回的是「消息对象」，不是事件：normalizeEvent 要求 post_type/message_type
  // 这些字段，缺了它会直接返回 null。这里补出来；万一还是认不出，回退成空壳，
  // 绝不让命令在解引用上崩掉。
  const isGroup = raw.message_type ? raw.message_type === 'group' : Number(raw.group_id ?? 0) > 0;
  const norm = message.normalizeEvent({
    post_type: 'message',
    message_type: isGroup ? 'group' : 'private',
    group_id: raw.group_id ?? (isGroup ? ctx.peerId ?? 0 : 0),
    user_id: raw.sender?.user_id ?? raw.user_id ?? (isGroup ? 0 : ctx.peerId ?? 0),
    message_id: raw.message_id ?? '',
    time: raw.time ?? Math.floor(Date.now() / 1000),
    message: raw.message ?? [],
    sender: raw.sender ?? {},
  }, { selfId: String(ctx.selfId ?? ''), nicknames: [], isBot: () => false })
    ?? { text: '', textClean: '', images: [], voices: [], faces: [], markers: [] };

  const parts = [];
  const text = String(norm.textClean ?? norm.text ?? '').trim();
  if (text) parts.push(text);

  if (norm.voices?.length) {
    const asr = await voice.transcribeVoices(client, norm, ctx.settings).catch(() => null);
    if (asr?.text) parts.push(asr.text);
    else if (!parts.length) {
      return { effect: { kind: 'none' }, error: '这条是语音，但转写不出来（识别服务没在线？）' };
    }
  }

  // 图片：识图（截图里的对话、段子截图都能变成素材）。视觉开关关着就不硬试。
  if (norm.images?.length) {
    const visionOn = ctx.settings?.api?.vision?.enabled !== false;
    if (!visionOn) {
      if (!parts.length) {
        return { effect: { kind: 'none' }, error: '这条是图片，但「识别图片」关着 —— 去「接入与密钥 → 识别开关」打开，或者直接把文字打给我' };
      }
    } else {
      const desc = await describeImages(ctx, norm).catch(() => '');
      if (desc) parts.push(`（引用的是图片，图里是）${desc}`);
      else if (!parts.length) {
        return { effect: { kind: 'none' }, error: '图没读出来（识别失败了，或者没配密钥）' };
      }
    }
  }

  const body = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (!body) {
    const onlyFace = (norm.faces ?? []).length > 0 || (norm.markers ?? []).some((m) => m === '[表情]');
    return {
      effect: { kind: 'none' },
      error: onlyFace ? '这条只有表情，看不出说话方式 —— 换成文字、语音或截图' : '这条里没有可用的内容',
    };
  }

  const who = String(raw.sender?.card || raw.sender?.nickname || norm.senderName || '').trim();
  const id = learning.addNote(ctx.botId, { text: body, source: 'quoted', who });
  const replyText = ctx.settings?.speak?.learnReplies?.quote
    || `收下了${who ? `（${who}）` : ''}这条，学习的时候会当参考`;
  let outMsgId = '';
  try { outMsgId = await ctx.send(replyText); } catch { /* 发不出去不影响收录 */ }
  log.info('commands', 'quote captured', { botId: ctx.botId, noteId: id, who, chars: body.length });
  return { effect: { kind: 'none', noteId: id, outMsgIds: outMsgId ? [outMsgId] : [] } };
}

/**
 * /learn goodex | badex | quote
 * 引用机器人的某条消息 → 标记该条；不引用 → 标记机器人上一条。
 * /learn quote 则是引用任意一条（通常是别人说的）收进语料。
 */
defineCommand({
  name: 'learn',
  adminOnly: true,
  usages: [
    { text: '/learn goodex', key: 'learn.goodex', desc: '记住这条，这样说对' },
    { text: '/learn badex', key: 'learn.badex', desc: '这条不行，以后别这样' },
    { text: '/learn quote', key: 'learn.quote', desc: '引用一条消息（文字/语音/图片/转发）收进语料' },
  ],
  async handler(ctx, args) {
    const kind = String(args[0] ?? '').toLowerCase();
    if (kind === 'quote' || kind === '引用') return captureQuote(ctx);
    if (kind !== 'goodex' && kind !== 'badex') {
      return { effect: { kind: 'none' }, error: '用法：/learn goodex、/learn badex，或引用一条消息后 /learn quote' };
    }
    const markKind = kind === 'goodex' ? 'good' : 'bad';

    const target = ctx.quoteId
      ? db.one('select * from messages where bot_id = ? and msg_id = ?', ctx.botId, String(ctx.quoteId))
      : db.one("select * from messages where bot_id = ? and session_id = ? and role = 'bot' order by ts desc limit 1",
        ctx.botId, ctx.sessionId);

    if (!target) {
      return { effect: { kind: 'none' }, error: ctx.quoteId ? '引用的那条我这儿没记录' : '还没找到我上一条发言' };
    }
    if (target.role !== 'bot') {
      return { effect: { kind: 'none' }, error: '只能标记我自己说的话' };
    }

    db.run('insert or replace into marks (bot_id, message_id, kind, note, created_at) values (?,?,?,?,?)',
      ctx.botId, target.id, markKind, '', Date.now());
    const mark = db.one('select * from marks where bot_id = ? and message_id = ? and kind = ?',
      ctx.botId, target.id, markKind);

    // 回一句话让用户知道标记生效了。文案可在界面上改。
    const replyText = ctx.settings?.speak?.learnReplies?.[kind] || DEFAULT_LEARN_REPLY[kind];
    let outMsgId = '';
    try { outMsgId = await ctx.send(replyText); } catch { /* 发不出去也不影响标记 */ }

    log.info('commands', 'mark added', { botId: ctx.botId, messageId: target.id, kind: markKind, notified: !!outMsgId });
    return {
      effect: {
        kind: 'mark', markId: mark.id, messageId: target.id, markKind,
        outMsgIds: outMsgId ? [outMsgId] : [],
      },
      silent: !outMsgId,
    };
  },
});

/**
 * /undo —— 必须引用定位。
 * 产物是程序更改 → 回退（不限时）；产物是消息 → 撤回（受 2 分钟限制）。
 */
defineCommand({
  name: 'undo',
  adminOnly: true,
  usages: [
    { text: '/undo', key: 'undo', desc: '撤销上一条口令（要引用它）' },
  ],
  async handler(ctx) {
    if (!ctx.quoteId) return { effect: { kind: 'none' }, error: '要引用一条命令消息或它发出的消息' };

    const entry = findByRef(ctx.botId, ctx.sessionId, ctx.quoteId);
    if (!entry) return { effect: { kind: 'none' }, error: '没找到可撤销的命令' };

    let effect = {};
    try { effect = JSON.parse(entry.effect || '{}'); } catch { effect = {}; }

    if (effect.kind === 'mark') {
      db.run('delete from marks where id = ?', effect.markId);
      // 顺带把它发出去的那句回话也撤回；超过撤回时限就只回退标记
      for (const id of effect.outMsgIds ?? []) {
        if (Date.now() - Number(entry.created_at) > RECALL_WINDOW_MS) continue;
        try { await ctx.client.deleteMsg(id); } catch { /* 撤回失败不影响回退标记 */ }
      }
      markUndone(entry.id);
      log.info('commands', 'undo mark', { botId: ctx.botId, markId: effect.markId, recalled: (effect.outMsgIds ?? []).length });
      return { effect: { kind: 'none' }, silent: true };
    }

    if (effect.kind === 'message') {
      const age = Date.now() - Number(entry.created_at);
      if (age > RECALL_WINDOW_MS) {
        return {
          effect: { kind: 'none' },
          error: `那条消息已经超过可撤回时限（${Math.round(age / 1000)} 秒前发的，上限 120 秒）`,
        };
      }
      try {
        await ctx.client.deleteMsg(effect.outMsgId);
        markUndone(entry.id);
        log.info('commands', 'undo message', { botId: ctx.botId, outMsgId: effect.outMsgId });
        return { effect: { kind: 'none' }, silent: true };
      } catch (e) {
        return { effect: { kind: 'none' }, error: '撤回失败：' + String(e.message) };
      }
    }

    return { effect: { kind: 'none' }, error: '这条命令没有可撤销的产物' };
  },
});

/** /help —— 直接把设定的帮助文本发在当前会话 */
defineCommand({
  name: 'help',
  adminOnly: true,
  usages: [
    { text: '/help', key: 'help', desc: '把这个再发一遍' },
  ],
  async handler(ctx) {
    const text = renderHelp(ctx.settings);
    const outMsgId = await ctx.send(text);
    return { effect: { kind: 'message', outMsgId }, silent: true };
  },
});

/** /spend —— 看今天用掉多少 token、花了多少钱 */
defineCommand({
  name: 'spend',
  adminOnly: true,
  usages: [
    { text: '/spend', key: 'spend', desc: '看今天用了多少 token、花了多少钱' },
  ],
  async handler(ctx) {
    const u = llm.usageSummary(ctx.botId);
    const n = (x) => Number(x ?? 0).toLocaleString('en-US');
    const yuan = (x) => '¥' + Number(x ?? 0).toFixed(4);

    if (!u.calls) {
      const t = '今天还没有调用过模型，花费 ¥0';
      const outMsgId = await ctx.send(t);
      return { effect: { kind: 'message', outMsgId }, silent: !outMsgId };
    }

    const text = [
      `今天 ${u.calls} 次调用，花费 ${yuan(u.cost.spent)}`,
      `输入 ${n(u.prompt)} token（命中缓存 ${n(u.cacheHit)}，省下 ${yuan(u.cost.saved)}）`,
      `输出 ${n(u.completion)} token，其中思考 ${n(u.reasoning)}`,
      `缓存命中率 ${(u.hitRate * 100).toFixed(1)}%`,
      u.reasoning > u.completion * 0.6 ? '（思考占了大头，可以试试把思考档位调低）' : '',
    ].filter(Boolean).join('\n');

    const outMsgId = await ctx.send(text);
    log.info('commands', 'spend queried', { botId: ctx.botId, calls: u.calls, spent: u.cost.spent });
    return { effect: { kind: 'message', outMsgId }, silent: !outMsgId };
  },
});

/**
 * 从命令行里挑出「要统计哪几个机器人」。
 *
 * 两种写法都认（见 src/cmdline.js 的格式规定）：
 *   @a @b /spendtrend        —— @ 写在命令前，是「指名」，QQ 号直接可用
 *   /spendtrend @a @b        —— @ 写在命令后，是普通参数，按 QQ 或机器人名字匹配
 * 一个都没给 = 统计全部机器人。
 */
function pickBotsForReport(ctx) {
  const bots = db.listBots();
  const byQq = new Map(bots.map((b) => [String(b.qq ?? ''), b]));
  const byName = new Map(bots.map((b) => [String(b.name ?? ''), b]));
  const chosen = new Map();          // 用 Map 去重，@ 同一个号两次不会重复统计

  for (const qq of ctx.msg?.command?.targets ?? []) {
    const b = byQq.get(String(qq));
    if (b) chosen.set(b.id, b);
  }
  for (const a of ctx.msg?.command?.args ?? []) {
    const t = String(a).replace(/^@/, '').trim();
    if (!t) continue;
    const b = byQq.get(t) ?? byName.get(t);
    if (b) chosen.set(b.id, b);
  }
  return chosen.size ? [...chosen.values()] : bots;
}

/** /spendtrend —— 今天的花费和历史日均比一比 */
defineCommand({
  name: 'spendtrend',
  aliases: ['trend'],
  adminOnly: true,
  usages: [
    { text: '/spendtrend', key: 'spendtrend', desc: '今天的花费和历史日均对比（默认统计所有机器人）' },
    { text: '@机器人 /spendtrend', key: 'spendtrend', desc: '只统计被 @ 到的机器人，可以 @ 好几个' },
  ],
  async handler(ctx) {
    const bots = pickBotsForReport(ctx);
    const t = llm.spendTrend(bots.map((b) => b.id));
    const yuan = (x) => '¥' + Number(x ?? 0).toFixed(4);
    const who = bots.length === 1
      ? bots[0].name
      : `${bots.length} 个机器人合计（${bots.map((b) => b.name).join('、')}）`;

    const lines = [`花费趋势 · ${who}`];

    if (!t.samples && t.today === 0) {
      lines.push('今天还没有调用过模型，也没有历史数据可比。');
      const outMsgId = await ctx.send(lines.join('\n'));
      return { effect: { kind: 'message', outMsgId }, silent: !outMsgId };
    }

    lines.push(`今天      ${yuan(t.today)}（${t.todayCalls ? t.todayCalls + ' 次调用' : '今天还没调用过'}）`);
    if (t.samples) {
      lines.push(`历史日均  ${yuan(t.avg)}（按最近 ${t.samples} 个有数据的天算）`);
      // 今天一次都没调用时不给百分比——「比日均低 100%」只是「今天还没开始用」，
      // 拿它当"花费下降"看会误判
      if (t.avg > 0 && t.today > 0) {
        const diff = (t.today - t.avg) / t.avg;
        const dir = diff >= 0 ? '高' : '低';
        lines.push(`对比      今天比日均${dir} ${Math.abs(diff * 100).toFixed(0)}%`);
      }
    } else {
      lines.push('历史日均  还没有更早的数据，明天就能比了');
    }

    if (t.perBot.length > 1) {
      lines.push('分号     ' + t.perBot.map((b) => `${b.name} ${yuan(b.todaySpent)}`).join(' / '));
    }

    const outMsgId = await ctx.send(lines.join('\n'));
    log.info('commands', 'spendtrend queried', {
      botId: ctx.botId, bots: bots.map((b) => b.id), today: t.today, avg: t.avg, samples: t.samples,
    });
    return { effect: { kind: 'message', outMsgId }, silent: !outMsgId };
  },
});

/** /talk on|off —— 让同一个群里的几个机器人互相聊天（全局开关，一次管所有号） */
defineCommand({
  name: 'talk',
  adminOnly: true,
  usages: [
    { text: '/talk on|off', key: 'talk', desc: '让同一个群里的几个机器人互相接话（一次开/关全部；不带参数看当前状态）' },
  ],
  async handler(ctx, args) {
    const want = String(args[0] ?? '').toLowerCase();
    const cur = loadGlobal()?.talk ?? {};

    if (!want) {
      const outMsgId = await ctx.send(
        `AI 互聊现在是「${cur.enabled ? '开' : '关'}」。\n` +
        `发言间隔至少 ${cur.minGapMs ?? 1500} 毫秒；连续 ${cur.maxChain ?? 6} 条都是机器人在说就自动停，等真人开口。\n` +
        '这个开关是全局的，对所有机器人一起生效。',
      );
      return { effect: { kind: 'message', outMsgId }, silent: !outMsgId };
    }

    if (!['on', 'off'].includes(want)) {
      const outMsgId = await ctx.send('用法：/talk on 打开，/talk off 关上，/talk 看当前状态');
      return { effect: { kind: 'message', outMsgId }, silent: !outMsgId };
    }

    const enabled = want === 'on';
    saveGlobal({ talk: { enabled } });
    log.warn('commands', 'talk toggled', { botId: ctx.botId, by: ctx.senderQq, enabled });
    const outMsgId = await ctx.send(enabled
      ? '好，AI 互聊开了：同一个群里的几个机器人现在会互相接话。\n' +
        `两次发言之间至少隔 ${loadGlobal()?.talk?.minGapMs ?? 1500} 毫秒；` +
        `连续 ${loadGlobal()?.talk?.maxChain ?? 6} 条都是机器人在说就会自动停下，等你们谁开口再恢复。`
      : '好，AI 互聊关了，它们又互相当对方不存在了。');
    return { effect: { kind: 'message', outMsgId }, silent: !outMsgId };
  },
});

/** /voice on|off|auto|prob|text —— 语音回复档位（每个机器人一套，和界面上是同一个设置） */
const VOICE_MODE_LABEL = {
  text: '只发文字',
  voice: '全用语音',
  prob: '按概率用语音',
  ai: '由模型自己决定',
};

defineCommand({
  name: 'voice',
  adminOnly: true,
  // 确认书里写的是 /VoiceOn、/VoiceOff 两个别名，这里合成一个命令：带参数用参数，不带参数看别名
  aliases: ['voiceon', 'voiceoff'],
  usages: [
    { text: '/voice on|off|auto|prob', key: 'voice', desc: '语音回复：on 全语音 / off 只发文字 / auto 由模型决定 / prob 按概率（不带参数看状态）' },
  ],
  async handler(ctx, args) {
    const typed = String(ctx.msg?.command?.name ?? '').toLowerCase();
    let want = String(args[0] ?? '').toLowerCase();
    // 别名就是「不带参数的 on / off」
    if (!want && typed === 'voiceon') want = 'on';
    if (!want && typed === 'voiceoff') want = 'off';

    const cur = voiceOut.cfg(ctx.settings);
    if (!want) {
      const q = voiceOut.peek(ctx.botId, cur);
      const outMsgId = await ctx.send(
        `语音现在是「${VOICE_MODE_LABEL[cur.mode] ?? cur.mode}」，音色 ${cur.voiceId || '（清单里第一个）'}，单条最多 ${cur.maxChars} 字、一次最多 ${cur.maxMessages} 条。\n` +
        `本小时已用 ${q.used}/${q.limit} 条。要改：/voice on、/voice off、/voice auto、/voice prob。` +
        '（讲题和太长的回复一律走文字；音色和试听在网页的「音色」页。）',
      );
      return { effect: { kind: 'message', outMsgId }, silent: !outMsgId };
    }

    const mode = { on: 'voice', off: 'text', auto: 'ai', ai: 'ai', prob: 'prob' }[want];
    if (!mode) {
      const outMsgId = await ctx.send('用法：/voice on（全语音）、/voice off（只发文字）、/voice auto（模型自己决定）、/voice prob（按概率）');
      return { effect: { kind: 'message', outMsgId }, silent: !outMsgId };
    }

    saveBotSettings(ctx.botId, { speak: { voice: { mode } } });
    log.info('commands', 'voice mode changed', { botId: ctx.botId, by: ctx.senderQq, mode });
    const extra = mode === 'voice' ? '（提醒：一条语音要十几秒才合成得出来，我会说得短一点。）' : '';
    const outMsgId = await ctx.send(`好，语音回复已改成「${VOICE_MODE_LABEL[mode]}」${extra}`);
    return { effect: { kind: 'message', outMsgId }, silent: !outMsgId };
  },
});

/** /api on|off|auto —— 切换 API 接入模式，与界面上的三态开关是同一个设置 */
const API_MODES = {
  on: 'force_on',
  off: 'force_off',
  auto: 'auto',
};
const API_MODE_LABEL = {
  force_on: '强制接入',
  force_off: '强制关闭',
  auto: '按时段自动',
};

defineCommand({
  name: 'api',
  adminOnly: true,
  usages: [
    { text: '/api on|off|auto', key: 'api', desc: '切换接入模式（不带参数则显示当前状态）' },
  ],
  async handler(ctx, args) {
    const want = String(args[0] ?? '').toLowerCase();

    if (!want) {
      const cur = ctx.settings?.api?.mode ?? 'auto';
      const outMsgId = await ctx.send(`当前接入模式：${API_MODE_LABEL[cur] ?? cur}`);
      return { effect: { kind: 'message', outMsgId }, silent: !outMsgId };
    }

    const mode = API_MODES[want];
    if (!mode) {
      const outMsgId = await ctx.send('用法：/api on、/api off 或 /api auto');
      return { effect: { kind: 'message', outMsgId }, silent: !outMsgId };
    }

    try {
      saveBotSettings(ctx.botId, { api: { mode } });
      const outMsgId = await ctx.send(`好，接入模式已改成「${API_MODE_LABEL[mode]}」`);
      log.info('commands', 'api mode changed', { botId: ctx.botId, mode });
      return { effect: { kind: 'message', outMsgId }, silent: !outMsgId };
    } catch (e) {
      log.error('commands', 'api mode change failed', { botId: ctx.botId, err: String(e.message) });
      const outMsgId = await ctx.send('改不了，设置写入失败了：' + String(e.message));
      return { effect: { kind: 'message', outMsgId }, silent: !outMsgId };
    }
  },
});

/** 仅供测试与界面展示：命令清单 */
export function commandSummaries() {
  return uniqueCommands().map((d) => ({ name: d.name, aliases: d.aliases ?? [], usages: d.usages ?? [], adminOnly: !!d.adminOnly }));
}

export function isAdminOnly(name) {
  return !!findCommand(name)?.adminOnly;
}

export { admins };
