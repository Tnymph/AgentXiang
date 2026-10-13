// 发言决策：主动 / 被动 / 关闭
//
// 主动模式走两级闸门：本地规则粗筛 → 通过的才送模型判断要不要接话。
// 这样能挡掉九成以上的无效调用，成本可控。
import * as log from '../logger.js';
import * as echoCfg from './repeatEcho.js';

export const MODES = ['active', 'passive', 'off'];

/** 取某会话的发言模式。私聊恒为被动（在私聊里主动发消息太容易被吓到）。 */
export function decideMode(settings, { kind, peerId }) {
  const sp = settings?.speak ?? {};
  if (kind === 'private') return sp.privateMode === 'off' ? 'off' : 'passive';
  const per = sp.groupModes?.[String(peerId)];
  const mode = MODES.includes(per) ? per : (sp.defaultGroupMode ?? 'passive');
  return MODES.includes(mode) ? mode : 'passive';
}

/**
 * 主动模式的本地粗筛。只做「值不值得让模型看一眼」的判断，不判断该说什么。
 * 返回 { pass, reason }
 */
export function prefilter(msg, settings, { random = Math.random } = {}) {
  const cfg = settings?.speak?.active ?? {};
  const minLen = cfg.minMessageLength ?? 2;
  const rate = cfg.randomRate ?? 0.15;

  const text = String(msg.textClean ?? '').trim();
  // 图片和合并转发本身就是内容，不是「没写文字的空消息」。
  // 拿文字长度去衡量它们，纯图/纯转发就永远过不了粗筛——
  // 主动模式下发一张图，机器人一声不吭，看起来像坏了。
  const hasContent = (msg.images?.length ?? 0) > 0 || (msg.forwardIds?.length ?? 0) > 0;

  if (!text && !hasContent) {
    return { pass: false, reason: '空消息' };
  }
  if (!hasContent && text.length < minLen) {
    return { pass: false, reason: `太短(${text.length}<${minLen})` };
  }
  // 纯标点/表情不值得让模型判断
  const meaningful = text.replace(/[\s\p{P}\p{S}]/gu, '');
  if (meaningful.length === 0 && !hasContent) {
    return { pass: false, reason: '纯标点或表情' };
  }
  // 以斜杠开头的是命令，不参与主动发言
  if (text.startsWith('/') || text.startsWith('／')) {
    return { pass: false, reason: '命令' };
  }
  // 图或转发进来的（hasContent）：那是真有事要问，不该再赌一次随机。
  // 上面几处放行了长度和标点判断，但随机闸门在最后又拦一道 —— 实测群里发图
  // 经常就停在「粗筛:随机未命中」，表现就是「发图它不理」。所以这里必须放行。
  if (hasContent) {
    return { pass: true, reason: 'ok:有图或转发' };
  }
  if (random() >= rate) {
    return { pass: false, reason: `随机未命中(${rate})` };
  }
  return { pass: true, reason: 'ok' };
}

/** 复读机会是否可用于主动发言（该群必须处于主动模式） */
export function echoAllowed(settings, groupId) {
  const cfg = echoCfg.groupCfg(null, groupId, settings);
  if (cfg.enabled === false) return false;
  if (cfg.onlyActiveMode === false) return true;
  return decideMode(settings, { kind: 'group', peerId: groupId }) === 'active';
}

/** 兜底回复该用哪个场景 */
export function fallbackScene(msg) {
  const u = new Set(msg.unsupported ?? []);
  if (u.has('video')) return 'video';
  if (u.has('file')) return 'file';
  if (u.has('card')) return 'card';
  if (u.has('location')) return 'location';
  if (u.has('voice')) return 'voice';
  return u.size > 0 ? 'other' : null;
}

/** 消息是否只有无法处理的内容（没有可读文本） */
export function isUnprocessable(msg) {
  const text = String(msg.textClean ?? '').trim();
  if (text.length > 0) return false;
  return (msg.unsupported?.length ?? 0) > 0;
}

export function logDecision(botId, sessionKey, decision, detail) {
  log.debug('speak', 'decision', { botId, session: sessionKey, decision, ...detail });
}

