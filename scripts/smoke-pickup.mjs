// 冒烟测试：接话（触发词 → 主动接一句）
//
// 全部用假模型：能断言「固定话术不花模型钱」（chatFn 一次都没被调用），
// 也能断言 ai 模式确实把「接话点」写进了提示词。
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, DATA_DIR } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as db from '../src/db.js';
import { BotWorker } from '../src/pipeline.js';
import { defaultBotSettings } from '../src/config.js';
import * as pickup from '../src/modules/pickup.js';
import * as lists from '../src/modules/lists.js';
import * as persona from '../src/modules/persona.js';
import * as fb from '../src/modules/fallback.js';
import * as sch from '../src/modules/schedule.js';
import * as rate from '../src/modules/rateLimit.js';

ensureDirs();
const TEST_DB = path.join(DATA_DIR, 'test-pickup.sqlite');
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.unlinkSync(f); } catch { /* 忽略 */ }
}
db.openDb(TEST_DB);
log.setLevel?.('error');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? '  [' + extra + ']' : '')); }
};

const settings = () => defaultBotSettings();

// ============ 匹配 ============
console.log('--- 匹配 ---');
const rules = [
  { id: 1, pattern: '晚安', match: 'contains', reply: '晚安，早点睡', mode: 'fixed' },
  { id: 2, pattern: 'abc', match: 'contains', reply: 'ok', mode: 'fixed' },
  { id: 3, pattern: '我睡了', match: 'exact', reply: '睡吧', mode: 'fixed' },
];
check('包含：句中出现就算', !!pickup.matchText('那我也晚安了', rules), '');
check('包含：完全没出现就不算', pickup.matchText('早上好', rules) === null);
check('包含：忽略大小写', !!pickup.matchText('说一声 ABC 就完事', rules));
check('包含：忽略全半角', !!pickup.matchText('来 ａｂｃ', rules));
check('完全相同：整条一致才命中', !!pickup.matchText('我睡了', rules));
check('完全相同：多了别的字就不算', pickup.matchText('我先说我睡了哈', rules) === null);
check('完全相同：前后的空格不算差别', !!pickup.matchText('  我睡了  ', rules));
check('空文本不命中', pickup.matchText('', rules) === null);
check('空触发词不命中', pickup.matchText('随便什么', [{ id: 9, pattern: '  ', match: 'contains' }]) === null);
check('多命中时取前面的规则', pickup.matchText('晚安 abc', rules)?.id === 1);

// ============ CRUD ============
console.log('--- 规则增删改 ---');
const BOT = db.createBot('接话测试机', '19001');
check('新建机器人时规则为空', pickup.listRules(BOT).length === 0);

const id1 = pickup.addRule(BOT, { pattern: '晚安', reply: '晚安，早点睡', match: 'contains', mode: 'fixed' });
check('加一条规则', pickup.listRules(BOT).length === 1 && id1 > 0);
check('默认冷却 0（用设置里的默认值）', pickup.listRules(BOT)[0].cooldown_sec === 0);
check('默认启用', pickup.listRules(BOT)[0].enabled === 1);

for (const [label, input] of [
  ['空触发词被拒', { pattern: '   ', reply: 'x' }],
  ['固定话术没写话被拒', { pattern: '晚安', mode: 'fixed', reply: '' }],
  ['触发词太长被拒', { pattern: 'x'.repeat(61), reply: 'x' }],
  ['话术太长被拒', { pattern: '晚安', reply: 'x'.repeat(301) }],
]) {
  let threw = false;
  try { pickup.addRule(BOT, input); } catch { threw = true; }
  check(label, threw);
}
check('被拒后没有留下脏数据', pickup.listRules(BOT).length === 1);

