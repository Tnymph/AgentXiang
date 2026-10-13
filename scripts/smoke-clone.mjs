// 冒烟测试：从另一个机器人复制配置
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, DATA_DIR } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as db from '../src/db.js';
import * as clone from '../src/modules/clone.js';
import * as lists from '../src/modules/lists.js';
import * as fb from '../src/modules/fallback.js';
import * as sch from '../src/modules/schedule.js';
import * as admins from '../src/modules/admins.js';
import { botSettings, saveBotSettings } from '../src/config.js';

ensureDirs();
const TEST_DB = path.join(DATA_DIR, 'test7.sqlite');
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.unlinkSync(f); } catch { /* 忽略 */ }
}
db.openDb(TEST_DB);

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', label, extra ? '→ ' + extra : ''); }
};

const A = db.createBot('源机器人', '10001');
const B = db.createBot('目标机器人', '20002');

// 给源机器人配一套东西
sch.ensureSlots(A, 3);
db.run("update schedules set name = '白天', ranges = ? where bot_id = ? and slot_no = 1",
  JSON.stringify([{ start: 480, end: 1080 }]), A);
db.run("update schedules set name = '夜', ranges = ? where bot_id = ? and slot_no = 2",
  JSON.stringify([{ start: 1410, end: 190 }]), A);
saveBotSettings(A, { schedule: { activeSlot: 2 } });

lists.addTarget(A, 'user', 'accept', '30001');
lists.addTarget(A, 'group', 'accept', '555001');
lists.setMode(A, 'user', 'reply', 'blacklist');
lists.addTarget(A, 'user', 'reply', '30002');

fb.seedDefaults(A);
const fbItem = fb.listFor(A, 'video')[0];
fb.updateReply(fbItem.id, { isFixed: true });

admins.addAdmin(A, '30001');

saveBotSettings(A, {
  speak: { defaultGroupMode: 'active', maxSentences: 2, aliases: ['小向'] },
  rate: { repeat: { windowSec: 30, max: 2 } },
  repeatEcho: { enabled: false },
  api: { mode: 'force_on', effortMode: 'low' },
});

// ============ 复制时段 ============
console.log('--- 复制时段 ---');
const r1 = clone.copyConfig(A, B, ['schedule']);
check('复制成功', r1.ok === true && r1.copied.includes('schedule'), JSON.stringify(r1));
const bSlots = sch.listSlots(B);
check('目标有了三个方案', bSlots.length === 3, String(bSlots.length));
check('方案名复制过来', bSlots[0].name === '白天', bSlots[0]?.name);
check('跨零点区间也复制了', JSON.stringify(sch.parseRanges(bSlots[1].ranges)) === JSON.stringify([{ start: 1410, end: 190 }]),
  bSlots[1]?.ranges);
check('生效方案编号复制了', botSettings(B).schedule.activeSlot === 2, String(botSettings(B).schedule.activeSlot));

// ============ 复制名单 ============
console.log('--- 复制名单 ---');
clone.copyConfig(A, B, ['lists']);
const lb = await (async () => {
  const out = {};
  for (const scope of ['user', 'group']) {
    out[scope] = {};
    for (const dir of ['accept', 'reply']) {
      out[scope][dir] = { mode: lists.getMode(B, scope, dir), targets: [...lists.getTargets(B, scope, dir)] };
    }
  }
  return out;
})();
check('用户接收名单复制了', lb.user.accept.targets.includes('30001'), JSON.stringify(lb.user.accept));
check('群接收名单复制了', lb.group.accept.targets.includes('555001'));
check('名单模式复制了', lb.user.reply.mode === 'blacklist', lb.user.reply.mode);
check('黑名单内容复制了', lb.user.reply.targets.includes('30002'));

// ============ 复制默认回复 ============
console.log('--- 复制默认回复 ---');
clone.copyConfig(A, B, ['fallback']);
const bFb = fb.listFor(B, 'video');
check('默认回复条数一致', bFb.length === fb.listFor(A, 'video').length, `${bFb.length} vs ${fb.listFor(A, 'video').length}`);
check('固定条目标记复制了', bFb.some((x) => Number(x.is_fixed) === 1));
check('能取出兜底话术', typeof fb.pickReply(B, 'video') === 'string');

// ============ 复制发言/频控 ============
console.log('--- 复制发言与频控 ---');
clone.copyConfig(A, B, ['speaking']);
const sb = botSettings(B);
check('发言模式复制了', sb.speak.defaultGroupMode === 'active', sb.speak.defaultGroupMode);
check('句数上限复制了', sb.speak.maxSentences === 2, String(sb.speak.maxSentences));
check('别名复制了', JSON.stringify(sb.speak.aliases) === JSON.stringify(['小向']), JSON.stringify(sb.speak.aliases));
check('频控阈值复制了', sb.rate.repeat.max === 2, String(sb.rate.repeat?.max));
check('复读开关复制了', sb.repeatEcho.enabled === false);

// ============ 复制管理员 ============
console.log('--- 复制管理员 ---');
clone.copyConfig(A, B, ['admins']);
check('管理员复制了', admins.listAdmins(B).includes('30001'), JSON.stringify(admins.listAdmins(B)));
check('目标管理员能通过校验', admins.isAdmin(B, '30001'));

// ============ 复制 API 设置（不含密钥）============
console.log('--- 复制 API 设置 ---');
clone.copyConfig(A, B, ['api']);
const ab = botSettings(B);
check('接入模式复制了', ab.api.mode === 'force_on', ab.api.mode);
check('思考档位复制了', ab.api.effortMode === 'low');
check('密钥不在设置里（由密钥库单独管）', !JSON.stringify(ab).includes('apiKey'));

// ============ 不该被复制的东西 ============
console.log('--- 边界 ---');
// 风格卡不复制
db.run('insert into personas (bot_id, name, body, examples, params, is_active, updated_at) values (?,?,?,?,?,?,?)',
  A, '源人格', '只有源机器人才有的风格', '[]', '{}', 1, Date.now());
clone.copyConfig(A, B, ['schedule', 'lists']);
const bPersona = db.one('select * from personas where bot_id = ?', B);
check('风格卡不会被复制', !bPersona, JSON.stringify(bPersona));

// 记忆不复制
db.run(`insert into messages (bot_id, session_id, msg_id, role, person_id, sender_qq, sender_name, text, flags, ts)
        values (?,?,?,?,?,?,?,?,?,?)`,
  A, db.ensureSession(A, 'private', '30001').id, 'm1', 'user', null, '30001', '甲', '只属于源机器人的记忆', '', Date.now());
clone.copyConfig(A, B, ['speaking']);
check('记忆不会被复制', !db.one('select * from messages where bot_id = ?', B));

check('不能复制给自己', clone.copyConfig(A, A, ['schedule']).ok === false);
check('源不存在会报错', clone.copyConfig(999, B, ['schedule']).ok === false);
check('空选择会报错', clone.copyConfig(A, B, []).ok === false);
check('非法部分被忽略', clone.copyConfig(A, B, ['nonsense']).ok === false);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
db.closeDb();
log.closeLogs();
process.exit(fail === 0 ? 0 : 1);