/** 讲解/专业类问题的信号词。命中就按「详细」档处理，允许一条消息多带几句。 */
export const DEFAULT_DETAILED_KEYWORDS = [
  '证明', '定义', '定理', '推导', '为什么', '怎么算', '怎么求', '区别', '原理',
  '讲解', '解释一下', '举个例', '题目', '作业', '考试', '矩阵', '向量', '行列式',
  '线性', '方程', '函数', '积分', '导数', '极限', '几何', '排列', '多项式',
];

/** 按句末标点切句，标点跟着前一句 */
export function splitSentences(text) {
  const t = String(text ?? '').trim();
  if (!t) return [];
  return (t.match(/[^。！？!?…；;~\n]+[。！？!?…；;~]*/g) ?? [t])
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 把几句拼成一条消息。
 *
 * 不能直接 join('')：切句时句末标点和换行都被吃掉了，于是「一行一句、不带句号」
 * 的写法（猪咪就是这种：笑死我了 / 这也太抽象了）会被黏成一行
 * 「笑死我了这也太抽象了」——读起来是糊的。
 * 前一句末尾没有句末标点就补一个换行；有标点的（「甲。乙。」）保持原样不受影响。
 */
function joinSentences(list) {
  let out = '';
  for (const s of list) {
    if (out && !/[。！？!?…；;~]$/.test(out)) out += '\n';
    out += s;
  }
  return out;
}

/**
 * 把回复拆成若干条消息。
 *
 * 真人聊天是一条一句往外蹦的，所以这里按「句子」而不是「字数」来切。
 * maxSentences 是一条消息装几句（可调），maxMessages 是条数上限，
 * 防止一次刷出一长串；内容不会丢，条数超了就把多余的句子并进后面的消息里。
 */
export function splitReply(text, { maxSentences = 1, maxMessages = 3 } = {}) {
  const t = String(text ?? '').trim();
  if (!t) return [];

  const sentences = splitSentences(t);
  if (sentences.length <= maxSentences) return [t];

  const chunks = [];
  for (let i = 0; i < sentences.length; i += maxSentences) {
    chunks.push(joinSentences(sentences.slice(i, i + maxSentences)));
  }
  if (chunks.length <= maxMessages) return chunks;

  // 条数超了：均匀合并，宁可每条长一点也不要刷屏，同时不丢内容
  const per = Math.ceil(chunks.length / maxMessages);
  const out = [];
  for (let i = 0; i < chunks.length; i += per) out.push(chunks.slice(i, i + per).join(''));
  return out.slice(0, maxMessages);
}

/**
 * 这次回复该允许一条消息带几句。
 * 讲解类问题放宽，日常闲聊收紧——问「什么是矩阵」和问「在吗」不该一个待遇。
 */
export function pickSentenceLimit(questionText, settings) {
  const sp = settings?.speak ?? {};
  const kw = Array.isArray(sp.detailedKeywords) && sp.detailedKeywords.length
    ? sp.detailedKeywords
    : DEFAULT_DETAILED_KEYWORDS;
  const q = String(questionText ?? '');
  const hit = kw.find((k) => k && q.includes(k));
  const detailed = !!hit;
  return {
    detailed,
    matched: hit ?? '',
    maxSentences: detailed
      ? Math.max(1, Number(sp.maxSentencesDetailed) || 3)
      : Math.max(1, Number(sp.maxSentences) || 1),
  };
}

/** 取某机器人的回复长度与切分设置 */
export function replyShape(settings) {
  const sp = settings?.speak ?? {};
  // 数值兜底：没设、设成 NaN/垃圾值都回落到默认。
  // 早先这里是 `Number(x) ?? 350`——Number(undefined) 是 NaN，而 NaN 判假，
  // 结果「分条间隔默认 350 毫秒」从来没生效过，几条消息一直是零间隔连发。
  const num = (v, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  };
  return {
    maxChars: Math.max(10, num(sp.replyMaxChars, 45)),
    split: sp.splitLongReplies !== false,
    maxSentences: Math.max(1, num(sp.maxSentences, 1)),
    maxSentencesDetailed: Math.max(1, num(sp.maxSentencesDetailed, 3)),
    maxMessages: Math.max(1, Math.min(8, num(sp.maxMessages, 3))),
    segmentDelayMs: Math.max(0, Math.min(3000, num(sp.segmentDelayMs, 350))),
  };
}
