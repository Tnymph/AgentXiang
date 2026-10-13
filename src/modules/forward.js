// 合并转发（聊天记录卡片）的读取
//
// OneBot 的 forward 段只给一个 id，内容要另外调 get_forward_msg 取。
// 取回来是一棵节点树，这里把它压成一段可读文本交给模型。
//
// 边界都做了限制：层数不递归、节点数与字数都封顶，
// 免得有人转发一大段把 prompt 撑爆。
import * as log from '../logger.js';

const MAX_NODES = 40;
const MAX_CHARS = 3000;

/** 一次转发里最多读几张图（默认值，可被设置覆盖） */
export const DEFAULT_MAX_FORWARD_IMAGES = 8;

/** 把单个节点的 message 段数组压成一行文本 */
export function flattenSegments(segments) {
  const parts = [];
  for (const seg of segments ?? []) {
    const t = seg?.type;
    const d = seg?.data ?? {};
    if (t === 'text') parts.push(String(d.text ?? ''));
    else if (t === 'at') parts.push(`@${d.name || d.qq || ''}`);
    else if (t === 'image') parts.push('[图片]');
    else if (t === 'face' || t === 'mface') parts.push('[表情]');
    else if (t === 'record') parts.push('[语音]');
    else if (t === 'video') parts.push('[视频]');
    else if (t === 'file') parts.push(`[文件:${d.name || ''}]`);
    else if (t === 'forward') parts.push('[嵌套的聊天记录]');
    else if (t === 'json' || t === 'xml') parts.push('[卡片]');
    // 其余类型直接忽略
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/**
 * 把转发节点里的图片地址收集出来，按出现顺序。
 *
 * 文本那边只写了个「[图片]」，图里有什么模型一概不知——想让它读懂
 * 转发内容就得把图也送去识别。地址是 QQ 图床的临时直链（带 rkey），
 * 收到转发时当下取才有效，过后会失效。
 *
 * 返回 { list, total }：list 是按上限截断的，total 是实际张数，
 * 两个都要——给模型说明「共几张、读了前几张」。
 */
export function collectForwardImages(nodes, limit = DEFAULT_MAX_FORWARD_IMAGES) {
  const usable = [];
  let total = 0;
  for (const node of nodes ?? []) {
    for (const seg of segmentsOf(node)) {
      if (seg?.type !== 'image') continue;
      // 总数要数所有图片段（哪怕地址取不到）——模型需要知道「这段记录里有几张图」，
      // 取不取得到是我们这边的事，不该让它以为那段记录里没有图。
      total++;
      const src = String(seg?.data?.url || seg?.data?.file || '').trim();
      if (src) usable.push(src);
    }
  }
  // limit 是「最多读几张」，所以 0 表示一张都不读（设置里就是这么写的），不是不限量
  return { list: limit > 0 ? usable.slice(0, limit) : [], total };
}

/** 从节点里取出发送者名字 */
function senderOf(node) {
  return String(
    node?.sender?.card || node?.sender?.nickname
    || node?.nickname || node?.sender?.user_id || node?.user_id || '某人',
  );
}

/** 节点的消息段数组在不同实现里可能是 message 或 content */
function segmentsOf(node) {
  const raw = node?.message ?? node?.content ?? node?.messages ?? [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') return [{ type: 'text', data: { text: raw } }];
  return [];
}

/**
 * 把 get_forward_msg 的返回压成文本，顺带收集里面的图片地址。
 * 返回 { ok, text, count, truncated, images, imageTotal }
 */
export function flattenForward(payload, { maxImages = DEFAULT_MAX_FORWARD_IMAGES } = {}) {
  const nodes = payload?.messages ?? payload?.data?.messages ?? payload?.nodes ?? [];
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { ok: false, text: '', count: 0, images: [], imageTotal: 0, reason: '没有内容' };
  }

  const lines = [];
  let chars = 0;
  let truncated = false;
  let count = 0;

  for (const node of nodes.slice(0, MAX_NODES)) {
    const who = senderOf(node);
    const body = flattenSegments(segmentsOf(node));
    if (!body) continue;
    const line = `${who}：${body}`;
    if (chars + line.length > MAX_CHARS) { truncated = true; break; }
    lines.push(line);
    chars += line.length;
    count++;
  }

  if (nodes.length > MAX_NODES) truncated = true;
  if (count === 0) return { ok: false, text: '', count: 0, images: [], imageTotal: 0, reason: '内容为空' };

  // 图片单独收一遍：文字那边有字数封顶，图不该被字数额度牵连
  const { list: images, total: imageTotal } = collectForwardImages(nodes.slice(0, MAX_NODES), maxImages);

  return {
    ok: true,
    text: lines.join('\n'),
    count,
    truncated: truncated || count < nodes.length,
    images,
    imageTotal,
  };
}

/**
 * 读取一条合并转发，压成文本并带上图。
 * 读不到不算错误——转发可能已过期或不在机器人可见范围内，只是没内容而已。
 */
export async function readForward(client, forwardId, { maxImages = DEFAULT_MAX_FORWARD_IMAGES } = {}) {
  try {
    const data = await client.getForwardMsg(forwardId);
    const flat = flattenForward(data, { maxImages });
    if (!flat.ok) {
      log.debug('forward', 'empty', { id: forwardId, reason: flat.reason });
      return flat;
    }
    log.debug('forward', 'read', {
      id: forwardId, count: flat.count, chars: flat.text.length,
      truncated: flat.truncated, images: flat.images.length, imageTotal: flat.imageTotal,
    });
    return flat;
  } catch (e) {
    log.debug('forward', 'read failed', { id: forwardId, err: String(e.message) });
    return { ok: false, text: '', count: 0, images: [], imageTotal: 0, reason: String(e.message) };
  }
}

/**
 * 把多条转发拼成给模型看的一段。
 * maxImages 是**总共**读几张，不是每条几张——成本闸门要按总量管。
 */
export async function readAllForwards(client, forwardIds, { limit = 2, maxImages = DEFAULT_MAX_FORWARD_IMAGES } = {}) {
  const out = [];
  let budget = maxImages;
  for (const id of (forwardIds ?? []).slice(0, limit)) {
    const r = await readForward(client, id, { maxImages: budget });
    if (r.ok) {
      out.push(r);
      budget = Math.max(0, budget - r.images.length);
    }
  }
  if (out.length === 0) return { ok: false, text: '', images: [], imageTotal: 0 };
  const text = out.map((r, i) => `【转发的聊天记录${out.length > 1 ? ' ' + (i + 1) : ''}】\n${r.text}`).join('\n\n');
  return {
    ok: true,
    text,
    truncated: out.some((r) => r.truncated),
    images: out.flatMap((r) => r.images),
    imageTotal: out.reduce((a, r) => a + r.imageTotal, 0),
  };
}
