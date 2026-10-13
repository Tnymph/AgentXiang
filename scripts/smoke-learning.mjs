// 冒烟测试：学习机制（素材收集 / 提炼 / 审核采纳 / 快照可回退）
// 用假模型，不产生 API 花费
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, DATA_DIR } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as db from '../src/db.js';
import * as persona from '../src/modules/persona.js';
import * as learning from '../src/modules/learning.js';
import { defaultBotSettings } from '../src/config.js';
import * as history from '../src/history.js';

ensureDirs();
const TEST_DB = path.join(DATA_DIR, 'test5.sqlite');
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
const S = defaultBotSettings();

// ============ 卡片结构解析 ============
console.log('--- 卡片结构 ---');
const CARD = [
  '【整体印象】',
  '课堂讲者，习惯用「我们」把听众拉进推导。',
  '',
  '【高频口头禅】',
  '· 我们来看',
  '· 也就是说',
  '',
  '【不会有的说法】',
  '· 不用网络流行语',
].join('\n');

const secs = persona.parseCard(CARD);
check('解析出 3 个小节', secs.length === 3, JSON.stringify(secs.map((s) => s.title)));
check('小节标题正确', secs[1].title === '高频口头禅');
check('条目提取正确', secs[1].lines.filter((l) => l.trim()).length === 2);
check('往返渲染一致', persona.renderCard(secs) === CARD, JSON.stringify(persona.renderCard(secs)));

const appended = persona.appendToSection(CARD, '高频口头禅', ['好，我们继续', '这个要注意']);
check('追加进已有小节', appended.includes('· 好，我们继续') && appended.includes('· 这个要注意'));
check('原有内容未丢', appended.includes('· 我们来看') && appended.includes('【不会有的说法】'));
check('追加不破坏小节数', persona.sectionTitles(appended).length === 3);

const newSec = persona.appendToSection(CARD, '句子结构', ['多用短句']);
check('小节不存在时新建', persona.sectionTitles(newSec).includes('句子结构') && newSec.includes('· 多用短句'));
check('新建后原内容仍在', newSec.includes('课堂讲者'));

const many = persona.appendMany(CARD, { 高频口头禅: ['甲'], 不会有的说法: ['乙'] });
check('批量追加生效', many.includes('· 甲') && many.includes('· 乙'));

// ============ 素材收集 ============
console.log('--- 素材收集 ---');
persona.upsertPersona(botId, { body: CARD, examples: ['这是一门什么样的课程呢'] });
const session = db.ensureSession(botId, 'group', '555001');

const addBot = (text) => history.saveBotMessage({ botId, sessionId: session.id, msgId: 'm' + Math.random(), text });
const addUser = (text) => history.saveUserMessage({
  botId, sessionId: session.id, msgId: 'u' + Math.random(), personId: null,
  senderQq: '20001', senderName: '张三', text,
});

addBot('我们来看这个问题');
addBot('我们来看这个问题');          // 重复，应被去重
addBot('别怕，我们一步一步来');
addBot('这条我说错了');
addUser('这道题怎么做');             // 用户消息不该进素材 A

const a = learning.collectSourceA(botId);
check('素材 A 只收机器人发言', !a.items.includes('这道题怎么做'));
check('素材 A 去重', a.items.filter((x) => x === '我们来看这个问题').length === 1, JSON.stringify(a.items));

// 标记 👎 后应被排除
const botMsg = db.one("select id from messages where bot_id = ? and text = '这条我说错了'", botId);
db.run('insert into marks (bot_id, message_id, kind, note, created_at) values (?,?,?,?,?)', botId, botMsg.id, 'bad', '', Date.now());
const a2 = learning.collectSourceA(botId);
check('被标👎的不进素材 A', !a2.items.includes('这条我说错了'), JSON.stringify(a2.items));
check('排除数被统计', a2.excluded === 1, String(a2.excluded));

// 标记 👍
const goodMsg = db.one("select id from messages where bot_id = ? and text = '别怕，我们一步一步来'", botId);
db.run('insert into marks (bot_id, message_id, kind, note, created_at) values (?,?,?,?,?)', botId, goodMsg.id, 'good', '', Date.now());
const bset = learning.collectSourceB(botId);
check('素材 B 收到 👍', bset.good.includes('别怕，我们一步一步来'), JSON.stringify(bset.good));
check('素材 B 收到 👎', bset.bad.includes('这条我说错了'), JSON.stringify(bset.bad));

// ============ 就绪判断 ============
console.log('--- 就绪判断 ---');
const r1 = learning.readiness(botId, defaultBotSettings());
check('有素材时可学', r1.ok === true, r1.reason);

