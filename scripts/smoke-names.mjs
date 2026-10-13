// 冒烟测试：QQ → 显示名的解析
//
// 背景：NapCat 收消息时 at 段不带 name，只有 QQ 号。这个模块负责把 QQ 号
// 换成人能看的名字。核心红线：**任何情况下都不能把 QQ 号当名字返回**。
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, DATA_DIR } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as db from '../src/db.js';
import * as names from '../src/names.js';
import * as history from '../src/history.js';

ensureDirs();
const TEST_DB = path.join(DATA_DIR, 'test1.sqlite');
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.unlinkSync(f); } catch { /* 忽略 */ }
}
db.openDb(TEST_DB);

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', label, extra ? '→ ' + extra : ''); }
};

// 测试机器人 id 一律 >= 999000（见 smoke-web 的教训：密钥存储是全局的）
const BOT = 999901;
const OTHER = 999902;
const GROUP = '555001';
const SELF = '10001';
const ZHANG = '10000001';
const QQ_B = '10000002';

names.clearRosters();

// ---------- 什么都没有时：返回 null，绝不返回 QQ 号 ----------
check('未知的人返回 null', names.resolveName(BOT, '12345') === null);
check('未知的人（带群号）也返回 null', names.resolveName(BOT, '12345', { groupId: GROUP }) === null);
check('空 QQ 返回 null', names.resolveName(BOT, '') === null);
check('undefined 返回 null', names.resolveName(BOT, undefined) === null);

// ---------- 历史名字：库里见过的人 ----------
const s1 = db.ensureSession(BOT, 'group', GROUP).id;
history.saveUserMessage({
  botId: BOT, sessionId: s1, msgId: 'm1', personId: null,
  senderQq: ZHANG, senderName: '张三', text: '你好',
});
check('历史里能查到名字', names.nameFromHistory(BOT, ZHANG) === '张三');
check('历史名字可直接解析', names.resolveName(BOT, ZHANG) === '张三');
check('别的机器人看不到', names.nameFromHistory(OTHER, ZHANG) === null);
check('没说过话的人仍为 null', names.nameFromHistory(BOT, QQ_B) === null);

// 同一个人换过名字：取最近一次
history.saveUserMessage({
  botId: BOT, sessionId: s1, msgId: 'm2', personId: null,
  senderQq: QQ_B, senderName: '旧名字', text: '1',
});
history.saveUserMessage({
  botId: BOT, sessionId: s1, msgId: 'm3', personId: null,
  senderQq: QQ_B, senderName: '跳蝻', text: '2',
});
check('改过名字取最近一次', names.nameFromHistory(BOT, QQ_B) === '跳蝻',
  String(names.nameFromHistory(BOT, QQ_B)));

// 跨会话也能查到（同一个人换个群说过话）
const s2 = db.ensureSession(BOT, 'group', '555999').id;
history.saveUserMessage({
  botId: BOT, sessionId: s2, msgId: 'm4', personId: null,
  senderQq: '3956828900', senderName: '跳小蝻', text: 'hi',
});
check('跨会话能查到名字', names.resolveName(BOT, '3956828900', { groupId: GROUP }) === '跳小蝻');

// 名字为空的记录不该被当成有效名字
history.saveUserMessage({
  botId: BOT, sessionId: s1, msgId: 'm5', personId: null,
  senderQq: '4000000001', senderName: '', text: '空白名字',
});
check('空白名字不算数', names.nameFromHistory(BOT, '4000000001') === null);

// ---------- 花名册 ----------
check('花名册一开始是过期的', names.rosterStale(BOT, GROUP) === true);
check('没取过时 rosterInfo 为 null', names.rosterInfo(BOT, GROUP) === null);

const added = names.rememberRoster(BOT, GROUP, [
  { user_id: Number(ZHANG), nickname: 'zsan', card: '张三' },       // 有群名片
  { user_id: Number(QQ_B), nickname: '跳蝻', card: '' },           // 没群名片 → 用昵称
  { user_id: '111111', nickname: '幽灵', card: '幽灵卡' },          // 从没说过话的人
  { user_id: '222222', nickname: '', card: '' },                   // 两边都空 → 跳过
  { user_id: '333333', nickname: '   ', card: '  ' },              // 全是空白 → 跳过
  null,                                                            // 脏数据不能崩
  { nickname: '没有QQ号' },
]);
check('花名册条数', added === 3, String(added));
check('花名册存进去了', names.rosterInfo(BOT, GROUP)?.count === 3);
check('花名册不算过期了', names.rosterStale(BOT, GROUP) === false);

check('群名片优先于昵称', names.resolveName(BOT, ZHANG, { groupId: GROUP }) === '张三');
check('没群名片就用昵称', names.resolveName(BOT, QQ_B, { groupId: GROUP }) === '跳蝻');
check('从没说过话的人也能解析', names.resolveName(BOT, '111111', { groupId: GROUP }) === '幽灵卡');
check('两边都空的人不返回空名字', names.resolveName(BOT, '222222', { groupId: GROUP }) === null);
check('脏数据不影响其他人', names.resolveName(BOT, ZHANG, { groupId: GROUP }) === '张三');

// 花名册优先于历史（群里看到的是群名片，比历史记录更贴近当下）
history.saveUserMessage({
  botId: BOT, sessionId: s1, msgId: 'm6', personId: null,
  senderQq: '111111', senderName: '历史里的名字', text: '3',
});
check('花名册优先于历史', names.resolveName(BOT, '111111', { groupId: GROUP }) === '幽灵卡');
check('不给群号时退回历史', names.resolveName(BOT, '111111') === '历史里的名字');

