// 复读检测：群里不同的人发了相同内容 → 机器人跟一句原话
//
// 只在主动模式生效（由调用方判断），只跟一次，机器人自己的发言不参与计数。
import { normalize, isValidMode } from '../textmatch.js';
import * as log from '../logger.js';

const windows = new Map();     // `${botId}:${groupId}` -> [{senderQq, text, norm, isBot, ts}]
const echoed = new Map();      // `${botId}:${groupId}` -> [{norm, ts}]

const MAX_WINDOW = 200;
const ECHO_MEMORY_MS = 10 * 60 * 1000;

function windowOf(botId, groupId) {
  const key = `${botId}:${groupId}`;
  if (!windows.has(key)) windows.set(key, []);
  return windows.get(key);
}

/** 记一条群消息（机器人自己发的也要记，但要标记出来） */
export function noteMessage(botId, groupId, { senderQq, text, isBot = false, ts = Date.now() }) {
  const w = windowOf(botId, groupId);
  // 只存原文：规范化在检测时按当前配置的档位实时做，
  // 这样改档位立即生效，也不会出现「入库用一档、比较用另一档」的错配。
  w.push({ senderQq: String(senderQq), text: String(text ?? ''), isBot, ts });
  while (w.length > MAX_WINDOW) w.shift();
}

/** 取该群最近的窗口 */
export function recentWindow(botId, groupId, n = 20) {
  return windowOf(botId, groupId).slice(-n);
}

/** 判断一段文本值不值得参与复读（过滤太短、纯标点、纯表情） */
export function worthEchoing(text, { minLength = 2 } = {}) {
  const t = String(text ?? '').trim();
  if (t.length < minLength) return false;
  // 纯标点/空白/emoji 不算
  const meaningful = t.replace(/[\s\p{P}\p{S}]/gu, '');
  if (meaningful.length < minLength) return false;
  return true;
}

/** 已经跟过这句话了吗（防重复跟） */
function alreadyEchoed(botId, groupId, norm, now) {
  const key = `${botId}:${groupId}`;
  const arr = (echoed.get(key) ?? []).filter((x) => now - x.ts < ECHO_MEMORY_MS);
  echoed.set(key, arr);
  return arr.some((x) => x.norm === norm);
}

function markEchoed(botId, groupId, norm, now) {
  const key = `${botId}:${groupId}`;
  const arr = echoed.get(key) ?? [];
  arr.push({ norm, ts: now });
  echoed.set(key, arr);
}

/**
 * 检测是否有复读机会。
 * 只看刚进来的那一条（窗口最后一条），往前找相同内容的不同发送者。
 * 返回 { hit, text, people } 或 null。
 */
export function detect(botId, groupId, settings, now = Date.now()) {
  const cfg = groupCfg(botId, groupId, settings);
  if (!cfg.enabled) return null;

  const mode = isValidMode(cfg.matchMode) ? cfg.matchMode : 'loosest';
  const w = windowOf(botId, groupId);
  if (w.length === 0) return null;

  const cur = w[w.length - 1];
  if (cur.isBot) return null;                       // 机器人自己的发言不触发
  if (!worthEchoing(cur.text, { minLength: cfg.minLength ?? 2 })) return null;

  const curNorm = normalize(cur.text, mode);
  if (!curNorm) return null;
  if (alreadyEchoed(botId, groupId, curNorm, now)) return null;

  // 往前找相同内容，最多回溯 cfg.windowMessages 条
  const limit = Math.max(1, cfg.windowMessages ?? 15);
  const start = Math.max(0, w.length - 1 - limit);
  const senders = new Set();
  let earliestIdx = w.length - 1;

  for (let i = w.length - 2; i >= start; i--) {
    const prev = w[i];
    if (prev.isBot) continue;
    if (normalize(prev.text, mode) !== curNorm) continue;
    senders.add(prev.senderQq);
    earliestIdx = i;
  }

  // 当前发送者也算一个人
  senders.add(cur.senderQq);

  const gap = w.length - 1 - earliestIdx;            // 中间隔了几条
  const need = Math.max(2, cfg.minPeople ?? 2);

  if (senders.size < need) return null;
  if (gap > (cfg.maxGapMessages ?? 3) + 1) return null;

  markEchoed(botId, groupId, curNorm, now);
  log.debug('repeatEcho', 'candidate', { botId, groupId, people: senders.size, gap, text: cur.text.slice(0, 30) });
  return { hit: true, text: cur.text, norm: curNorm, people: senders.size, gap };
}

/** 取某群的生效配置：全局默认 + 该群覆盖 */
export function groupCfg(botId, groupId, settings) {
  const base = settings?.repeatEcho ?? {};
  const override = base.perGroup?.[String(groupId)] ?? {};
  return { ...base, ...override };
}

export function reset() {
  windows.clear();
  echoed.clear();
}