const batch = pickup.addRules(BOT, '我睡了\n\n  晚安了  \n晚安\n最后一个', { reply: '好', mode: 'fixed' });
check('批量加了 3 条（空行与重复的跳过）', batch.added === 3, JSON.stringify(batch));
check('重复的触发词被跳过并说明原因', batch.skipped.some((s) => s.why.includes('已经有')), JSON.stringify(batch.skipped));
check('去掉首尾空格后入库', pickup.listRules(BOT).some((r) => r.pattern === '晚安了' && r.pattern.startsWith('晚')));

const target = pickup.listRules(BOT).find((r) => r.pattern === '我睡了');
pickup.updateRule(target.id, { reply: '睡吧睡吧', mode: 'ai', cooldownSec: 30 });
const after = pickup.listRules(BOT).find((r) => r.id === target.id);
check('改话术', after.reply === '睡吧睡吧');
check('改模式', after.mode === 'ai');
check('改冷却', after.cooldown_sec === 30);
check('ai 模式允许不写话术', (() => {
  try { pickup.updateRule(target.id, { reply: '' }); return true; } catch { return false; }
})());
pickup.updateRule(target.id, { enabled: false });
check('禁用生效', pickup.listRules(BOT).find((r) => r.id === target.id).enabled === 0);
check('禁用后不参与匹配', pickup.matchText('我睡了', pickup.enabledRules(BOT)) === null);

pickup.removeRule(id1);
check('删掉一条', pickup.listRules(BOT).length === 3 && !pickup.listRules(BOT).some((r) => r.id === id1));
check('清空全部返回条数', pickup.clearRules(BOT) === 3 && pickup.listRules(BOT).length === 0);

// ============ 一句话好几种回法 ============
console.log('--- 多种回法（同段对话不重复）---');
check('换行分隔', pickup.variantsOf({ reply: '甲\n乙\n丙' }).length === 3);
check('竖线分隔', pickup.variantsOf({ reply: '甲|乙' }).length === 2);
check('去掉空行与首尾空格', JSON.stringify(pickup.variantsOf({ reply: ' 甲 \n\n 乙 ' })) === JSON.stringify(['甲', '乙']));
check('空回复 = 0 种', pickup.variantsOf({ reply: '' }).length === 0);
check('只有分隔符也算 0 种', pickup.variantsOf({ reply: '\n|\n' }).length === 0);

const BOTV = db.createBot('多回法测试机', '19003');
let threwMulti = false;
try { pickup.addRule(BOTV, { pattern: '全是空行', reply: '\n\n', mode: 'fixed' }); } catch { threwMulti = true; }
check('回法全是空行会被拒', threwMulti);
const vid = pickup.addRule(BOTV, { pattern: '晚安', reply: '甲\n乙\n丙', mode: 'fixed', cooldownSec: 0 });
const vrule = pickup.listRules(BOTV).find((r) => r.id === vid);
check('多行回法存库后是三种', pickup.variantsOf(vrule).length === 3, JSON.stringify(vrule.reply));

pickup.resetVariants();
const SESS_A = 9001, SESS_B = 9002;
const drawsA = [0, 1, 2].map(() => pickup.pickVariant(BOTV, SESS_A, vrule).text);
check('同一段对话里前三次各不重复', new Set(drawsA).size === 3, JSON.stringify(drawsA));
check('一段对话记满了 3 种', pickup.usedVariantCount(BOTV, SESS_A, vrule) === 3);
const fourth = pickup.pickVariant(BOTV, SESS_A, vrule);
check('全用完后允许重复（不会彻底哑掉）', !!fourth.text && fourth.reused === 3, JSON.stringify(fourth));
check('重来后记录回到 1 种', pickup.usedVariantCount(BOTV, SESS_A, vrule) === 1);
check('另一段对话是干净的', pickup.usedVariantCount(BOTV, SESS_B, vrule) === 0);
const oneB = pickup.pickVariant(BOTV, SESS_B, vrule);
check('另一段对话从头开始挑', !!oneB.text && pickup.usedVariantCount(BOTV, SESS_B, vrule) === 1, JSON.stringify(oneB));
const single = pickup.pickVariant(BOTV, SESS_A, { id: 999, reply: '只有一种' });
check('只有一种回法时永远挑它', single.text === '只有一种' && single.total === 1);

