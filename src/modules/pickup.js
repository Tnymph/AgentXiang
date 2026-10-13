// 接话：配置好「触发词 → 怎么接」，命中就主动接一句
//
// 和复读（repeatEcho）的区别：复读是「好几个人说了同一句，模型自己决定要不要跟着说」，
// 是涌现行为；接话是**你写死的规则**，命中就一定接 —— 通常回一句固定话术（不花模型钱），
// 需要灵活接的时候把 mode 设成 ai，交给模型顺着说。
//
// 规则存在库里（每个机器人一套），界面「接话」页可增删改，支持一行一个批量粘。
import * as db from '../db.js';
import * as log from '../logger.js';
import * as rate from './rateLimit.js';
import { normalize } from '../textmatch.js';

export const MATCHES = ['contains', 'exact'];
export const MODES = ['fixed', 'ai'];
export const MATCH_LABEL = { contains: '包含', exact: '完全相同' };
export const MODE_LABEL = { fixed: '回固定话术', ai: '让模型顺着接' };

const MAX_PATTERN = 60;      // 触发词最长多少字
const MAX_REPLY = 300;       // 每种回法最长多少字
const MAX_VARIANTS = 20;     // 一条规则最多几种回法
const MAX_RULES = 200;       // 一个机器人最多多少条规则
const SELF_MIN_CHARS = 4;    // 回法至少几个字才参与「自己接自己」的判定（见 isSelfCase）

/** 功能参数（界面上可改） */
export function cfg(settings) {
  const c = settings?.pickup ?? {};
  const chance = Number(c.selfChance);
  return {
    enabled: c.enabled !== false,
    defaultCooldownSec: Number.isFinite(Number(c.defaultCooldownSec)) ? Number(c.defaultCooldownSec) : 60,
    maxPerHour: Number.isFinite(Number(c.maxPerHour)) ? Number(c.maxPerHour) : 20,
    // 「自己接自己」的概率：对方说的这句话里已经含有你要回的那句时，只按这个概率接
    //（0 = 从不接，1 = 照接不误）。默认 0.3。
    selfChance: Number.isFinite(chance) ? Math.min(1, Math.max(0, chance)) : 0.3,
  };
}

// ---------- 一句话可以有好几种回法 ----------

const VARIANT_SEP = /\r?\n|\|/;

/**
 * 一条规则的所有回法。
 * 多条用**换行或 | 分隔**（界面上就是个多行框）→ 随机挑一条，
 * 且同一段对话里挑过的不再挑（见 pickVariant）。
 */
