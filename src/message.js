// 消息规范化：把 OneBot 的事件转成内部统一结构
// 每个 segment 类型一个处理函数，加新类型只需在这里加一条，不动别处。
import * as log from './logger.js';
import { parseCommandLine } from './cmdline.js';

/** 各类 segment 的识别与提取 */

// 解析不出名字时的中性占位。
// 绝不能退回 QQ 号：那会把一串数字当正文喂给模型，模型会照抄着说「@123456789」。
const AT_UNKNOWN = '某人';

const handlers = {
  text: (seg, out) => { out.textParts.push(seg.data?.text ?? ''); },

  at: (seg, out) => {
    const qq = String(seg.data?.qq ?? '');
    out.atList.push(qq);
    if (qq === 'all') { out.atAll = true; return; }
    // NapCat 收消息时只给 qq、不给 name（它源码里把 name 那行注释掉了，见 src/names.js）。
    // 早先用 `name || qq` 兜底，于是文本里留下的是 QQ 号码。
    const name = String(seg.data?.name ?? '').trim() || out.resolveName?.(qq) || AT_UNKNOWN;
    const token = `@${name}`;
    // 记下「这个 qq 渲染成了什么」，剥自己的 @ 时才能精确匹配——
    // 群里显示的是群名片，和登录昵称常常不是一个词。
    out.atTokens.push({ qq, token });
    out.textParts.push(token + ' ');
  },

  image: (seg, out) => {
    out.images.push({ url: seg.data?.url ?? '', file: seg.data?.file ?? '', subType: seg.data?.sub_type ?? '' });
    // 放个占位：没有它，纯图消息在库里就是一条空记录，
    // 聊天记录里看不到任何东西，模型看历史也只见一行空白。
    out.markers.push('[图片]');
  },

  record: (seg, out) => {
    out.voices.push({ file: seg.data?.file ?? '', url: seg.data?.url ?? '' });
    out.markers.push('[语音]');
  },

  face: (seg, out) => { out.faces.push(String(seg.data?.id ?? '')); out.markers.push('[表情]'); },

  reply: (seg, out) => { out.replyId = String(seg.data?.id ?? ''); },

  forward: (seg, out) => {
    out.forwardIds.push(String(seg.data?.id ?? ''));
    out.markers.push('[聊天记录]');
  },

  video: (seg, out) => { out.unsupported.add('video'); out.markers.push('[视频]'); },

  file: (seg, out) => {
    out.unsupported.add('file');
    out.markers.push(`[文件:${seg.data?.name || '未知'}]`);
  },

  json: (seg, out) => { out.unsupported.add('card'); out.markers.push('[卡片消息]'); },

  xml: (seg, out) => { out.unsupported.add('card'); out.markers.push('[卡片消息]'); },

  location: (seg, out) => { out.unsupported.add('location'); out.markers.push('[位置]'); },

  poke: (seg, out) => { out.unsupported.add('poke'); },

  markdown: (seg, out) => { out.textParts.push(String(seg.data?.content ?? '')); },

  mface: (seg, out) => { out.unsupported.add('mface'); out.markers.push('[表情]'); },
};

function emptyAccumulator() {
  return {
    textParts: [],
    markers: [],
    atList: [],
    atTokens: [],
    atAll: false,
    images: [],
    voices: [],
    faces: [],
    forwardIds: [],
    replyId: null,
    unsupported: new Set(),
    resolveName: null,
  };
}

/** 把 segment 数组拆解成累加器 */
export function accumulate(segments, { resolveName = null } = {}) {
  const out = emptyAccumulator();
  out.resolveName = typeof resolveName === 'function' ? resolveName : null;
  for (const seg of segments ?? []) {
    const fn = handlers[seg?.type];
    if (fn) {
      try { fn(seg, out); } catch (e) { log.debug('message', 'segment 解析失败', { type: seg?.type, err: String(e.message) }); }
    } else {
      out.unsupported.add(String(seg?.type ?? 'unknown'));
    }
  }
  return out;
}

/** 把 CQ 码字符串（部分实现会发原始字符串）也当纯文本处理 */
export function normalizeSegments(message) {
  if (Array.isArray(message)) return message;
  if (typeof message === 'string') return [{ type: 'text', data: { text: message } }];
  return [];
}

/** 判断消息里是否提及了机器人（@ 或叫名字） */
export function isMentioned(acc, { selfId, nicknames = [] }) {
  if (selfId && acc.atList.includes(String(selfId))) return true;
  if (acc.atAll) return true;
  const text = acc.textParts.join('');
  return nicknames.some((n) => n && text.includes(n));
}