console.log('--- 自己接自己 ---');
const selfRule = { id: 201, pattern: '原神', match: 'contains', reply: '原神怎么你了', mode: 'fixed' };
check('对方已说了你要回的话（自己接自己）', pickup.isSelfCase(selfRule, '原神怎么你了') === true);
check('只是提到触发词不算', pickup.isSelfCase(selfRule, '今天原神更新了吗') === false);
check('短回法不参与判定（免得误伤正常命中）', pickup.isSelfCase({ reply: '吃了' }, '吃了吗') === false);
check('4 个字以上才参与判定', pickup.isSelfCase({ reply: '真的假' }, '真的假的') === false && pickup.isSelfCase({ reply: '真的假的' }, '真的假的') === true);
check('大小写/全半角不影响判定', pickup.isSelfCase({ reply: 'zdjd' }, 'ZDJD') === true);
check('默认概率 0.3', pickup.cfg(null).selfChance === 0.3, String(pickup.cfg(null).selfChance));
check('概率可调（0 与 1）', pickup.cfg({ pickup: { selfChance: 0 } }).selfChance === 0 && pickup.cfg({ pickup: { selfChance: 1 } }).selfChance === 1);
check('概率越界会被夹住', pickup.cfg({ pickup: { selfChance: 9 } }).selfChance === 1);

console.log('--- 被找茬时回一个字 ---');
check('方括号记号', pickup.extractAnnoyed('[急]').marked === true);
check('圆括号也认', pickup.extractAnnoyed('（急）').marked === true);
check('记号在句中也认', pickup.extractAnnoyed('行吧【急】你说得对').marked === true);
check('没有记号就不算', pickup.extractAnnoyed('就这？').marked === false);
const ex = pickup.extractAnnoyed('行吧【急】你说得对');
check('记号被剥干净（绝不泄漏到群里）', ex.cleaned === '行吧你说得对', JSON.stringify(ex.cleaned));
check('只有记号时正文为空', pickup.extractAnnoyed('[急]').cleaned === '');
check('连着两次判定结果一致（lastIndex 已复位）', pickup.extractAnnoyed('[急]').marked === true && pickup.extractAnnoyed('[急]').marked === true);
check('旁边一大段正文时不当成「就回一个字」', pickup.annoyedUsable('这是一段很长的正经回答，讲了半天理论推导和例子，还列了三条注意事项呢') === false);
check('短正文可以', pickup.annoyedUsable('好的') === true);
const anCfg = pickup.annoyedCfg(null);
check('默认：开着、概率 0.1、字是「急」', anCfg.enabled === true && anCfg.chance === 0.1 && anCfg.text === '急', JSON.stringify(anCfg));
check('默认只认「直接挨骂」这种强度', /辱骂|nmsl|sb|nmd/.test(anCfg.when), anCfg.when);
check('默认描述里说清了「普通的阴阳怪气不算」', /不算/.test(anCfg.when), anCfg.when);
check('能改成别的字', pickup.annoyedCfg({ pickup: { annoyed: { text: '急了' } } }).text === '急了');
check('概率越界会被夹住', pickup.annoyedCfg({ pickup: { annoyed: { chance: 9 } } }).chance === 1);
check('能关掉', pickup.annoyedCfg({ pickup: { annoyed: { enabled: false } } }).enabled === false);

