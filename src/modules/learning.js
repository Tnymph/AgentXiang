// 学习机制：从「机器人自己的历史回复」与「你手动标记的例子」里提炼新特征
//
// 流程：收集素材 → 提炼成建议 → 你逐条审核 → 采纳前自动存快照 → 写回风格卡
//
// 设计上刻意不自动应用：风格最怕的不是"学得不够像"，而是**缓慢地漂向通用腔**，
// 而那种漂移单看每一次都合理。所以默认每一条都要人过一遍。
import * as db from '../db.js';
import * as log from '../logger.js';
import * as llm from '../llm.js';
import * as persona from './persona.js';
import { normalize } from '../textmatch.js';

const MAX_A_CHARS = 12000;   // 正面素材的字符上限，避免一次塞爆

/**
 * 学习的 token 上限。
 *
 * 输出是一整份建议 JSON（可能十几条，每条带理由和证据），比一次聊天回复长得多；
 * 而**思考和可见输出共享同一份预算**（completion_tokens = 思考 + 正文）。
 * 实测（2026-09-25）：思考吃掉 7396~7928 个，8192 的上限只剩一两百 token 给正文，
 * 结果三次点「立即学习」全是「模型输出被截断」。
 * 上限只是上限，给大不会多花钱，只在需要时才用。
 */
const LEARN_MAX_TOKENS = 16384;
/** 撞到上限时的重试预算（和对话那边一个思路：翻倍再试一次） */
const LEARN_RETRY_MAX_TOKENS = 32768;

// ---------- 素材收集 ----------

/** 上一次学习的时间点：只学之后产生的新素材，避免反复嚼同一批话 */
function lastRunAt(botId) {
  const row = db.one(
    "select created_at from learn_runs where bot_id = ? and status = 'applied' order by created_at desc limit 1", botId);
  return Number(row?.created_at ?? 0);
}

/**
 * 素材 A：机器人自己说过的、没被标 👎 的话。
 * 按规范化文本去重 —— 机器人会重复说同样的话，不去重会把这批素材撑爆。
 */
export function collectSourceA(botId, { sinceTs = null, maxChars = MAX_A_CHARS } = {}) {
  const since = sinceTs ?? lastRunAt(botId);
  const rows = db.all(`
    select m.text, m.ts, mk.kind as mark
    from messages m
    left join marks mk on mk.message_id = m.id and mk.bot_id = m.bot_id
    where m.bot_id = ? and m.role = 'bot' and m.text <> '' and m.ts > ?
    order by m.ts desc limit 800`, botId, since);

  const seen = new Set();
  const out = [];
  let chars = 0;
  for (const r of rows) {
    if (r.mark === 'bad') continue;                 // 被明确否定的不进正面素材
    const key = normalize(r.text, 'loosest');
    if (seen.has(key)) continue;
    seen.add(key);
    const t = String(r.text).trim();
    if (chars + t.length > maxChars) break;
    chars += t.length;
    out.push(t);
  }
  return { items: out, chars, since, excluded: rows.filter((r) => r.mark === 'bad').length };
}

/** 素材 B：你手动标记的正面/负面例子 */
export function collectSourceB(botId) {
  const pick = (kind) => db.all(`
    select m.text from marks mk
    join messages m on m.id = mk.message_id
    where mk.bot_id = ? and mk.kind = ?
    order by mk.created_at desc limit 200`, botId, kind).map((r) => String(r.text).trim()).filter(Boolean);
  const good = pick('good');
  const bad = pick('bad');
  return { good, bad };
}

/** 素材概览（界面用） */
export function sourceStats(botId, { full = false } = {}) {
  const a = collectSourceA(botId, full ? { sinceTs: 0 } : {});
  const b = collectSourceB(botId);
  const notes = collectNotes(botId);
  return {
    a: { count: a.items.length, chars: a.chars, since: a.since, excluded: a.excluded },
    b: { good: b.good.length, bad: b.bad.length },
    notes: { count: notes.length },
  };
}

// ---------- 手动语料 ----------

/**
 * 手动加的语料：界面上粘的，或者 /learn quote 引用别人的消息存下来的。
 * 和「机器人自己说过的话」不一样 —— 这是用户特意挑的参考（可能来自别人），
 * 所以每次学习都带上，不按时间过滤、不去重；不想用了就删掉。
 */
