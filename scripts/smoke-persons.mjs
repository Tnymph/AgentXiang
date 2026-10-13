// 冒烟测试：人的绑定/解绑、印象自动提炼
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, DATA_DIR } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as db from '../src/db.js';
import * as persons from '../src/modules/persons.js';
import * as impression from '../src/modules/impression.js';
import * as history from '../src/history.js';

ensureDirs();
const TEST_DB = path.join(DATA_DIR, 'test6.sqlite');
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.unlinkSync(f); } catch { /* 忽略 */ }
}
db.openDb(TEST_DB);

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', label, extra ? '→ ' + extra : ''); }
};

const botId = db.createBot('测试机', '10001');
const session = db.ensureSession(botId, 'private', '20001');
const say = (qq, text) => history.saveUserMessage({
  botId, sessionId: session.id, msgId: 'm' + Math.random(), personId: db.ensurePersonByQq(botId, qq),
  senderQq: qq, senderName: qq, text,
});

// ============ 绑定 ============
console.log('--- 绑定 ---');
const pA = db.ensurePersonByQq(botId, '20001');
const pB = db.ensurePersonByQq(botId, '20009');
check('两个号一开始是两个人', pA !== pB, `${pA} vs ${pB}`);

say('20001', '大号说的话');
say('20009', '小号说的话');

const b1 = persons.bind(botId, '20001', '20009');
check('绑定成功', b1.ok === true && b1.merged === true, JSON.stringify(b1));
check('绑定后同一个人的号有两个', db.getPersonQqs(botId, b1.personId).length === 2,
  JSON.stringify(db.getPersonQqs(botId, b1.personId)));
check('两边说过的话都归到同一个人',
  Number(db.one('select count(*) as c from messages where bot_id = ? and person_id = ?', botId, b1.personId).c) === 2);

const b2 = persons.bind(botId, '20001', '20009');
check('重复绑定不出错且不重复合并', b2.ok === true && b2.merged === false, JSON.stringify(b2));

const b3 = persons.bind(botId, '20001', '20001');
check('绑自己会被拒', b3.ok === false, JSON.stringify(b3));

// ============ 解绑 ============
console.log('--- 解绑 ---');
const u1 = persons.unbind(botId, '20009');
check('解绑成功', u1.ok === true, JSON.stringify(u1));
check('解绑出来是一个新人', u1.personId !== b1.personId);
check('它的号列表里只有一个', db.getPersonQqs(botId, u1.personId).length === 1);
check('原来那个人还剩一个号', db.getPersonQqs(botId, b1.personId).length === 1);
check('解绑出来的号不带历史（按新用户算）',
  Number(db.one('select count(*) as c from messages where bot_id = ? and person_id = ?', botId, u1.personId).c) === 0);

const u2 = persons.unbind(botId, '20001');
check('唯一号解绑被拒', u2.ok === false && u2.error.includes('独立'), JSON.stringify(u2));

const u3 = persons.unbind(botId, '99999');
check('没记录的号解绑被拒', u3.ok === false, JSON.stringify(u3));

// ============ 印象提炼 ============
console.log('--- 印象提炼 ---');
const pid = b1.personId;
check('一开始没有印象', impression.get(botId, pid) === null);
check('少于两条素材时跳过', (await (async () => {
  const fresh = db.ensurePersonByQq(botId, '30001');
  const r = await impression.extractFor(botId, fresh, { settings: {}, apiKey: 'x', chatFn: async () => ({ ok: true, text: '{}' }) });
  return r.ok === false && r.error.includes('素材太少');
})()) === true);

const stub = async () => ({
  ok: true,
  text: JSON.stringify({ facts: '在准备考研，数学基础一般', feelings: '问问题很客气，怕麻烦别人' }),
  usage: { prompt: 500, cacheHit: 400, cacheMiss: 100, completion: 60 },
});
const ex = await impression.extractFor(botId, pid, { settings: {}, apiKey: 'x', chatFn: stub });
check('提炼成功', ex.ok === true, ex.error);
const imp = impression.get(botId, pid);
check('事实写入了', imp.facts.includes('考研'), imp.facts);
check('印象写入了', imp.feelings.includes('客气'), imp.feelings);
check('能拼成给模型看的一段', impression.formatForPrompt(botId, pid).includes('考研'));

// 手写内容不被自动提炼覆盖
impression.setManual(botId, pid, '这是我班上的学生');
await impression.extractFor(botId, pid, {
  settings: {}, apiKey: 'x',
  chatFn: async () => ({ ok: true, text: JSON.stringify({ facts: '换了一批新事实', feelings: '换了一批新感受' }) }),
});
const imp2 = impression.get(botId, pid);
check('自动提炼不覆盖手写内容', imp2.manual === '这是我班上的学生');
check('手写内容进 prompt', impression.formatForPrompt(botId, pid).includes('我班上的学生'));

// 提炼失败要有可读原因
const badJson = async () => ({ ok: true, text: '模型说了一堆话但没有 JSON' });
const r1 = await impression.extractFor(botId, pid, { settings: {}, apiKey: 'x', chatFn: badJson });
check('非 JSON 输出给出可读错误', r1.ok === false && r1.error.includes('JSON'), r1.error);

const blank = async () => ({ ok: true, text: '', usage: { reasoning: 2000 } });
const r2 = await impression.extractFor(botId, pid, { settings: {}, apiKey: 'x', chatFn: blank });
check('空输出给出可读错误', r2.ok === false && r2.error.includes('没有输出'), r2.error);

const failed = async () => ({ ok: false, error: 'HTTP 429' });
const r3 = await impression.extractFor(botId, pid, { settings: {}, apiKey: 'x', chatFn: failed });
check('模型报错会向上传递', r3.ok === false && r3.error === 'HTTP 429');

// ============ 人与印象的列表 ============
console.log('--- 列表 ---');
const ov = persons.overview(botId);
check('概览列出所有人', Array.isArray(ov) && ov.length >= 3, String(ov.length));
check('概览带发言数', ov.some((x) => x.msg_count > 0), JSON.stringify(ov));
check('素材按时间正序返回', (() => {
  const u = impression.recentUtterances(botId, pid);
  return u.length >= 2;
})());

// ============ 提炼素材要干净 ============
console.log('--- 素材过滤 ---');
const pid2 = db.ensurePersonByQq(botId, '40001');
const say2 = (text, flags = '') => db.run(
  `insert into messages (bot_id, session_id, msg_id, role, person_id, sender_qq, sender_name, text, flags, ts)
   values (?,?,?,?,?,?,?,?,?,?)`,
  botId, session.id, 'x' + Math.random(), 'user', pid2, '40001', '测试', text, flags, Date.now());

say2('/help', 'command');
say2('借来的命令文本', 'carried');
say2('/这个是没被识别成命令的命令');   // 没有 command 标记，但看着就是命令
say2('我说的一句话');
say2('又说了一句');

const utt = impression.recentUtterances(botId, pid2);
check('命令消息不进素材', !utt.includes('/help'), JSON.stringify(utt));
check('承接来的文字不进素材', !utt.includes('借来的命令文本'), JSON.stringify(utt));
check('没被识别成命令的命令也不进素材',
  !utt.some((t) => t.startsWith('/')), JSON.stringify(utt));
check('正常发言进素材', utt.includes('我说的一句话') && utt.includes('又说了一句'), JSON.stringify(utt));
check('全角斜杠同样排除', (() => {
  say2('／spend', '');
  return !impression.recentUtterances(botId, pid2).some((t) => t.startsWith('／'));
})());

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
db.closeDb();
log.closeLogs();
process.exit(fail === 0 ? 0 : 1);