// ============ 冷却与限额 ============
console.log('--- 冷却与限额 ---');
const r1 = { id: 101, pattern: 'a', match: 'contains', reply: 'x', mode: 'fixed', cooldown_sec: 60 };
const r2 = { id: 102, pattern: 'b', match: 'contains', reply: 'y', mode: 'fixed', cooldown_sec: 0 };
const st = settings();
check('第一次能接', pickup.peekCooldown(BOT, r1, st, 1000).ok === true);
pickup.resetCooldown();
check('commit 成功', pickup.commit(BOT, r1, st, 1000).ok === true);
const cd = pickup.peekCooldown(BOT, r1, st, 2000);
check('同一条规则进冷却', cd.ok === false && cd.retryInSec > 0, JSON.stringify(cd));
check('另一条规则不受影响', pickup.peekCooldown(BOT, r2, st, 2000).ok === true);
check('冷却期过后又能接', pickup.peekCooldown(BOT, r1, st, 1000 + 61_000).ok === true);
check('冷却中不记账（peat 只读）', pickup.peekCooldown(BOT, r1, st, 1000 + 61_000).ok === true);

// 冷却中的规则不该挡住后面命中的规则
pickup.resetCooldown();
pickup.addRule(BOT, { pattern: 'c', reply: '一', mode: 'fixed', cooldownSec: 300 });
pickup.addRule(BOT, { pattern: 'c', reply: '二', mode: 'fixed', cooldownSec: 0 });
const first = pickup.enabledRules(BOT)[0];
pickup.commit(BOT, first, st);
const eligible = pickup.matchEligible(BOT, 'c', st);
check('前一条冷却时，命中顶上后面的规则', eligible.rule && eligible.rule.id !== first.id, JSON.stringify(eligible.rule?.id));
check('全都冷却时给出提示', (() => {
  const e = pickup.enabledRules(BOT);
  pickup.commit(BOT, e[1], st);
  const m = pickup.matchEligible(BOT, 'c', st);
  return m.rule === null && m.cooling && m.cooling.retryInSec > 0;
})());

// 每小时上限：用一个单独的机器人，免得影响后面的管线测试
const BOT2 = db.createBot('限额测试机', '19002');
pickup.addRule(BOT2, { pattern: 'x', reply: 'x', mode: 'fixed', cooldownSec: 0 });
const tiny = defaultBotSettings();
tiny.pickup = { ...tiny.pickup, maxPerHour: 3 };
const one = pickup.enabledRules(BOT2)[0];
let allowed = 0, denied = 0;
for (let i = 0; i < 5; i++) {
  const c = pickup.commit(BOT2, one, tiny);
  if (c.ok) allowed++; else denied++;
}
check('每小时上限生效（3 次后拒）', allowed === 3 && denied === 2, `allowed=${allowed} denied=${denied}`);
check('用量看得见', pickup.hourlyCount(BOT2) === 3, String(pickup.hourlyCount(BOT2)));

console.log('--- 命中记账 ---');
pickup.noteHit(BOT, 0, 1234);
const anyRule = pickup.enabledRules(BOT)[0];
pickup.noteHit(BOT, anyRule.id, 1234);
const noted = pickup.listRules(BOT).find((r) => r.id === anyRule.id);
check('hits 累加', noted.hits === 1, String(noted.hits));
check('记下最近一次时间', Number(noted.last_hit_at) === 1234, String(noted.last_hit_at));

// ============ 接进管线 ============
console.log('--- 管线：固定话术 ---');
const BOT_QQ = '10001';
const USER = '20001';
const GROUP = '555001';

function makeFakeClient() {
  const sent = [];
  return {
    sent,
    async call(action) {
      if (action === 'get_group_member_list') return [{ user_id: Number(USER), nickname: '张三' }];
      throw new Error('假客户端没实现: ' + action);
    },
    async sendTo(kind, peerId, message) {
      sent.push({ kind, peerId, text: (message ?? []).map((s) => s?.data?.text ?? '').join(''), segs: message });
      return { message_id: 'out-' + sent.length };
    },
    async deleteMsg() { return true; },
    async getLoginInfo() { return { nickname: '小向' }; },
  };
}
function makeStub(reply = '模型接的话') {
  const calls = [];
  return { calls, reply, async chat(params) { calls.push(params); return { ok: true, text: this.reply, usage: { prompt: 10, cacheHit: 0, cacheMiss: 10, completion: 5 }, cost: { spent: 0, saved: 0 } }; } };
}

