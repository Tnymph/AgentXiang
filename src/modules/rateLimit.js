// 频控：三档阈值，全部是全局单一值，但按人分别计数
//
//   repeat —— 重复内容（更严）
//   unique —— 非重复内容
//   global —— 机器人整体防风控（不分人、不分群）
//
// 状态放内存：重启后计数清零，这对频控来说是可接受的（不是安全机制）。
import * as log from '../logger.js';
import { sameText } from '../textmatch.js';

const buckets = new Map();          // key -> number[] 时间戳
const recentReplies = new Map();    // `${botId}:${personId}` -> string[]
const MAX_KEEP_REPLIES = 10;

/** 命中一次限流；超限返回 ok:false 及还需等待多久 */
export function hit(key, windowMs, max, now = Date.now()) {
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    const oldest = arr[0];
    return { ok: false, count: arr.length, retryAfterMs: windowMs - (now - oldest) };
  }
  arr.push(now);
  buckets.set(key, arr);
  return { ok: true, count: arr.length };
}

/** 只读检查，不消费配额（用于预判） */
export function peek(key, windowMs, now = Date.now()) {
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  return arr.length;
}

/** 清理过期桶，避免长时间运行后内存膨胀 */
export function prune(now = Date.now(), maxAgeMs = 3600_000) {
  for (const [k, arr] of buckets) {
    const kept = arr.filter((t) => now - t < maxAgeMs);
    if (kept.length === 0) buckets.delete(k);
    else buckets.set(k, kept);
  }
  return buckets.size;
}

export function reset() {
  buckets.clear();
  recentReplies.clear();
}

// ---------- 重复内容判定 ----------

/** 记住一条已发出的回复 */
export function rememberReply(botId, personId, text) {
  const key = `${botId}:${personId}`;
  const arr = recentReplies.get(key) ?? [];
  arr.push(String(text));
  while (arr.length > MAX_KEEP_REPLIES) arr.shift();
  recentReplies.set(key, arr);
}

/** 这条内容跟最近发过的比，算重复还是新的 */
export function classifyContent(botId, personId, text, mode = 'loose') {
  const arr = recentReplies.get(`${botId}:${personId}`) ?? [];
  const isRepeat = arr.some((prev) => sameText(prev, text, mode));
  return isRepeat ? 'repeat' : 'unique';
}

// ---------- 对外：一次发言的准入检查 ----------

/**
 * 检查此刻能否发言。会消费配额。
 * 返回 { ok, reason, tier }
 */
export function allow(botId, settings, { personId, text, kind, peerId, repeatMatchMode }) {
  const rate = settings?.rate ?? {};

  // 1) 机器人整体（防风控）
  const g = rate.global ?? { perMinute: 10, perHour: 300 };
  const gMin = hit(`g:${botId}:m`, 60_000, g.perMinute ?? 10);
  if (!gMin.ok) return { ok: false, reason: `全局每分钟上限(${g.perMinute})`, tier: 'global' };
  const gHour = hit(`g:${botId}:h`, 3600_000, g.perHour ?? 300);
  if (!gHour.ok) return { ok: false, reason: `全局每小时上限(${g.perHour})`, tier: 'global' };

  // 2) 按人：先分类内容，再套对应阈值
  const tier = classifyContent(botId, personId, text, repeatMatchMode ?? 'loose');
  const cfg = tier === 'repeat'
    ? (rate.repeat ?? { windowSec: 60, max: 1 })
    : (rate.unique ?? { windowSec: 3600, max: 20 });

  const r = hit(`u:${botId}:${personId}:${tier}`, (cfg.windowSec ?? 60) * 1000, cfg.max ?? 1);
  if (!r.ok) {
    log.debug('rate', 'blocked', { tier, personId, retryInSec: Math.ceil(r.retryAfterMs / 1000) });
    return { ok: false, reason: `${tier === 'repeat' ? '重复内容' : '非重复内容'}频率上限`, tier };
  }

  return { ok: true, tier };
}

/** 主动发言的群级频控（每小时条数 + 最小间隔） */
export function allowActiveSpeak(botId, settings, groupId) {
  const cfg = settings?.speak?.active ?? { perGroupPerHour: 5, minGapSec: 60 };
  const hour = hit(`act:${botId}:${groupId}:h`, 3600_000, cfg.perGroupPerHour ?? 5);
  if (!hour.ok) return { ok: false, reason: '本群每小时主动发言上限' };
  const gap = hit(`act:${botId}:${groupId}:gap`, (cfg.minGapSec ?? 60) * 1000, 1);
  if (!gap.ok) return { ok: false, reason: '距上次主动发言间隔不足' };
  return { ok: true };
}