const noA = defaultBotSettings();
noA.learning.sourceA = false;
noA.learning.sourceB = false;
const r2 = learning.readiness(botId, noA);
check('两个来源都关 => 不可学', r2.ok === false && r2.reason.includes('关闭'), r2.reason);

// A 关但 B 有标记 => 仍可学
const onlyB = defaultBotSettings();
onlyB.learning.sourceA = false;
check('A关但B有标记 => 可学', learning.readiness(botId, onlyB).ok === true);

// 清掉 B 的标记后，A 关就不可学
db.run('delete from marks where bot_id = ?', botId);
const onlyBNone = learning.readiness(botId, onlyB);
check('A关且B空 => 不可学', onlyBNone.ok === false, onlyBNone.reason);
check('不可学原因说明到位', onlyBNone.reason.includes('素材 A 已关闭') && onlyBNone.reason.includes('没有手动标记'), onlyBNone.reason);

// ============ 提炼（假模型）============
console.log('--- 提炼 ---');
const MODEL_JSON = JSON.stringify({
  observations: '素材里出现了「一步一步」这种带着人走的说法，现有卡片里没有。',
  suggestions: [
    { id: 1, section: '高频口头禅', text: '一步一步', reason: '反复出现', evidence: ['别怕，我们一步一步来'] },
    { id: 2, section: '句子结构', text: '安抚式开头：先「别怕」再接推导', reason: '降门槛', evidence: ['别怕，我们一步一步来'] },
    { id: 3, section: '固定例句', text: '别怕，我们一步一步来', reason: '语气典型' },
    { id: 4, section: '不存在的节', text: '应被过滤', reason: '非法小节' },
    { id: 5, section: '高频口头禅', text: '   ', reason: '空白条目应被过滤' },
  ],
});

const stub = async () => ({ ok: true, text: MODEL_JSON, usage: { prompt: 1000, cacheHit: 900, cacheMiss: 100, completion: 200 }, finishReason: 'stop' });
const run = await learning.runLearning({ botId, settings: defaultBotSettings(), apiKey: 'x', chatFn: stub });
check('提炼成功', run.ok === true, run.error);
check('过滤掉非法小节与空条目', run.suggestions.length === 3, String(run.suggestions?.length));
check('重新编了 id', run.suggestions.map((s) => s.id).join(',') === '1,2,3');
check('观察说明保留', run.observations.includes('一步一步'));

// 空建议也是正常结果
const emptyStub = async () => ({ ok: true, text: '{"observations":"没有新东西","suggestions":[]}', usage: {}, finishReason: 'stop' });
const runEmpty = await learning.runLearning({ botId, settings: defaultBotSettings(), apiKey: 'x', chatFn: emptyStub });
check('空建议视为成功', runEmpty.ok === true && runEmpty.suggestions.length === 0);

// 模型输出为空（思考吃光预算）应给出可读错误
const blankStub = async () => ({ ok: true, text: '', usage: { reasoning: 900 }, finishReason: 'length' });
const runBlank = await learning.runLearning({ botId, settings: defaultBotSettings(), apiKey: 'x', chatFn: blankStub });
check('空输出给出明确错误', runBlank.ok === false && runBlank.error.includes('没有输出'), runBlank.error);
check('空输出的错误里带上思考 token 数', runBlank.error.includes('900'), runBlank.error);

// 真实翻车现场（2026-09-25）：思考 7400 个把 8192 的预算吃光，正文被截断。
// 第一次调用按上限返回 length，第二次（预算翻倍）返回正常 JSON —— 应该自己重试成功。
const caps = [];
const truncThenOk = async ({ maxTokens }) => {
  caps.push(maxTokens);
  if (caps.length === 1) {
    return { ok: true, text: '', usage: { reasoning: 7400, completion: maxTokens }, finishReason: 'length' };
  }
  return { ok: true, text: MODEL_JSON, usage: { reasoning: 200, completion: 900 }, finishReason: 'stop' };
};
const runRetry = await learning.runLearning({ botId, settings: defaultBotSettings(), apiKey: 'x', chatFn: truncThenOk });
check('截断后自动扩大预算重试', caps.length === 2, JSON.stringify(caps));
check('第二次预算比第一次大', caps[1] > caps[0], JSON.stringify(caps));
check('重试成功后正常返回建议', runRetry.ok === true && runRetry.suggestions.length === 3, runRetry.error);
check('正常一次就够时不会多调', caps.length === 2, JSON.stringify(caps));