const botId = db.createBot('管线测试机', BOT_QQ);
db.run('update bots set settings = ? where id = ?', JSON.stringify({
  api: { mode: 'force_on', effortMode: 'low' },
  speak: { defaultGroupMode: 'passive', privateMode: 'passive', groupModes: {}, active: { randomRate: 1, minMessageLength: 2 } },
}), botId);
persona.upsertPersona(botId, { name: '测试人格', body: '【高频口头禅】· 我们来看', examples: [], params: {} });
fb.seedDefaults(botId);
sch.ensureSlots(botId, 3);
lists.addTarget(botId, 'user', 'accept', USER);
lists.addTarget(botId, 'group', 'accept', GROUP);

const client = makeFakeClient();
const stub = makeStub();
const worker = new BotWorker({ bot: db.getBot(botId), client, chatFn: (p) => stub.chat(p) });
await worker.onReady(BOT_QQ);

const txt = (t) => ({ type: 'text', data: { text: t } });
const atSeg = { type: 'at', data: { qq: BOT_QQ } };
let seq = 0;
const grp = (qq, segs) => ({
  post_type: 'message', time: Math.floor(Date.now() / 1000),
  message_id: 'in-' + (++seq), message_type: 'group', group_id: Number(GROUP), user_id: Number(qq),
  sender: { nickname: '张三', card: '张三', role: 'member' }, message: segs,
});

pickup.addRule(botId, { pattern: '晚安', reply: '晚安，早点睡', mode: 'fixed' });
pickup.addRule(botId, { pattern: '救命', reply: '', mode: 'ai' });
// 多回法 + 自己接自己（原神那条：对方说「原神怎么你了」时算自己接自己）
pickup.addRule(botId, { pattern: '吃了吗', reply: '吃了\n没吃\n你猜', mode: 'fixed', cooldownSec: 0 });
pickup.addRule(botId, { pattern: '原神', reply: '原神怎么你了', mode: 'fixed', cooldownSec: 0 });
pickup.resetCooldown();
pickup.resetVariants();
rate.reset();

client.sent.length = 0;
stub.calls.length = 0;
await worker.onMessage(grp(USER, [txt('那我也晚安了')]));
check('命中就接话', client.sent.length === 1 && client.sent[0].text.includes('晚安，早点睡'), JSON.stringify(client.sent.map((s) => s.text)));
check('固定话术不调模型（不花一分钱）', stub.calls.length === 0, String(stub.calls.length));

const hitsRow = pickup.listRules(botId).find((r) => r.pattern === '晚安');
check('命中记了账', hitsRow.hits === 1, String(hitsRow.hits));

client.sent.length = 0;
await worker.onMessage(grp(USER, [txt('早安')]));
check('不命中就一声不吭（被动模式）', client.sent.length === 0, JSON.stringify(client.sent.map((s) => s.text)));

// 冷却：紧跟着再说一次同样的触发词，不该再接（这里**不能**重置冷却）
client.sent.length = 0;
rate.reset();
await worker.onMessage(grp(USER, [txt('晚安')]));
check('冷却期内的第二次不接', client.sent.length === 0, JSON.stringify(client.sent.map((s) => s.text)));

console.log('--- 管线：多回法与「自己接自己」---');
// 同一条规则连说三次：三种回法应该各出现一次（同一段对话不重复）。
// 每次前都要清冷却 —— 这条规则没单独填冷却，走的是默认 60 秒，不清的话第 2、3 条会被冷却挡下。
client.sent.length = 0;
const askEat = async () => {
  pickup.resetCooldown();
  rate.reset();
  await worker.onMessage(grp(USER, [txt('吃了吗')]));
};
await askEat();
await askEat();
await askEat();
const eaten = client.sent.map((s) => s.text);
check('三次接了三条，且三种回法各一次', new Set(eaten).size === 3, JSON.stringify(eaten));
check('三种回法都在备选里', eaten.every((t) => ['吃了', '没吃', '你猜'].includes(t)), JSON.stringify(eaten));

