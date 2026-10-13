// 印象：机器人对某个「人」的长期认知，跨会话共享、不受记忆淘汰影响
//
// 注意：印象的内容属于「每次都变」的东西，**必须由调用方放进 tail**，
// 绝不能进 system prompt，否则会破坏所有会话的公共前缀缓存。
import * as db from '../db.js';
import { isMarkerOnly } from '../message.js';

export function get(botId, personId) {
  // 统一返回 null，别让调用方同时处理 undefined 和 null 两种情况
  return db.one('select * from impressions where bot_id = ? and person_id = ?', botId, personId) ?? null;
}

export function upsertAuto(botId, personId, { facts, feelings }, maxChars = 300) {
  const cur = get(botId, personId);
  const t = Date.now();
  const clip = (s) => String(s ?? '').slice(0, maxChars);
  if (cur) {
    db.run('update impressions set facts = ?, feelings = ?, updated_at = ? where id = ?',
      clip(facts ?? cur.facts), clip(feelings ?? cur.feelings), t, cur.id);
    return cur.id;
  }
  const r = db.run('insert into impressions (bot_id, person_id, facts, feelings, manual, updated_at) values (?,?,?,?,?,?)',
    botId, personId, clip(facts), clip(feelings), '', t);
  return Number(r.lastInsertRowid);
}

/** 手写内容优先级最高，不被自动提炼覆盖 */
export function setManual(botId, personId, text, maxChars = 300) {
  const cur = get(botId, personId);
  const t = Date.now();
  const v = String(text ?? '').slice(0, maxChars);
  if (cur) {
    db.run('update impressions set manual = ?, updated_at = ? where id = ?', v, t, cur.id);
    return cur.id;
  }
  const r = db.run('insert into impressions (bot_id, person_id, facts, feelings, manual, updated_at) values (?,?,?,?,?,?)',
    botId, personId, '', '', v, t);
  return Number(r.lastInsertRowid);
}

/**
 * 渲染成给模型看的一小段，供拼进 tail。
 * 没有任何印象时返回空串（不占 token、也更利于缓存）。
 */
export function formatForPrompt(botId, personId) {
  const row = get(botId, personId);
  if (!row) return '';
  const parts = [];
  if (row.manual?.trim()) parts.push(row.manual.trim());
  if (row.facts?.trim()) parts.push(`你记得：${row.facts.trim()}`);
  if (row.feelings?.trim()) parts.push(`你对他的印象：${row.feelings.trim()}`);
  if (parts.length === 0) return '';
  return parts.join('\n');
}

export function listByBot(botId) {
  return db.all(`select i.*, p.id as pid from impressions i
                 join persons p on p.id = i.person_id
                 where i.bot_id = ? order by i.updated_at desc`, botId);
}

export function remove(botId, personId) {
  db.run('delete from impressions where bot_id = ? and person_id = ?', botId, personId);
}

/** 列出「有新内容、值得提炼」的人 */
export function needingExtraction(botId, { minMessages = 3 } = {}) {
  return db.all(`
    select p.id as person_id,
           count(m.id) as msg_count,
           max(m.ts) as last_ts
    from persons p
    join messages m on m.person_id = p.id and m.bot_id = p.bot_id and m.role = 'user'
      and m.text not like '/%' and m.text not like '／%'
      and (m.flags is null or (m.flags not like '%command%' and m.flags not like '%carried%'))
    left join impressions i on i.person_id = p.id and i.bot_id = p.bot_id
    where p.bot_id = ?
    group by p.id
    having count(m.id) >= ?
       and (max(i.updated_at) is null or max(m.ts) > max(i.updated_at))
    order by last_ts desc`, botId, minMessages)
    .map((r) => r.person_id);
}

// ---------- 自动提炼 ----------