// 上限翻倍还是截断：要明确说清是截断 + 素材太多，而不是含糊的「请重试」。
// 真实的样子是**有正文、但在 JSON 中间被切断**（不是空文本）。
const alwaysTrunc = async ({ maxTokens }) => ({
  ok: true,
  text: MODEL_JSON.slice(0, 120),
  usage: { reasoning: maxTokens - 400, completion: maxTokens },
  finishReason: 'length',
});
const runTwice = await learning.runLearning({ botId, settings: defaultBotSettings(), apiKey: 'x', chatFn: alwaysTrunc });
check('两次都截断时明确报截断', runTwice.ok === false && runTwice.error.includes('截断'), runTwice.error);
check('错误里说清了怎么自救', runTwice.error.includes('素材') || runTwice.error.includes('标记'), runTwice.error);

// ============ 审核采纳 ============
console.log('--- 审核采纳 ---');
const before = persona.activePersona(botId);
const snapsBefore = persona.listSnapshots(botId).length;

const applied = learning.applyRun(botId, run.runId, [1, 2, 3]);
check('采纳返回条数', applied.chosen === 3 && applied.total === 3, JSON.stringify(applied));

const after = persona.activePersona(botId);
check('新口头禅写进卡片', after.body.includes('· 一步一步'));
check('新句子结构写进卡片', after.body.includes('安抚式开头'));
check('固定例句写进例句表', persona.parseExamples(after).includes('别怕，我们一步一步来'));
check('原有内容未被破坏', after.body.includes('· 我们来看') && after.body.includes('课堂讲者'));

const snapsAfter = persona.listSnapshots(botId);
check('采纳前自动存了快照', snapsAfter.length === snapsBefore + 1, `${snapsBefore} -> ${snapsAfter.length}`);
check('快照是自动类型', snapsAfter[0].kind === 'auto', JSON.stringify(snapsAfter[0]));

// 部分采纳
// 注意：素材 A 是增量的——上次采纳之后的时间点会成为新的起点，
// 所以要产生新的机器人发言，才有东西可学。
addBot('我们再来看一个新的情况');
const run2 = await learning.runLearning({ botId, settings: defaultBotSettings(), apiKey: 'x', chatFn: stub });
check('增量：只学上次采纳之后的新素材', run2.ok === true && run2.sourceA === 1, `aCount=${run2.sourceA}`);
learning.applyRun(botId, run2.runId, [1]);
const after2 = persona.activePersona(botId);
check('只采纳勾选的那条', (after2.body.match(/· 一步一步/g) ?? []).length === 2, '追加了两次 —— 说明只采纳了 id=1');

// 没有新素材时应明确拒绝，而不是空跑
const runNoNew = await learning.runLearning({ botId, settings: defaultBotSettings(), apiKey: 'x', chatFn: stub });
check('无新素材时拒绝并说明原因', runNoNew.ok === false && runNoNew.error.includes('没有新的素材 A'), runNoNew.error);

// full=true 可以强制把全部历史过一遍
const runFull = await learning.runLearning({ botId, settings: defaultBotSettings(), apiKey: 'x', chatFn: stub, full: true });
check('full 模式能取到全量素材', runFull.ok === true && runFull.sourceA >= 3, String(runFull.sourceA));
learning.discardRun(botId, runFull.runId);

// 丢弃
const run3 = await learning.runLearning({ botId, settings: defaultBotSettings(), apiKey: 'x', chatFn: stub, full: true });
const beforeDiscard = persona.activePersona(botId).body;
learning.discardRun(botId, run3.runId);
check('丢弃不改卡片', persona.activePersona(botId).body === beforeDiscard);
check('丢弃后状态正确', learning.getRun(run3.runId).status === 'discarded');

// 重复处理应报错
let dupErr = '';
try { learning.applyRun(botId, run.runId, [1]); } catch (e) { dupErr = e.message; }
check('已处理的记录不能再处理', dupErr.includes('已经处理过'), dupErr);

// ============ 回退 ============
console.log('--- 回退 ---');
const snapId = snapsAfter[0].id;
persona.restoreSnapshot(botId, snapId);
const restored = persona.activePersona(botId);
check('回退后新增内容消失', !restored.body.includes('· 一步一步'));
check('回退后原有内容还在', restored.body.includes('· 我们来看'));

// ============ 历史记录 ============
const runs = learning.listRuns(botId);
check('历史可列出', runs.length >= 4, String(runs.length));
check('历史含采纳与丢弃两种状态',
  runs.some((r) => r.status === 'applied') && runs.some((r) => r.status === 'discarded'));

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
db.closeDb();
log.closeLogs();
process.exit(fail === 0 ? 0 : 1);