// 换个群（另一段对话）→ 记录是独立的，能重新挑到同样的句子
client.sent.length = 0;
const GROUP2 = '555002';
lists.addTarget(botId, 'group', 'accept', GROUP2);
const grp2 = (qq, segs) => ({
  post_type: 'message', time: Math.floor(Date.now() / 1000),
  message_id: 'in-' + (++seq), message_type: 'group', group_id: Number(GROUP2), user_id: Number(qq),
  sender: { nickname: '张三', card: '张三', role: 'member' }, message: segs,
});
pickup.resetCooldown();
rate.reset();
await worker.onMessage(grp2(USER, [txt('吃了吗')]));
check('换一段对话后又能接（记录按对话隔离）', client.sent.length === 1, JSON.stringify(client.sent.map((s) => s.text)));

// 自己接自己：默认 0.3 不好断言，这里分别用 0 和 1 把两个极端都测掉
console.log('--- 管线：自己接自己的概率 ---');
const setSelf = (v) => {
  const s = JSON.parse(db.getBot(botId).settings);
  s.pickup = { ...(s.pickup ?? {}), selfChance: v };
  db.run('update bots set settings = ? where id = ?', JSON.stringify(s), botId);
};
setSelf(0);
client.sent.length = 0;
pickup.resetCooldown();
pickup.resetVariants();
rate.reset();
await worker.onMessage(grp(USER, [txt('原神怎么你了')]));
check('概率 0 时不做复读机', client.sent.length === 0, JSON.stringify(client.sent.map((s) => s.text)));

client.sent.length = 0;
pickup.resetCooldown();
rate.reset();
await worker.onMessage(grp(USER, [txt('今天原神更新了吗')]));
check('只是提到触发词照样接（自我判定不误伤正常命中）', client.sent.length === 1 && client.sent[0].text === '原神怎么你了', JSON.stringify(client.sent.map((s) => s.text)));

setSelf(1);
client.sent.length = 0;
pickup.resetCooldown();
pickup.resetVariants();
rate.reset();
await worker.onMessage(grp(USER, [txt('原神怎么你了')]));
check('概率 1 时照接不误', client.sent.length === 1 && client.sent[0].text === '原神怎么你了', JSON.stringify(client.sent.map((s) => s.text)));
setSelf(0.3);

console.log('--- 管线：@ 了也接 ---');
client.sent.length = 0;
pickup.resetCooldown();
rate.reset();
stub.calls.length = 0;
await worker.onMessage(grp(USER, [atSeg, txt('晚安，顺便问一下矩阵是什么')]));
check('@ 着说触发词也走固定回答', client.sent.length === 1 && client.sent[0].text.includes('晚安，早点睡'), JSON.stringify(client.sent.map((s) => s.text)));
check('@ 着也是本地直发（不调模型）', stub.calls.length === 0, String(stub.calls.length));

client.sent.length = 0;
pickup.resetCooldown();
rate.reset();
stub.calls.length = 0;
await worker.onMessage(grp(USER, [atSeg, txt('矩阵是什么')]));
check('只是被 @ 而没命中触发词时，还是模型回答', stub.calls.length === 1 && client.sent.length === 1, JSON.stringify({ calls: stub.calls.length, sent: client.sent.map((s) => s.text) }));

client.sent.length = 0;
pickup.resetCooldown();
rate.reset();
await worker.onMessage(grp(USER, [txt('那我也晚安了')]));
check('没 @ 时照样接', client.sent.length === 1, JSON.stringify(client.sent.map((s) => s.text)));