/** 供提炼用的固定 system 前缀（跨人复用，利于缓存） */
export const IMPRESSION_SYSTEM = `你在维护一份人物档案，供另一位扮演大学老师的人在聊天时参考。

用户会给你某个人的现有档案，以及这个人最近说过的话。请据此更新档案。

只写**素材里有依据**的内容：
- facts：关于他的客观信息——提到的专业、正在做的事、遇到的困难、问过什么
- feelings：他跟这位老师相处的状态、说话习惯、情绪倾向

规矩：
- 不要编造。素材里没有的就不要写。
- 新素材推翻了旧内容就改掉；印证了就保留。
- 已经写过的不要换个说法重写一遍。
- 每项最多 100 字，写不出一句就留空字符串。
- 用第三人称「他」称呼这个人。

只输出一个 JSON 对象，不要解释、不要代码块标记：
{ "facts": "...", "feelings": "..." }`;

/** 取某个人最近的发言，作为提炼素材 */
export function recentUtterances(botId, personId, { limit = 40, maxChars = 2000 } = {}) {
  // 排除三类消息：
  //  - 看起来就是命令的（以 / 开头）：不管当时有没有被识别成命令，都不是聊天内容
  //  - command 标记的：同上一类，防御性保留
  //  - carried 标记的：文字是从上一条借来的（先发图再单独 @ 一下），留着同一句会算两次
  //  - frombot 标记的：另一个机器人发来的。它不是「这个人说的话」，
  //    不然会给对方机器人凭空建一份人物档案
  const rows = db.all(`
    select text from messages
    where bot_id = ? and person_id = ? and role = 'user' and text <> ''
      and text not like '/%' and text not like '／%'
      and (flags is null or (flags not like '%command%' and flags not like '%carried%'
                             and flags not like '%frombot%'))
    order by ts desc limit ?`, botId, personId, limit);
  const out = [];
  let chars = 0;
  for (const r of rows) {
    const t = String(r.text).trim();
    if (!t) continue;
    // 「[图片]」「[语音]」这类占位不是他说的话。纯媒体消息在库里就是这个样子，
    // 拿它当素材只会提炼出「他常发图片」这种废话。
    if (isMarkerOnly(t)) continue;
    if (chars + t.length > maxChars) break;
    out.push(t);
    chars += t.length;
  }
  return out.reverse();   // 按时间正序
}

/**
 * 为一个人提炼/更新印象。
 * 返回 { ok, facts, feelings } 或 { ok:false, error }
 */
export async function extractFor(botId, personId, { settings, apiKey, chatFn, baseUrl, model, maxChars = 300 } = {}) {
  const utterances = recentUtterances(botId, personId);
  if (utterances.length < 2) return { ok: false, error: '素材太少，先多聊几句' };

  const cur = get(botId, personId);
  const material = [
    '【现有档案】',
    cur ? `facts: ${cur.facts || '(空)'}\nfeelings: ${cur.feelings || '(空)'}` : '(还没有档案)',
    '',
    `【他最近说过的话，共 ${utterances.length} 条】`,
    ...utterances.map((t) => '· ' + t),
  ].join('\n');

  const r = await chatFn({
    botId, apiKey, baseUrl, model,
    scene: 'impression',
    system: IMPRESSION_SYSTEM,
    history: [],
    tail: material,
    effort: 'high',
    maxTokens: 2048,
    temperature: 0.3,
  });
  if (!r.ok) return { ok: false, error: r.error };

  const raw = String(r.text ?? '').trim();
  if (!raw) return { ok: false, error: '模型没有输出（可能思考占满了预算）' };

  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s === -1 || e <= s) return { ok: false, error: '模型返回的不是 JSON' };
  let json;
  try { json = JSON.parse(raw.slice(s, e + 1)); } catch { return { ok: false, error: 'JSON 解析失败' }; }

  const facts = String(json.facts ?? '').trim().slice(0, maxChars);
  const feelings = String(json.feelings ?? '').trim().slice(0, maxChars);
  upsertAuto(botId, personId, { facts, feelings }, maxChars);
  return { ok: true, facts, feelings };
}
