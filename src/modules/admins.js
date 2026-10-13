// 管理员：按「人」判定，绑定的小号自动继承权限
import * as db from '../db.js';

export function listAdmins(botId) {
  return db.all('select qq from admins where bot_id = ? order by added_at', botId).map((r) => String(r.qq));
}

export function addAdmin(botId, qq) {
  db.run('insert or replace into admins (bot_id, qq, added_at) values (?,?,?)', botId, String(qq), Date.now());
}

export function removeAdmin(botId, qq) {
  db.run('delete from admins where bot_id = ? and qq = ?', botId, String(qq));
}

export function adminCount(botId) {
  return Number(db.one('select count(*) as c from admins where bot_id = ?', botId)?.c ?? 0);
}

/**
 * 是否管理员。先把这个 QQ 归一到 person，再看该 person 名下任一 QQ 是否在名单里。
 * 名单为空时一律不是管理员（安全默认）。
 */
export function isAdmin(botId, qq) {
  const q = String(qq ?? '');
  if (!q) return false;
  const direct = db.one('select 1 as x from admins where bot_id = ? and qq = ?', botId, q);
  if (direct) return true;

  // 通过 person 关联，覆盖大小号绑定
  const link = db.one('select person_id from person_qqs where bot_id = ? and qq = ?', botId, q);
  if (!link) return false;
  const siblings = db.all('select qq from person_qqs where bot_id = ? and person_id = ?', botId, link.person_id);
  for (const s of siblings) {
    const hit = db.one('select 1 as x from admins where bot_id = ? and qq = ?', botId, String(s.qq));
    if (hit) return true;
  }
  return false;
}