console.log('--- 管线：被找茬时回一个字 ---');
const setAnnoyed = (patch) => {
  const s = JSON.parse(db.getBot(botId).settings);
  s.pickup = { ...(s.pickup ?? {}), annoyed: { ...(s.pickup?.annoyed ?? {}), ...patch } };
  db.run('update bots set settings = ? where id = ?', JSON.stringify(s), botId);
};
// 提示词里要把「只认直接挨骂」和记号讲清楚
setAnnoyed({ enabled: true, chance: 1, when: '' });
stub.reply = '模型的话';
stub.calls.length = 0;
client.sent.length = 0;
pickup.resetCooldown();
rate.reset();
await worker.onMessage(grp(USER, [atSeg, txt('随便说点什么')]));
const annoyedTail = String(stub.calls[0]?.tail ?? '');
check('提示词里写了记号用法', annoyedTail.includes('[急]'), annoyedTail.slice(-140));
check('提示词里限定了「直接辱骂」这种强度', /辱骂|nmsl|sb|nmd/.test(annoyedTail), annoyedTail.slice(-200));
check('提示词里提醒拿不准就别用', annoyedTail.includes('拿不准'), annoyedTail.slice(-120));

// 只被 @ 才走模型：用「@ + 非触发词」让模型开口，模型回复里带记号
setAnnoyed({ enabled: true, chance: 1 });
stub.reply = '行吧 [急] 你说得对';
client.sent.length = 0;
pickup.resetCooldown();
rate.reset();
await worker.onMessage(grp(USER, [atSeg, txt('你这机器人也就这样了')]));
check('概率 1：只发那一个字', client.sent.length === 1 && client.sent[0].text === '急', JSON.stringify(client.sent.map((s) => s.text)));

stub.reply = '[急]';
client.sent.length = 0;
pickup.resetCooldown();
rate.reset();
await worker.onMessage(grp(USER, [atSeg, txt('切')]));
check('正文是空的也照发那一个字', client.sent.length === 1 && client.sent[0].text === '急', JSON.stringify(client.sent.map((s) => s.text)));

setAnnoyed({ chance: 0 });
stub.reply = '行吧 [急] 你说得对';
client.sent.length = 0;
pickup.resetCooldown();
rate.reset();
await worker.onMessage(grp(USER, [atSeg, txt('又来')]));
check('概率 0：不发那一个字，发原正文', client.sent.length >= 1 && !client.sent.some((s) => s.text.includes('急')), JSON.stringify(client.sent.map((s) => s.text)));
check('概率 0 时记号也被剥掉', client.sent.every((s) => !s.text.includes('急')), JSON.stringify(client.sent.map((s) => s.text)));

stub.reply = '这是一段很长的正经回答，讲了半天理论推导和例子，还顺手写了个 [急] 在里面';
client.sent.length = 0;
pickup.resetCooldown();
rate.reset();
await worker.onMessage(grp(USER, [atSeg, txt('正经问题')]));
check('正文很长时不当成想回一个字（照正文发）', client.sent.some((s) => s.text.includes('正经回答')), JSON.stringify(client.sent.map((s) => s.text)));

setAnnoyed({ enabled: false });
stub.reply = '行吧 [急] 你说得对';
client.sent.length = 0;
pickup.resetCooldown();
rate.reset();
await worker.onMessage(grp(USER, [atSeg, txt('关了试试')]));
const whenOff = client.sent.map((s) => s.text).join('');
check('关掉后记号照样被剥掉（只是不做「只回一个字」这件事）', whenOff.includes('行吧') && !whenOff.includes('急'), JSON.stringify(client.sent.map((s) => s.text)));

