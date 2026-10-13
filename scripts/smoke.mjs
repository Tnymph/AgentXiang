// 冒烟测试：验证基础层能跑
import { ensureDirs } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as db from '../src/db.js';

ensureDirs();
db.openDb();

const botId = db.createBot('主机器人', '10001');
log.info('smoke', 'bot created', { botId });

const s1 = db.ensureSession(botId, 'group', '555001');
const s2 = db.ensureSession(botId, 'private', '20001');
log.info('smoke', 'sessions', { group: s1.id, private: s2.id });

const pid = db.ensurePersonByQq(botId, '20001');
log.info('smoke', 'person', { pid, qqs: db.getPersonQqs(botId, pid) });

// 同一个人再来一次应该复用
const pid2 = db.ensurePersonByQq(botId, '20001');
log.info('smoke', 'person reuse', { same: pid === pid2 });

// 消息写入 + 记忆窗口查询
db.run('insert into messages (bot_id, session_id, msg_id, role, person_id, sender_qq, sender_name, text, flags, ts) values (?,?,?,?,?,?,?,?,?,?)',
  botId, s2.id, 'm1', 'user', pid, '20001', '测试者', '你好', '', Date.now());
db.run('insert into messages (bot_id, session_id, msg_id, role, person_id, sender_qq, sender_name, text, flags, ts) values (?,?,?,?,?,?,?,?,?,?)',
  botId, s2.id, 'm2', 'bot', null, '10001', '机器人', '你好呀', '', Date.now());
const recent = db.all('select role, text from messages where bot_id = ? and session_id = ? order by ts asc limit 20', botId, s2.id);
log.info('smoke', 'memory window', recent);

log.info('smoke', 'self qq set', [...db.selfQqSet()]);

// 事务回滚验证
try {
  db.tx(() => {
    db.run('insert into persons (bot_id, note, created_at) values (?,?,?)', botId, 'will-rollback', Date.now());
    throw new Error('故意失败');
  });
} catch { /* 预期 */ }
const cnt = db.one('select count(*) as c from persons where note = ?', 'will-rollback');
log.info('smoke', 'rollback works', { leftover: cnt.c });

log.info('smoke', 'DONE');
db.closeDb();
log.closeLogs();
