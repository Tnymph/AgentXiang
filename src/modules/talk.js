// AI 互聊模式
//
// 默认关。关着的时候，一个群里几个机器人**互相当对方不存在**（连历史都不记）。
// 打开之后它们会接对方的话——所以必须配刹车，否则就是无限循环：
//   A 说了话 → B 接 → A 再接 → B 再接 ……一直烧到限额为止。
//
// 两道刹车：
//   1. maxChain —— 连续几条都是机器人在自说自话就停，等真人开口再恢复。
//      这才是真正的刹车，minGap 只影响观感。
//   2. minGapMs —— 同一个群里机器人两次发言之间至少隔这么久，免得两个号
//      你一句我一句刷屏（间隔按「群」记，跨机器人共享，所以是它们之间的间隔）。
import { loadGlobal } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 上次发言时刻：key -> 毫秒时间戳。放内存，重启清零（频控类状态这样处理够了） */
const lastSentAt = new Map();

/** 数值兜底：非法值（NaN、'abc'、null）一律回落到默认，别把 NaN 传出去 */
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 取互聊配置。读的是**全局**设置——这个开关是「全体打开」的，
 * 不是每个机器人各管各的。
 */
export function talkConfig(global = null) {
  const t = (global ?? loadGlobal())?.talk ?? {};
  return {
    enabled: t.enabled === true,
    minGapMs: Math.max(0, num(t.minGapMs, 1500)),
    maxChain: Math.max(1, num(t.maxChain, 6)),
  };
}

/**
 * 等到距上次发言够久，然后占位。
 * 按 key 共享（调用方用群号），所以算的是「群里所有机器人」之间的间隔。
 */
export async function waitForGap(key, minGapMs) {
  const gap = Math.max(0, Number(minGapMs) || 0);
  if (gap <= 0) return 0;
  const now = Date.now();
  const last = lastSentAt.get(key) ?? 0;
  const wait = last + gap - now;
  if (wait > 0) await sleep(wait);
  const waited = Math.max(0, Date.now() - now);
  lastSentAt.set(key, Date.now());
  return waited;
}

/** 只查还要等多久，不占位（诊断用） */
export function gapRemaining(key, minGapMs, now = Date.now()) {
  const last = lastSentAt.get(key) ?? 0;
  return Math.max(0, last + Math.max(0, Number(minGapMs) || 0) - now);
}

/** 清掉计时（测试用） */
export function resetGaps() {
  lastSentAt.clear();
}