stub.reply = '[急]';
client.sent.length = 0;
pickup.resetCooldown();
rate.reset();
await worker.onMessage(grp(USER, [atSeg, txt('只回记号试试')]));
check('关掉且只剩记号时不吭声', client.sent.length === 0, JSON.stringify(client.sent.map((s) => s.text)));
setAnnoyed({ enabled: true, chance: 0.35 });
stub.reply = '模型接的话';

console.log('--- 管线：ai 模式 ---');
client.sent.length = 0;
pickup.resetCooldown();
rate.reset();
stub.calls.length = 0;
await worker.onMessage(grp(USER, [txt('救命啊')]));
check('ai 模式调了模型', stub.calls.length >= 1, String(stub.calls.length));
const tail = String(stub.calls[0]?.tail ?? '');
check('提示词里点明了接话点', tail.includes('救命') && tail.includes('接话点'), tail.slice(-160));
check('提示词里要求别提「关键词」', tail.includes('关键词'), tail.slice(-160));
check('ai 模式把模型的话发出去', client.sent.length === 1, JSON.stringify(client.sent.map((s) => s.text)));

console.log('--- 管线：关掉就不接 ---');
client.sent.length = 0;
pickup.resetCooldown();
const off = JSON.parse(db.getBot(botId).settings);
off.pickup = { enabled: false };
db.run('update bots set settings = ? where id = ?', JSON.stringify(off), botId);
await worker.onMessage(grp(USER, [txt('晚安')]));
check('总开关关掉后不接', client.sent.length === 0, JSON.stringify(client.sent.map((s) => s.text)));
off.pickup = { enabled: true };
db.run('update bots set settings = ? where id = ?', JSON.stringify(off), botId);

console.log('--- 管线：会话关闭发言时不接 ---');
client.sent.length = 0;
pickup.resetCooldown();
const shut = JSON.parse(db.getBot(botId).settings);
shut.speak.groupModes = { [GROUP]: 'off' };
db.run('update bots set settings = ? where id = ?', JSON.stringify(shut), botId);
await worker.onMessage(grp(USER, [txt('晚安')]));
check('关闭发言的会话不接话', client.sent.length === 0, JSON.stringify(client.sent.map((s) => s.text)));
shut.speak.groupModes = {};
db.run('update bots set settings = ? where id = ?', JSON.stringify(shut), botId);

console.log('--- 管线：回复名单拦得住 ---');
client.sent.length = 0;
pickup.resetCooldown();
lists.setMode(botId, 'user', 'reply', 'blacklist');
lists.addTarget(botId, 'user', 'reply', USER);
await worker.onMessage(grp(USER, [txt('晚安')]));
check('回复名单不放行时不接', client.sent.length === 0, JSON.stringify(client.sent.map((s) => s.text)));
lists.setMode(botId, 'user', 'reply', 'whitelist');
lists.removeTarget(botId, 'user', 'reply', USER);

console.log('--- 管线：API 掉线时固定话术照样接 ---');
client.sent.length = 0;
pickup.resetCooldown();
const noApi = JSON.parse(db.getBot(botId).settings);
noApi.api.mode = 'force_off';
db.run('update bots set settings = ? where id = ?', JSON.stringify(noApi), botId);
stub.calls.length = 0;
await worker.onMessage(grp(USER, [txt('大家晚安')]));
check('API 强制关闭时固定话术仍发出', client.sent.length === 1 && client.sent[0].text.includes('晚安，早点睡'), JSON.stringify(client.sent.map((s) => s.text)));
check('仍然没调模型', stub.calls.length === 0, String(stub.calls.length));
stub.calls.length = 0;
client.sent.length = 0;
pickup.resetCooldown();
await worker.onMessage(grp(USER, [txt('救命')]));
check('API 关闭时 ai 模式不硬接', client.sent.length === 0, JSON.stringify(client.sent.map((s) => s.text)));
noApi.api.mode = 'force_on';
db.run('update bots set settings = ? where id = ?', JSON.stringify(noApi), botId);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
db.closeDb();
process.exit(fail ? 1 : 0);