export function addNote(botId, { text, source = 'manual', who = '' }) {
  const t = String(text ?? '').trim().slice(0, 4000);
  if (!t) throw new Error('语料是空的');
  const id = Number(db.run(
    'insert into learn_notes (bot_id, text, source, who, created_at) values (?,?,?,?,?)',
    botId, t, String(source), String(who ?? '').slice(0, 80), Date.now()).lastInsertRowid);
  log.info('learning', 'note added', { botId, id, source, chars: t.length });
  return id;
}

export function listNotes(botId, limit = 200) {
  return db.all('select id, text, source, who, created_at from learn_notes where bot_id = ? order by created_at desc limit ?',
    botId, limit).map((r) => ({ id: r.id, text: r.text, source: r.source, who: r.who, createdAt: r.created_at }));
}

export function deleteNote(botId, id) {
  db.run('delete from learn_notes where bot_id = ? and id = ?', botId, Number(id));
  log.info('learning', 'note deleted', { botId, id: Number(id) });
  return { ok: true };
}

export function collectNotes(botId) {
  return db.all('select text, source, who from learn_notes where bot_id = ? order by created_at asc limit 300', botId)
    .map((r) => ({ text: String(r.text).trim(), source: r.source, who: String(r.who ?? '') }))
    .filter((n) => n.text);
}

/**
 * 是否具备学习条件。
 * A 关掉、且 B 一条标记都没有 => 没有素材，学不了。界面据此提示。
 * full=true 时按「全量历史」判断，而不是只看增量。
 */
export function readiness(botId, settings, { full = false } = {}) {
  const stats = sourceStats(botId, { full });
  const aOn = settings?.learning?.sourceA !== false;
  const bOn = settings?.learning?.sourceB !== false;
  const bTotal = (bOn ? stats.b.good : 0) + (bOn ? stats.b.bad : 0);
  const aTotal = aOn ? stats.a.count : 0;
  const nTotal = stats.notes?.count ?? 0;   // 手动语料是特意加的，永远算数

  if (aTotal + bTotal + nTotal === 0) {
    const reasons = [];
    if (!aOn) reasons.push('素材 A 已关闭');
    else if (stats.a.count === 0) reasons.push(full ? '没有可用的素材 A' : '没有新的素材 A');
    if (!bOn) reasons.push('素材 B 已关闭');
    else if (stats.b.good + stats.b.bad === 0) reasons.push('没有手动标记的例子');
    reasons.push('也没有手动补充的语料');
    return { ok: false, reason: reasons.join('，') || '没有素材', stats };
  }
  return { ok: true, reason: '', stats };
}

// ---------- 提炼 ----------

/** 固定的 system 前缀（跨调用不变，利于缓存） */
export const LEARN_SYSTEM = `你是一位人物语言风格建模师，任务是对现有的「风格卡」做**增量更新**。

用户会给你四部分内容：当前的风格卡、机器人自己说过并被认可的话、被明确标记为"不该这样"的话、
以及被钉为固定例句的句子。请找出**现有风格卡里还没有、但素材里反复体现**的特征，提出增补建议。

必须遵守：
- 只找「新的、缺的」。现有风格卡里已经写过的特征不要再提一遍，也不要换个说法重提。
- **不要强化已有的口头禅**——素材里某个已有词出现得多，不代表要把它写得更重；那会让风格越来越窄。
- 正面素材用来发现新特征；负面素材用来提出「应该避免什么」。
- 【你手动补充的语料】是用户特意挑出来的参考，可能来自别人。只从里面学**句式和套路**
  （怎么起头、怎么转折、怎么收尾、什么话配什么反应），不要把别人的口头禅当成这个人的搬进去。
- 每条建议都要具体到可以直接照着做，不要写"更自然一些"这类空话。
- 素材里确实没有新东西时，返回空数组即可。**这是正常结果，不要为了交差硬凑。**

只输出一个 JSON 对象，不要任何解释文字，不要代码块标记：
{
  "observations": "一段话说明这次从素材里看到了什么，50-120 字",
  "suggestions": [
    {
      "id": 1,
      "section": "高频口头禅",
      "text": "要新增的条目原文（不带序号、不带项目符号）",
      "reason": "为什么建议加这一条",
      "evidence": ["素材里的原文片段"]
    }
  ]
}

section 只能取这几个值：高频口头禅 / 句子结构 / 互动与称呼 / 推进与衔接 / 不会有的说法 / 固定例句`;