// 花名册是按群存的：换个群就不适用
check('换群后花名册不生效', names.resolveName(BOT, '111111', { groupId: '556000' }) === '历史里的名字');
check('别的机器人的花名册不串用', names.resolveName(OTHER, ZHANG, { groupId: GROUP }) === null);

// ---------- 机器人自己 ----------
check('自己：花名册里的群名片优先',
  names.resolveName(BOT, SELF, { groupId: GROUP, selfId: SELF, selfNames: ['小向'] }) === '小向');
names.rememberRoster(BOT, GROUP, [
  { user_id: Number(SELF), nickname: '小向', card: '客服小向' },
  { user_id: Number(ZHANG), nickname: 'zsan', card: '张三' },
]);
check('自己：群名片盖过昵称',
  names.resolveName(BOT, SELF, { groupId: GROUP, selfId: SELF, selfNames: ['小向'] }) === '客服小向');
check('自己：没花名册时用昵称',
  names.resolveName(BOT, SELF, { groupId: '556001', selfId: SELF, selfNames: ['小向'] }) === '小向');
check('自己：昵称列表取第一个非空',
  names.resolveName(BOT, SELF, { selfId: SELF, selfNames: ['', '', '备用名'] }) === '备用名');
check('自己：什么名字都没有时返回 null',
  names.resolveName(BOT, SELF, { selfId: SELF, selfNames: [] }) === null);

// ---------- 取失败后的重试节奏 ----------
names.markRosterPending(BOT, '557000');
check('占位后不算过期（不会连打多个请求）', names.rosterStale(BOT, '557000') === false);
check('占位时还没有名字', names.rosterInfo(BOT, '557000')?.count === 0);

names.markRosterFailed(BOT, '557000');
const afterFail = names.rosterInfo(BOT, '557000');
check('失败后不立刻重试', names.rosterStale(BOT, '557000') === false,
  JSON.stringify(afterFail));
// at 被往回拨，使「距过期」正好等于重试间隔
const untilStale = names.ROSTER_TTL - afterFail.ageMs;
check('失败后约 5 分钟后才重试',
  Math.abs(untilStale - names.ROSTER_RETRY) < 2000, String(untilStale));

// 成功之后恢复满血 TTL
names.markRosterPending(BOT, '557000');
names.markRosterFailed(BOT, '557000');
names.rememberRoster(BOT, '557000', [{ user_id: '1', nickname: '重试成功' }]);
const afterOk = names.rosterInfo(BOT, '557000');
check('成功后 age 归零', afterOk.ageMs < 2000, String(afterOk.ageMs));
check('成功后名字可用', names.resolveName(BOT, '1', { groupId: '557000' }) === '重试成功');

// 空花名册（查不到的群 / 权限不够）按失败处理，不能干等半小时
check('空花名册返回 0', names.rememberRoster(BOT, '558000', []) === 0);
check('空花名册不算过期（不会连打）', names.rosterStale(BOT, '558000') === false);
const emptyInfo = names.rosterInfo(BOT, '558000');
check('空花名册约 5 分钟后重试',
  Math.abs((names.ROSTER_TTL - emptyInfo.ageMs) - names.ROSTER_RETRY) < 2000,
  String(names.ROSTER_TTL - emptyInfo.ageMs));
check('空花名册不留下任何名字', names.resolveName(BOT, '1', { groupId: '558000' }) === null);
// 成员全是空名字也算空
check('全是空名字也算空',
  names.rememberRoster(BOT, '558001', [{ user_id: '9', nickname: '', card: '' }]) === 0);

// ---------- clearRosters ----------
names.clearRosters(OTHER);
check('clearRosters(某个机器人) 不影响别人', names.resolveName(BOT, ZHANG, { groupId: GROUP }) === '张三');
names.rememberRoster(OTHER, GROUP, [{ user_id: Number(ZHANG), nickname: '别的机器人的名字' }]);
check('另一个机器人有自己的花名册', names.resolveName(OTHER, ZHANG, { groupId: GROUP }) === '别的机器人的名字');
names.clearRosters(OTHER);
check('清掉之后恢复为 null', names.resolveName(OTHER, ZHANG, { groupId: GROUP }) === null);
names.clearRosters();
check('clearRosters() 清空全部', names.rosterInfo(BOT, GROUP) === null);

// ---------- 红线：任何路径都不能吐出 QQ 号 ----------
const QQS = [ZHANG, QQ_B, '111111', '999999999', SELF];
names.rememberRoster(BOT, GROUP, [
  { user_id: Number(SELF), nickname: '小向' },
  { user_id: Number(ZHANG), nickname: 'zsan' },
]);
let leak = null;
for (const qq of QQS) {
  for (const opt of [
    {},
    { groupId: GROUP },
    { groupId: GROUP, selfId: SELF, selfNames: ['小向'] },
    { selfId: SELF, selfNames: ['小向'] },
  ]) {
    const got = names.resolveName(BOT, qq, opt);
    if (got !== null && String(got).trim() === qq) leak = `${qq} / ${JSON.stringify(opt)}`;
  }
}
check('任何组合都不会把 QQ 号当名字返回', leak === null, String(leak));

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
db.closeDb();
log.closeLogs();
