// QQ → 显示名
//
// 为什么需要这个模块：NapCat 收消息时**不发** at 段的 name 字段。
// 它自己的源码里写着（.tools/napcat/napcat.mjs）：
//     return { type: ze.at, data: { qq: n // name: content.slice(1); } };
// name 被注释掉了，所以 message.js 只能拿到一个 QQ 号。拿 QQ 号当文本喂给模型，
// 模型会把那串数字当成消息内容，甚至照抄回来说「@123456789」。
//
// 名字按可信度从三个地方取：
//   1. 群成员花名册（get_group_member_list）—— 覆盖整群，含从没说过话的人
//   2. 库里这个人以前发言留下的 sender_name（群名片优先）—— 跨会话，能兜住常说话的人
//   3. 机器人自己 —— 由调用方把昵称传进来
// 全都没有就返回 null，交由调用方决定兜底，绝不返回 QQ 号。
import * as log from './logger.js';
import * as db from './db.js';

const ROSTER_TTL_MS = 30 * 60 * 1000;   // 花名册半小时过期
const RETRY_MS = 5 * 60 * 1000;         // 取失败后 5 分钟再试

/** 供测试与诊断使用的窗口（毫秒） */
export const ROSTER_TTL = ROSTER_TTL_MS;
export const ROSTER_RETRY = RETRY_MS;

/**
 * 花名册缓存：`${botId}:${groupId}` -> { at, names }
 * names 是 Map<qq, 显示名>。取过就缓存，失败也记时间，避免每条消息都重试。
 */
const rosters = new Map();

const keyOf = (botId, groupId) => `${botId}:${groupId}`;

/** 该不该取花名册（没取过或已过期） */
export function rosterStale(botId, groupId, ttlMs = ROSTER_TTL_MS) {
  const r = rosters.get(keyOf(botId, groupId));
  return !r || Date.now() - r.at > ttlMs;
}

/**
 * 先占位再取：避免同一时刻进来好几条消息、连着打几个 get_group_member_list。
 * 取失败时把时间戳往回拨，这样 RETRY_MS 后就允许重试，而不是干等半小时。
 */
export function markRosterPending(botId, groupId) {
  rosters.set(keyOf(botId, groupId), { at: Date.now(), names: new Map() });
}

export function markRosterFailed(botId, groupId) {
  const r = rosters.get(keyOf(botId, groupId));
  if (r) r.at = Date.now() - ROSTER_TTL_MS + RETRY_MS;
}

/** 存一份群成员花名册，返回可用名字条数 */
export function rememberRoster(botId, groupId, list) {
  const names = new Map();
  for (const m of list ?? []) {
    const qq = String(m?.user_id ?? '');
    if (!qq) continue;
    // 群里看到的是群名片，其次是昵称
    const name = String(m?.card || m?.nickname || '').trim();
    if (name) names.set(qq, name);
  }
  rosters.set(keyOf(botId, groupId), { at: Date.now(), names });
  // 空结果多半是「这个群查不到」或权限不够，不是真的没人。按失败处理，
  // 免得干等半小时；否则这一个群永远解析不出名字。
  if (names.size === 0) {
    markRosterFailed(botId, groupId);
    log.debug('names', '花名册是空的，按失败处理', { botId, groupId });
    return 0;
  }
  log.debug('names', '花名册已缓存', { botId, groupId, count: names.size });
  return names.size;
}

/** 花名册现状（诊断 + 测试用） */
export function rosterInfo(botId, groupId) {
  const r = rosters.get(keyOf(botId, groupId));
  if (!r) return null;
  return { at: r.at, count: r.names.size, ageMs: Date.now() - r.at };
}

/** 库里这个人以前发言留下的名字；跨会话取最近一次 */
export function nameFromHistory(botId, qq) {
  const r = db.one(
    `select sender_name from messages
      where bot_id = ? and sender_qq = ? and sender_name <> ''
      order by ts desc limit 1`,
    botId, String(qq ?? ''));
  return r?.sender_name ? String(r.sender_name).trim() : null;
}

/**
 * 同步解析一个 QQ 的显示名；解析不到返回 null。
 *
 * selfNames 是机器人自己的名字（登录昵称 + 别名）。自己 @ 自己时，
 * 群里显示的是群名片，所以花名册优先于昵称。
 */
export function resolveName(botId, qq, { groupId = null, selfId = null, selfNames = [] } = {}) {
  const q = String(qq ?? '');
  if (!q) return null;

  const roster = groupId ? rosters.get(keyOf(botId, groupId))?.names : null;

  if (selfId && q === String(selfId)) {
    return roster?.get(q) || selfNames.find((n) => n && String(n).trim()) || null;
  }

  if (roster?.get(q)) return roster.get(q);
  return nameFromHistory(botId, q);
}

/** 清缓存：测试用，也方便手动换群后立刻重取 */
export function clearRosters(botId) {
  if (botId === undefined) { rosters.clear(); return; }
  for (const k of [...rosters.keys()]) {
    if (k.startsWith(String(botId) + ':')) rosters.delete(k);
  }
}