function buildMaterial({ card, a, b, examples, notes }) {
  const L = [];
  L.push('【当前风格卡】');
  L.push(card?.body?.trim() || '（空）');
  if (examples?.length) {
    L.push('', '【当前固定例句】', ...examples.map((e) => '· ' + e));
  }
  L.push('', `【正面素材：机器人说过、被认可的话，共 ${a.items.length} 条】`);
  a.items.forEach((t, i) => L.push(`${i + 1}. ${t}`));
  if (b.good.length) {
    L.push('', `【被手动标记为「说得好」的话，共 ${b.good.length} 条】`);
    b.good.forEach((t, i) => L.push(`${i + 1}. ${t}`));
  }
  if (b.bad.length) {
    L.push('', `【被手动标记为「不该这样」的话，共 ${b.bad.length} 条】`);
    b.bad.forEach((t, i) => L.push(`${i + 1}. ${t}`));
  }
  if (notes?.length) {
    L.push('', `【你手动补充的语料，共 ${notes.length} 条（可能来自别人，只学句式和套路）】`);
    notes.forEach((n, i) => L.push(`${i + 1}. ${n.who ? `[${n.who}] ` : ''}${n.text}`));
  }
  return L.join('\n');
}

function extractJson(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/^```(?:json)?|```$/gm, '').trim();
  const s = cleaned.indexOf('{');
  const e = cleaned.lastIndexOf('}');
  if (s === -1 || e <= s) return null;
  try { return JSON.parse(cleaned.slice(s, e + 1)); } catch { return null; }
}

/**
 * 跑一次学习，产出待审核的建议并落库。
 * 不直接改风格卡 —— 改卡在 applyRun 里做，且一定会先存快照。
 */
export async function runLearning({ botId, settings, apiKey, chatFn = llm.chat, baseUrl, model, full = false }) {
  const ready = readiness(botId, settings, { full });
  if (!ready.ok) return { ok: false, error: ready.reason };

  const card = persona.activePersona(botId);
  const examples = persona.parseExamples(card);
  // 默认只学上次采纳之后产生的新素材；full=true 时把全部历史都过一遍
  const a = collectSourceA(botId, full ? { sinceTs: 0 } : {});
  const b = collectSourceB(botId);
  const notes = collectNotes(botId);
  const material = buildMaterial({ card, a, b, examples, notes });

  log.info('learning', 'run start', { botId, aCount: a.items.length, good: b.good.length, bad: b.bad.length, notes: notes.length, chars: material.length });

  const call = (maxTokens) => chatFn({
    botId, apiKey, baseUrl, model,
    scene: 'learn',
    system: LEARN_SYSTEM,
    history: [],
    tail: material,
    effort: llm.pickEffort(settings?.api?.effortMode ?? 'auto', 'learn'),
    maxTokens,
    temperature: 0.3,
  });

  let cap = LEARN_MAX_TOKENS;
  let r = await call(cap);
  if (!r.ok) return { ok: false, error: r.error };

  // 思考把预算吃光时正文会被截断，表现为「模型输出被截断」。翻倍再试一次，
  // 否则用户看到的就是「点了没反应/总是失败」。
  if (r.finishReason === 'length') {
    log.warn('learning', '思考吃光了输出预算，扩大后重试', {
      botId, first: LEARN_MAX_TOKENS, reasoning: r.usage?.reasoning ?? 0,
      completion: r.usage?.completion ?? 0,
    });
    cap = LEARN_RETRY_MAX_TOKENS;
    r = await call(cap);
    if (!r.ok) return { ok: false, error: r.error };
  }

  const spent = `（思考 ${r.usage?.reasoning ?? 0} / 上限 ${cap}）`;
  const empty = !r.text || !r.text.trim();
  if (empty || r.finishReason === 'length') {
    return {
      ok: false,
      error: (empty ? '模型没有输出（思考占满了预算）' : '模型输出被截断：上限翻倍还是不够，素材太多可先取消一些标记') + spent,
    };
  }

  const json = extractJson(r.text);
  if (!json) return { ok: false, error: '模型返回的不是合法 JSON' };

  // 规整建议：只保留合法小节、补 id、去掉空条目
  const raw = Array.isArray(json.suggestions) ? json.suggestions : [];
  const suggestions = [];
  let nextId = 1;
  for (const s of raw) {
    const section = String(s?.section ?? '').trim();
    const text = String(s?.text ?? '').trim();
    if (!text) continue;
    if (!persona.CARD_SECTIONS.includes(section)) continue;
    suggestions.push({
      id: nextId++,
      section,
      text: text.replace(/^[·•\-]\s*/, ''),
      reason: String(s?.reason ?? '').trim(),
      evidence: Array.isArray(s?.evidence) ? s.evidence.slice(0, 3).map(String) : [],
    });
  }

  // 低风险自动采纳：只收「固定例句」这类新增，改要点一律要人过
  const autoApply = !!settings?.learning?.autoApply;
  const autoIds = autoApply ? suggestions.filter((s) => s.section === '固定例句').map((s) => s.id) : [];

  const payload = {
    observations: String(json.observations ?? '').trim(),
    suggestions,
    autoIds,
    usage: r.usage,
  };

  const runId = Number(db.run(`insert into learn_runs
    (bot_id, status, source_a, source_b_good, source_b_bad, payload, accepted, created_at)
    values (?,?,?,?,?,?,?,?)`,
    botId, 'pending', a.items.length, b.good.length, b.bad.length,
    JSON.stringify(payload), '[]', Date.now()).lastInsertRowid);

  log.info('learning', 'run done', { botId, runId, suggestions: suggestions.length, autoIds: autoIds.length });
  return {
    ok: true,
    runId,
    sourceA: a.items.length,
    sourceBGood: b.good.length,
    sourceBBad: b.bad.length,
    ...payload,
    aChars: material.length,
  };
}