export function variantsOf(rule) {
  return String(rule?.reply ?? '')
    .split(VARIANT_SEP)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 这句话本身就是你要回的内容吗（「自己接自己」：对方已经说了「原神怎么你了」）。
 *
 * 只有**够长的回法**才算：短回法会被日常话随手撞上 —— 规则「吃了吗 → 吃了/没吃/你猜」
 * 里，对方说的「吃了吗」本身就含有「吃了」，按子串判就成了「自己接自己」，
 * 正常命中反而被概率挡掉了（实测踩过）。所以 4 个字以下不参与这个判定。
 */
export function isSelfCase(rule, text) {
  const hay = normalize(text);
  if (!hay) return false;
  return variantsOf(rule).some((v) => v.length >= SELF_MIN_CHARS && hay.includes(normalize(v)));
}

// 同一段对话里已经用过的回法：`${botId}:${sessionId}:${ruleId}` -> Set(下标)
const usedVariants = new Map();
const USED_MAX_KEYS = 500;     // 防内存膨胀：超过就清最早的一批（重启也会清空）

function usedKey(botId, sessionId, ruleId) {
  return `${botId}:${sessionId ?? 0}:${ruleId}`;
}

/**
 * 挑一条回法：优先挑这段对话里**还没用过的**；全用过了就把记录清掉重新开始
 *（宁可重复，也不能因为「都说完了」而彻底不接）。
 * 返回 { text, index, reused, total }
 */
export function pickVariant(botId, sessionId, rule, random = Math.random) {
  const all = variantsOf(rule);
  if (all.length === 0) return { text: '', index: -1, reused: 0, total: 0 };
  const key = usedKey(botId, sessionId, rule.id);
  let used = usedVariants.get(key);
  // 这一段对话全挑过一轮了 → 清掉重来（宁可重复，也不能因为「都说完了」而彻底不接）
  const exhausted = !used || used.size >= all.length;
  const fresh = all.map((t, i) => i).filter((i) => !used?.has(i));
  if (exhausted) {
    used = new Set();
    usedVariants.set(key, used);
    if (usedVariants.size > USED_MAX_KEYS) {
      // 简单地丢掉最早插入的一批（Map 保持插入顺序）
      const drop = usedVariants.size - USED_MAX_KEYS;
      let i = 0;
      for (const k of usedVariants.keys()) {
        usedVariants.delete(k);
        if (++i >= drop) break;
      }
      usedVariants.set(key, used);
    }
  }
  const pool = exhausted ? all.map((t, i) => i) : fresh;
  const idx = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
  used.add(idx);
  // reused = 挑之前这段对话已经用掉了几种（这一轮若是重来，就是全部）
  return { text: all[idx], index: idx, reused: exhausted ? all.length : all.length - fresh.length, total: all.length };
}

/** 只读：这段对话里这条规则已经用过几种回法（界面上用不到，测试与排查用） */
export function usedVariantCount(botId, sessionId, rule) {
  return usedVariants.get(usedKey(botId, sessionId, rule.id))?.size ?? 0;
}

/** 测试用：清掉「这段对话用过哪些回法」的记录 */
export function resetVariants() {
  usedVariants.clear();
}

// ---------- 规则读写 ----------

export function listRules(botId) {
  return db.all('select * from pickup_rules where bot_id = ? order by id', botId);
}

export function enabledRules(botId) {
  return db.all('select * from pickup_rules where bot_id = ? and enabled = 1 order by id', botId);
}

function cleanRule({ pattern, match, reply, mode, cooldownSec } = {}) {
  const p = String(pattern ?? '').trim();
  if (!p) return { ok: false, error: '触发词不能为空' };
  if (p.length > MAX_PATTERN) return { ok: false, error: `触发词太长了（最多 ${MAX_PATTERN} 字）` };
  const m = MATCHES.includes(String(match)) ? String(match) : 'contains';
  const md = MODES.includes(String(mode)) ? String(mode) : 'fixed';
  const r = String(reply ?? '').trim();
  const variants = variantsOf({ reply: r });
  if (md === 'fixed' && variants.length === 0) return { ok: false, error: '「回固定话术」必须写一句要回的话' };
  if (variants.length > MAX_VARIANTS) return { ok: false, error: `一句话最多配 ${MAX_VARIANTS} 种回法` };
  const tooLong = variants.find((v) => v.length > MAX_REPLY);
  if (tooLong) return { ok: false, error: `每条回法最多 ${MAX_REPLY} 字，这条太长了：${tooLong.slice(0, 16)}…` };
  const cd = Number(cooldownSec);
  return {
    ok: true,
    rule: {
      pattern: p,
      match: m,
      mode: md,
      reply: variants.join('\n'),      // 统一成换行分隔存库
      cooldownSec: Number.isFinite(cd) && cd >= 0 ? Math.min(cd, 3600) : 0,
    },
  };
}

export function addRule(botId, input) {
  const c = cleanRule(input);
  if (!c.ok) throw new Error(c.error);
  const n = db.one('select count(*) as c from pickup_rules where bot_id = ?', botId);
  if (Number(n?.c ?? 0) >= MAX_RULES) throw new Error(`规则太多了（上限 ${MAX_RULES} 条）`);
  const r = c.rule;
  const id = db.run(`insert into pickup_rules
    (bot_id, pattern, match, reply, mode, enabled, cooldown_sec, hits, last_hit_at, created_at)
    values (?,?,?,?,?,1,?,0,0,?)`,
    botId, r.pattern, r.match, r.reply, r.mode, r.cooldownSec, Date.now()).lastInsertRowid;
  log.info('pickup', 'rule added', { botId, id, pattern: r.pattern, match: r.match, mode: r.mode });
  return Number(id);
}

/**
 * 批量加：一行一个触发词，共用同一套回法（界面上粘一串最省事）。
 * 返回 { added, skipped }：重复的、空行、超长的会被跳过并说明原因。
 */
export function addRules(botId, lines, defaults = {}) {
  const existing = new Set(listRules(botId).map((r) => normalize(r.pattern)));
  let added = 0;
  const skipped = [];
  for (const raw of String(lines ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (existing.has(normalize(line))) { skipped.push({ line, why: '已经有这条了' }); continue; }
    try {
      addRule(botId, { ...defaults, pattern: line });
      existing.add(normalize(line));
      added++;
    } catch (e) {
      skipped.push({ line, why: String(e.message) });
    }
  }
  return { added, skipped };
}

export function updateRule(id, patch = {}) {
  const row = db.one('select * from pickup_rules where id = ?', id);
  if (!row) throw new Error('规则不存在');
  const merged = cleanRule({
    pattern: patch.pattern ?? row.pattern,
    match: patch.match ?? row.match,
    reply: patch.reply ?? row.reply,
    mode: patch.mode ?? row.mode,
    cooldownSec: patch.cooldownSec ?? row.cooldown_sec,
  });
  if (!merged.ok) throw new Error(merged.error);
  const r = merged.rule;
  db.run('update pickup_rules set pattern = ?, match = ?, reply = ?, mode = ?, cooldown_sec = ? where id = ?',
    r.pattern, r.match, r.reply, r.mode, r.cooldownSec, id);
  if (patch.enabled !== undefined) {
    db.run('update pickup_rules set enabled = ? where id = ?', patch.enabled ? 1 : 0, id);
  }
  log.info('pickup', 'rule updated', { id, pattern: r.pattern, enabled: patch.enabled });
  return true;
}

export function removeRule(id) {
  db.run('delete from pickup_rules where id = ?', id);
  return true;
}

export function clearRules(botId) {
  const n = db.one('select count(*) as c from pickup_rules where bot_id = ?', botId);
  db.run('delete from pickup_rules where bot_id = ?', botId);
  return Number(n?.c ?? 0);
}

// ---------- 被找茬时回一个字 ----------

/**
 * 「对方没事找事时，有概率回一个字」。
 *
 * 「没事找事」是语义判断，本地匹配做不到，所以交给模型：提示词里告诉它什么情况算、
 * 想这么接就写一个 [急] 记号，本地按概率决定发不发（这是项目里「语音记号」那套做法）。
 */
export const ANNOYED_MARKER = /[\[【〔（(]\s*急\s*[\]】〕）)]/g;
const ANNOYED_MAX_REST = 30;      // 记号旁边还有正文时，正文超过这么多字就不当成「就回这一个字」
// 只有**直接挨骂**才算（用户 2026-09-27 要求：「一定要很强烈的攻击才行，比如 nmsl sb nmd」）；
// 普通的阴阳怪气、抬杠、开玩笑都不算 —— 描述写清楚，模型才判得准。
export const ANNOYED_DEFAULT_WHEN = '对方**直接辱骂你**的时候（人身攻击、脏话，比如 nmsl、sb、nmd 这种程度）。'
  + '普通的抱怨、阴阳怪气、抬杠、拿你开个玩笑都**不算**，那种就正常回话';
// 而且这种情况下也要「很少回」（用户原话）—— 一成左右，界面上可改。
const ANNOYED_DEFAULT_CHANCE = 0.1;

export function annoyedCfg(settings) {
  const a = settings?.pickup?.annoyed ?? {};
  const chance = Number(a.chance);
  return {
    enabled: a.enabled !== false,
    chance: Number.isFinite(chance) ? Math.min(1, Math.max(0, chance)) : ANNOYED_DEFAULT_CHANCE,
    text: String(a.text ?? '').trim() || '急',
    when: String(a.when ?? '').trim() || ANNOYED_DEFAULT_WHEN,
  };
}

/**
 * 从模型回复里取出「就回这一个字」的记号。
 * 返回 { marked, cleaned }：marked 表示模型想这么回；cleaned 是去掉记号后的正文。
 * 记号在哪儿出现都认（和语音记号一个规矩：泄漏到群里过一次，教训）。
 */
export function extractAnnoyed(text) {
  const raw = String(text ?? '');
  const marked = ANNOYED_MARKER.test(raw);
  ANNOYED_MARKER.lastIndex = 0;                 // test 之后必须复位，否则下次判定从上次位置开始
  const cleaned = raw.replace(ANNOYED_MARKER, '').trim();
  return { marked, cleaned };
}

/** 记号敢不敢用：正文太长说明它只是顺手写了记号，那就照正文发（免得正文白写） */
export function annoyedUsable(cleaned) {
  return String(cleaned ?? '').trim().length <= ANNOYED_MAX_REST;
}

// ---------- 匹配 ----------

/** 触发词在文本里出现过吗（忽略大小写与全半角；exact 要求整条相同） */
export function ruleMatches(rule, text) {
  const hay = normalize(text);
  const needle = normalize(rule.pattern);
  if (!hay || !needle) return false;
  return rule.match === 'exact' ? hay === needle : hay.includes(needle);
}

/** 按 id 顺序找第一条命中的规则（越早建的越优先，界面上可调顺序=删了重加） */
export function matchText(text, rules) {
  for (const r of rules) {
    if (ruleMatches(r, text)) return r;
  }
  return null;
}

/**
 * 找一条**现在就能接**的规则：命中的里跳过还在冷却的那条，让后面命中的顶上。
 * 只判断不记账 —— 真正要发之前才 commit()，这样被回复名单/频控挡下的命中不会白吃冷却。
 */
export function matchEligible(botId, text, settings, now = Date.now()) {
  let cooling = null;
  for (const r of enabledRules(botId)) {
    if (!ruleMatches(r, text)) continue;
    const cd = peekCooldown(botId, r, settings, now);
    if (cd.ok) return { rule: r };
    if (!cooling) cooling = { rule: r, retryInSec: cd.retryInSec };
  }
  return { rule: null, cooling };
}

// ---------- 冷却与限额 ----------

const lastHit = new Map();   // `${botId}:${ruleId}` -> ts

/** 这条规则现在能不能接（只看，不记账） */
export function peekCooldown(botId, rule, settings, now = Date.now()) {
  const c = cfg(settings);
  const sec = Number(rule?.cooldown_sec) > 0 ? Number(rule.cooldown_sec) : c.defaultCooldownSec;
  const key = `${botId}:${rule?.id ?? 0}`;
  // 没记过就是没接过：不能拿 0 当时间戳比（now 小时会误判成「刚接过」）
  if (!lastHit.has(key)) return { ok: true, sec };
  const prev = lastHit.get(key);
  if (now - prev < sec * 1000) {
    return { ok: false, retryInSec: Math.ceil((sec * 1000 - (now - prev)) / 1000), sec };
  }
  return { ok: true, sec };
}

/**
 * 真要接了：记账（本小时配额 + 这条规则的冷却）。
 * 配额不够时**不消费**任何东西就返回 false，调用方按「这次不接」处理。
 */
export function commit(botId, rule, settings, now = Date.now()) {
  const c = cfg(settings);
  const hourly = rate.hit(`pickup:${botId}:h`, 3600_000, c.maxPerHour, now);
  if (!hourly.ok) {
    return { ok: false, why: `本小时接话已达上限(${c.maxPerHour} 次)`, retryAfterMs: hourly.retryAfterMs };
  }
  lastHit.set(`${botId}:${rule?.id ?? 0}`, now);
  return { ok: true, count: hourly.count };
}

/** 旧的单步函数（保留给测试和外部调用）：判断并记账 */
export function allowCooldown(botId, rule, settings, now = Date.now()) {
  const p = peekCooldown(botId, rule, settings, now);
  if (!p.ok) return p;
  lastHit.set(`${botId}:${rule?.id ?? 0}`, now);
  return p;
}

/** 记一次命中（界面上看得到「真的在接」） */
export function noteHit(botId, ruleId, now = Date.now()) {
  try {
    db.run('update pickup_rules set hits = hits + 1, last_hit_at = ? where id = ?', now, ruleId);
  } catch (e) {
    log.warn('pickup', 'hit 记账失败', String(e.message).slice(0, 80));
  }
  return true;
}

/** 测试用：清掉内存里的冷却 */
export function resetCooldown() {
  lastHit.clear();
}

export function hourlyCount(botId, now = Date.now()) {
  return rate.peek(`pickup:${botId}:h`, 3600_000, now);
}
