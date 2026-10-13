// 名单：接受 / 回复 两个维度，各自可切白名单或黑名单；用户与群各有一套
//
// 安全默认：模式为白名单且名单为空 => 不响应任何人。
// 也就是说全新部署的机器人默认谁也不理，必须先在界面上把人/群加进来。
import * as db from '../db.js';

export const SCOPES = ['user', 'group'];
export const DIRECTIONS = ['accept', 'reply'];
export const MODES = ['whitelist', 'blacklist'];

/** 读某维度的模式，默认白名单 */
export function getMode(botId, scope, direction) {
  const row = db.one(
    'select mode from list_entries where bot_id = ? and scope = ? and direction = ? limit 1',
    botId, scope, direction);
  return row?.mode === 'blacklist' ? 'blacklist' : 'whitelist';
}

/** 读某维度的名单集合 */
export function getTargets(botId, scope, direction) {
  const rows = db.all(
    'select target from list_entries where bot_id = ? and scope = ? and direction = ?',
    botId, scope, direction);
  return new Set(rows.map((r) => String(r.target)));
}

/** 单个维度上，某个目标是否放行 */
export function decide(botId, scope, direction, target) {
  const mode = getMode(botId, scope, direction);
  const list = getTargets(botId, scope, direction);
  const inList = list.has(String(target));
  const ok = mode === 'whitelist' ? inList : !inList;
  return { ok, mode, inList, size: list.size };
}

/** 设置某个维度的模式（会清掉旧模式的条目，避免语义打架） */
export function setMode(botId, scope, direction, mode) {
  if (!MODES.includes(mode)) throw new Error('非法模式');
  const cur = getMode(botId, scope, direction);
  if (cur === mode) return;
  db.run('delete from list_entries where bot_id = ? and scope = ? and direction = ?',
    botId, scope, direction);
  db.run('insert into list_entries (bot_id, scope, direction, mode, target, created_at) values (?,?,?,?,?,?)',
    botId, scope, direction, mode, '__mode__', Date.now());
  // 上面这条只是为了记住模式；查询时靠 limit 1 取 mode
}

/** 加一个目标 */
export function addTarget(botId, scope, direction, target) {
  const mode = getMode(botId, scope, direction);
  db.run(`insert or replace into list_entries (bot_id, scope, direction, mode, target, created_at)
          values (?,?,?,?,?,?)`, botId, scope, direction, mode, String(target), Date.now());
}

/** 移除一个目标 */
export function removeTarget(botId, scope, direction, target) {
  db.run('delete from list_entries where bot_id = ? and scope = ? and direction = ? and target = ?',
    botId, scope, direction, String(target));
}

export function listAll(botId) {
  return db.all('select * from list_entries where bot_id = ? order by scope, direction, target', botId);
}

/**
 * 该维度的名单是否被显式配置过。
 * 「白名单 + 空名单」视为未配置 —— 否则每加一个人都要在两个维度各加一次，
 * 而且「加进白名单了它还是不理我」会非常难排查。
 */
export function isConfigured(botId, scope, direction) {
  const mode = getMode(botId, scope, direction);
  if (mode === 'blacklist') return true;             // 切过模式就算配置过
  const rows = db.all(
    'select target from list_entries where bot_id = ? and scope = ? and direction = ?',
    botId, scope, direction);
  return rows.some((r) => r.target !== '__mode__');
}

/**
 * 综合判断一条消息该怎么处理。
 * 群消息要同时过「用户」和「群」两套名单；私聊只看用户。
 * 回复维度未显式配置时跟随接受维度。
 * 返回 { accept, reply, reason }。
 */
export function canInteract(botId, { kind, senderQq, groupId }) {
  const userAccept = decide(botId, 'user', 'accept', senderQq);
  if (!userAccept.ok) {
    return { accept: false, reply: false, reason: `用户接受名单(${userAccept.mode})未放行` };
  }

  if (kind === 'group' && groupId) {
    const groupAccept = decide(botId, 'group', 'accept', groupId);
    if (!groupAccept.ok) {
      return { accept: false, reply: false, reason: `群接受名单(${groupAccept.mode})未放行` };
    }
  }

  // 回复维度：用户
  if (isConfigured(botId, 'user', 'reply')) {
    const userReply = decide(botId, 'user', 'reply', senderQq);
    if (!userReply.ok) {
      return { accept: true, reply: false, reason: `用户回复名单(${userReply.mode})未放行` };
    }
  }

  // 回复维度：群
  if (kind === 'group' && groupId && isConfigured(botId, 'group', 'reply')) {
    const groupReply = decide(botId, 'group', 'reply', groupId);
    if (!groupReply.ok) {
      return { accept: true, reply: false, reason: `群回复名单(${groupReply.mode})未放行` };
    }
  }

  return { accept: true, reply: true, reason: 'ok' };
}

/** 名单是否处于「尚未配置」状态（界面提示用） */
export function isUnconfigured(botId) {
  const rows = listAll(botId);
  const real = rows.filter((r) => r.target !== '__mode__');
  return real.length === 0;
}