// ---------- 审核与应用 ----------

export function listRuns(botId, limit = 20) {
  return db.all('select * from learn_runs where bot_id = ? order by created_at desc limit ?', botId, limit)
    .map((r) => ({
      id: r.id, status: r.status, createdAt: r.created_at, appliedAt: r.applied_at,
      sourceA: r.source_a, sourceBGood: r.source_b_good, sourceBBad: r.source_b_bad,
      suggestions: (JSON.parse(r.payload || '{}').suggestions ?? []).length,
      accepted: JSON.parse(r.accepted || '[]').length,
      observations: JSON.parse(r.payload || '{}').observations ?? '',
      payload: JSON.parse(r.payload || '{}'),
    }));
}

export function getRun(id) {
  const r = db.one('select * from learn_runs where id = ?', id);
  if (!r) return null;
  return { ...r, payload: JSON.parse(r.payload || '{}'), accepted: JSON.parse(r.accepted || '[]') };
}

/**
 * 采纳建议：先存快照，再把选中的条目写进风格卡对应小节。
 * acceptedIds 为空则视为全部不采纳（仅关闭这次记录）。
 */
export function applyRun(botId, runId, acceptedIds = []) {
  const run = getRun(runId);
  if (!run || run.bot_id !== botId) throw new Error('学习记录不存在');
  if (run.status !== 'pending') throw new Error('这条记录已经处理过了');

  const all = run.payload.suggestions ?? [];
  const ids = new Set((acceptedIds ?? []).map(Number));
  const chosen = all.filter((s) => ids.has(s.id));

  const card = persona.activePersona(botId);
  let body = card?.body ?? '';
  let examples = persona.parseExamples(card);

  if (chosen.length > 0) {
    // 改卡之前先留一份自动快照：这一步保证任何采纳都可回退
    persona.snapshot(botId, `学习前自动备份（${chosen.length} 条建议）`, 'auto');

    const bySection = {};
    for (const s of chosen) {
      if (s.section === '固定例句') examples.push(s.text);
      else (bySection[s.section] ??= []).push(s.text);
    }
    body = persona.appendMany(body, bySection);
    persona.upsertPersona(botId, { body, examples });
  }

  db.run('update learn_runs set status = ?, accepted = ?, applied_at = ?, snapshot_id = ? where id = ?',
    'applied', JSON.stringify([...ids]), Date.now(),
    chosen.length ? persona.listSnapshots(botId)[0]?.id ?? null : null, runId);

  log.info('learning', 'applied', { botId, runId, total: all.length, chosen: chosen.length });
  return { ok: true, chosen: chosen.length, total: all.length };
}

export function discardRun(botId, runId) {
  const run = getRun(runId);
  if (!run || run.bot_id !== botId) throw new Error('学习记录不存在');
  db.run("update learn_runs set status = 'discarded' where id = ?", runId);
  return { ok: true };
}