/**
 * 剥掉文本里「对机器人的 @ 提及」。
 * 只剥 @ 形式（渲染出的 @片段 / @昵称 / @QQ号），正文里自然出现的名字一字不动 ——
 * 有人说「张小向老师你好」，模型看到名字是正常的，删掉反而不忠实。
 *
 * selfTokens 是这次实际渲染出来的 @片段（来自 atTokens）。群里显示的是群名片，
 * 和登录昵称不是一回事，只靠 nicknames 会剥不干净，于是那半个 @群名片 就留在正文里。
 *
 * 注意这里**只管自己**：别人的 @ 要原样留着，那是「这句话在跟谁说话」的信息，
 * 既给模型看，也是聊天记录里唯一能看出被 @ 的是谁的线索。
 * （早先这里有一句「清掉所有残留 @」，把别人的 @ 也一起吃了，已去掉。）
 */
export function stripSelfMentions(text, { selfId, nicknames = [], selfTokens = [] } = {}) {
  let out = String(text ?? '');
  for (const t of selfTokens) {
    if (t) out = out.split(t).join(' ');
  }
  // 长名字优先，否则「张小向」会被「小向」先匹配掉、留下半个「张」
  const names = [...nicknames].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const n of names) out = out.split(`@${n}`).join(' ');
  if (selfId) out = out.split(`@${selfId}`).join(' ');
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * 整条文本就是若干个 [xxx] 占位、没有人话。
 * 纯图片/纯语音/纯转发消息存到库里就是这种样子。
 *
 * 用途：这些东西**不能当作「他说的话」**去喂印象提炼——「[图片]」不是任何人说的话。
 * 但留在聊天记录和模型的历史里是对的，那边需要知道「他发过一张图」。
 */
const MARKER_ONLY_RE = /^(?:\[[^\]]{1,20}\])+$/;

export function isMarkerOnly(text) {
  return MARKER_ONLY_RE.test(String(text ?? '').trim());
}

/** 识别以 / 开头的命令 */
export function parseCommand(text, prefixes = ['/', '／']) {
  const t = String(text ?? '').trim();
  const p = prefixes.find((x) => t.startsWith(x));
  if (!p) return null;
  const rest = t.slice(p.length).trim();
  if (!rest) return null;
  const [head, ...tail] = rest.split(/\s+/);
  return { raw: t, name: head, args: tail, argText: tail.join(' ') };
}

/**
 * 主入口：把一条 message 事件转成内部结构。
 * 返回 null 表示这条事件不该被处理（非消息、缺字段等）。
 *
 * resolveName(qq) 用来给 @ 补显示名（NapCat 不提供，见 src/names.js）。
 * 不传也能用，只是 @ 会退化成「@某人」。
 * isBot(qq) 用来判断 @ 的是不是我们自己的机器人（决定命令有没有被指名，见 src/cmdline.js）。
 */
export function normalizeEvent(event, { selfId, nicknames = [], resolveName = null, isBot = null } = {}) {
  if (!event || event.post_type !== 'message') return null;
  const kind = event.message_type === 'group' ? 'group' : 'private';
  const peerId = String(kind === 'group' ? event.group_id : event.user_id);
  if (!peerId || peerId === 'undefined') return null;

  const segments = normalizeSegments(event.message);
  const acc = accumulate(segments, { resolveName });
  const textJoined = acc.textParts.join('');
  // 命令要从「剥掉 @ 之后」的文本里解析：
  // 群里常见写法是「@机器人 /help」，带 @ 时斜杠不在开头，用原始文本会认不出来。
  const textClean = stripSelfMentions(textJoined, {
    selfId,
    nicknames,
    selfTokens: acc.atTokens.filter((t) => selfId && t.qq === String(selfId)).map((t) => t.token),
  });
  const textRaw = [...acc.textParts, ...acc.markers].join('').trim();

  // 命令格式统一由 cmdline 规定：@ 指名 + /主命令 + 参数。
  // 按「消息段」解析而不是拼好的文本——段的顺序才是权威的。
  const command = parseCommandLine(segments, {
    isBot: typeof isBot === 'function' ? isBot : () => false,
  });

  return {
    botId: null,                 // 由调用方补齐
    kind,
    peerId,
    sessionKey: `${kind}:${peerId}`,
    messageId: String(event.message_id ?? ''),
    senderQq: String(event.user_id ?? ''),
    senderName: String(event.sender?.card || event.sender?.nickname || ''),
    senderRole: event.sender?.role ?? '',
    time: Number(event.time ?? 0) * 1000 || Date.now(),
    segments,
    text: textRaw,               // 给日志/展示用
    textClean,                   // 去掉 @ 的正文
    atSelf: isMentioned(acc, { selfId, nicknames }),
    atList: acc.atList,
    atTokens: acc.atTokens,      // @ 的 QQ 与实际渲染出的文本，便于排查名字解析
    atAll: acc.atAll,
    replyId: acc.replyId,
    images: acc.images,
    voices: acc.voices,
    faces: acc.faces,
    forwardIds: acc.forwardIds,
    unsupported: [...acc.unsupported],
    command,
  };
}
