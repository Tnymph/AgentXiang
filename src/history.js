// 历史与记忆
//
// 设计：只存一份历史，记忆窗口 = 从历史里按时间倒序取最近 N 轮。
// 不另存一份「记忆」表，避免两处不一致；淘汰就是查询时不取那么远。
import * as db from './db.js';
import * as log from './logger.js';

export function saveUserMessage({
  botId, sessionId, msgId, personId, senderQq, senderName, text, flags = '', media = null,
}) {
  const r = db.run(`insert into messages
    (bot_id, session_id, msg_id, role, person_id, sender_qq, sender_name, text, flags, media, ts)
    values (?,?,?,?,?,?,?,?,?,?,?)`,
    botId, sessionId, String(msgId ?? ''), 'user', personId ?? null, String(senderQq ?? ''),
    String(senderName ?? ''), String(text ?? ''), flags, serializeMedia(media), Date.now());
  return Number(r.lastInsertRowid);
}

/**
 * 消息里的媒体（目前只有图片）存成 JSON，供聊天记录显示。
 *
 * 为什么不塞进 text：text 会被 recentHistory 读去当模型的历史，
 * 图片地址混进去就变成噪音；而且 impression 会把它当成「他说的话」。
 */
export function serializeMedia(media) {
  const list = (Array.isArray(media) ? media : [])
    .map((m) => ({ kind: String(m?.kind ?? 'image'), url: String(m?.url ?? '').trim() }))
    .filter((m) => m.url);
  return list.length ? JSON.stringify(list) : '';
}

export function parseMedia(row) {
  const raw = typeof row === 'string' ? row : row?.media;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((m) => m && m.url) : [];
  } catch { return []; }
}

export function saveBotMessage({ botId, sessionId, msgId, text }) {
  const r = db.run(`insert into messages
    (bot_id, session_id, msg_id, role, person_id, sender_qq, sender_name, text, flags, ts)
    values (?,?,?,?,?,?,?,?,?,?)`,
    botId, sessionId, String(msgId ?? ''), 'bot', null, null, null, String(text ?? ''), '', Date.now());
  return Number(r.lastInsertRowid);
}

/**
 * 取最近 n 轮对话，转成模型要的消息格式（按时间正序）。
 * withSpeaker：群里要把说话人带上，否则模型分不清谁在说。
 */
export function recentHistory(botId, sessionId, rounds = 20, { withSpeaker = false } = {}) {
  // 一轮约等于「一条用户消息 + 一条机器人回复」，多取一些再裁剪
  const limit = Math.max(2, rounds * 2);
  const rows = db.all(
    `select role, text, sender_name from messages
     where bot_id = ? and session_id = ? and text <> ''
     order by ts desc, id desc limit ?`,
    botId, sessionId, limit);
  return rows.reverse().map((r) => {
    const isBot = r.role === 'bot';
    const who = String(r.sender_name ?? '').trim();
    const content = !isBot && withSpeaker && who ? `${who}：${r.text}` : r.text;
    return { role: isBot ? 'assistant' : 'user', content };
  });
}

export function lastBotMessage(botId, sessionId) {
  return db.one(
    "select * from messages where bot_id = ? and session_id = ? and role = 'bot' order by ts desc, id desc limit 1",
    botId, sessionId);
}

/**
 * 从最新一条往回数，连续有多少条是「机器人在说话」（中间没有真人插话）。
 *
 * 两个来源都算：自己发的（role='bot'）和另一个机器人发来的（flags 里有 frombot）。
 * AI 互聊模式靠它当刹车——连续几条都是机器人在自说自话就停，等人开口再恢复。
 */
export function botChainLength(botId, sessionId, limit = 30) {
  const rows = db.all(
    `select role, flags from messages
     where bot_id = ? and session_id = ? and text <> ''
     order by ts desc, id desc limit ?`, botId, sessionId, limit);
  let n = 0;
  for (const r of rows) {
    const fromBot = r.role === 'bot' || String(r.flags ?? '').includes('frombot');
    if (!fromBot) break;
    n++;
  }
  return n;
}

export function findMessage(botId, msgId) {
  return db.one('select * from messages where bot_id = ? and msg_id = ?', botId, String(msgId));
}

export function findByDbId(id) {
  return db.one('select * from messages where id = ?', id);
}

/** 标记某些标志位（如 command / image），逗号分隔 */
export function addFlag(messageDbId, flag) {
  const row = findByDbId(messageDbId);
  if (!row) return;
  const flags = new Set(String(row.flags || '').split(',').map((s) => s.trim()).filter(Boolean));
  flags.add(flag);
  db.run('update messages set flags = ? where id = ?', [...flags].join(','), messageDbId);
}

/** 按保留策略清理历史 */
export function pruneHistory(botId, settings) {
  const days = settings?.history?.retainDays ?? 30;
  const maxPerSession = settings?.history?.maxPerSession ?? 2000;
  const cutoff = Date.now() - days * 86400_000;

  const byAge = db.run('delete from messages where bot_id = ? and ts < ?', botId, cutoff);

  // 每会话超量部分也删掉最旧的
  const sessions = db.all('select id from sessions where bot_id = ?', botId);
  let byCount = 0;
  for (const s of sessions) {
    const n = Number(db.one('select count(*) as c from messages where bot_id = ? and session_id = ?', botId, s.id)?.c ?? 0);
    if (n <= maxPerSession) continue;
    const excess = n - maxPerSession;
    const victims = db.all(
      'select id from messages where bot_id = ? and session_id = ? order by ts asc, id asc limit ?',
      botId, s.id, excess);
    for (const v of victims) {
      db.run('delete from messages where id = ?', v.id);
      byCount++;
    }
  }
  if (Number(byAge.changes ?? 0) + byCount > 0) {
    log.info('history', 'pruned', { botId, byAge: byAge.changes, byCount });
  }
  return { byAge: Number(byAge.changes ?? 0), byCount };
}

export function historyStats(botId, sessionId) {
  const r = db.one('select count(*) as c, min(ts) as oldest, max(ts) as newest from messages where bot_id = ? and session_id = ?', botId, sessionId);
  return { count: Number(r?.c ?? 0), oldest: r?.oldest ?? null, newest: r?.newest ?? null };
}
