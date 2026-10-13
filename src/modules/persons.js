// 人的管理：大号小号绑定与解绑
//
// 一个「人」可以有多个 QQ 号。绑定后他们共用一份记忆、印象、名单与权限。
import * as db from '../db.js';
import * as log from '../logger.js';
import * as impression from './impression.js';

/** 列出某机器人认识的所有人，附带各自的 QQ 号 */
export function listPersons(botId) {
  const rows = db.all('select id from persons where bot_id = ? order by id', botId);
  return rows.map((r) => ({ personId: r.id, qqs: db.getPersonQqs(botId, r.id) }));
}

/** 一个 QQ 号属于哪个人（没有就返回 null，不自动创建） */
export function personOf(botId, qq) {
  const link = db.one('select person_id from person_qqs where bot_id = ? and qq = ?', botId, String(qq));
  return link ? link.person_id : null;
}

/**
 * 把两个 QQ 号绑成同一个人。
 * 已经同属一人则什么都不做（可重复调用）。
 */
export function bind(botId, qqA, qqB) {
  const a = String(qqA).trim();
  const b = String(qqB).trim();
  if (!a || !b) return { ok: false, error: '两个号都要填' };
  if (a === b) return { ok: false, error: '两个号不能相同' };

  const pa = db.ensurePersonByQq(botId, a);
  const pb = db.ensurePersonByQq(botId, b);
  if (pa === pb) return { ok: true, personId: pa, merged: false };

  // 以先创建的那个为主，把另一个人的号、消息、印象都并过去
  const keep = Math.min(pa, pb);
  const drop = Math.max(pa, pb);

  db.tx(() => {
    db.run('update person_qqs set person_id = ?, is_primary = 0 where bot_id = ? and person_id = ?',
      keep, botId, drop);
    db.run('update person_qqs set is_primary = 1 where bot_id = ? and qq = ?', botId, String(db.one(
      'select qq from person_qqs where bot_id = ? and person_id = ? order by created_at limit 1', botId, keep).qq));
    db.run('update messages set person_id = ? where bot_id = ? and person_id = ?', keep, botId, drop);

    // 印象合并：两边的文字接起来，去重后截断
    const ia = impression.get(botId, keep);
    const ib = impression.get(botId, drop);
    if (ib) {
      const join = (x, y) => {
        const parts = [x, y].map((s) => String(s ?? '').trim()).filter(Boolean);
        return [...new Set(parts)].join('；').slice(0, 300);
      };
      impression.upsertAuto(botId, keep, {
        facts: join(ia?.facts, ib.facts),
        feelings: join(ia?.feelings, ib.feelings),
      }, 300);
      db.run('delete from impressions where bot_id = ? and person_id = ?', botId, drop);
    }
    db.run('delete from persons where id = ?', drop);
  });

  log.info('persons', 'bound', { botId, qqA: a, qqB: b, personId: keep });
  return { ok: true, personId: keep, merged: true };
}

/**
 * 把一个 QQ 号从「人」里解绑出来，单独成为新的人。
 *
 * 注意历史归谁：绑定期间双方的发言已经并到同一个人名下，无法再拆分。
 * 所以解绑出来的号**按新用户算，不带任何历史记录**——这也是确认书里定的规则。
 */
export function unbind(botId, qq) {
  const q = String(qq).trim();
  const link = db.one('select * from person_qqs where bot_id = ? and qq = ?', botId, q);
  if (!link) return { ok: false, error: '这个号还没有记录' };

  const siblings = Number(db.one(
    'select count(*) as c from person_qqs where bot_id = ? and person_id = ?', botId, link.person_id)?.c ?? 0);
  if (siblings <= 1) return { ok: false, error: '这个号是独立的，没有绑定关系可解' };

  const np = Number(db.run('insert into persons (bot_id, note, created_at) values (?,?,?)',
    botId, '', Date.now()).lastInsertRowid);
  db.run('update person_qqs set person_id = ?, is_primary = 1 where bot_id = ? and qq = ?', np, botId, q);

  log.info('persons', 'unbound', { botId, qq: q, newPersonId: np, fromPersonId: link.person_id });
  return { ok: true, personId: np };
}

/** 概览：每个人带多少个号、说过多少话 */
export function overview(botId) {
  return db.all(`
    select p.id as person_id,
           (select count(*) from person_qqs q where q.bot_id = p.bot_id and q.person_id = p.id) as qq_count,
           (select count(*) from messages m where m.bot_id = p.bot_id and m.person_id = p.id and m.role = 'user') as msg_count
    from persons p where p.bot_id = ? order by p.id`, botId);
}
