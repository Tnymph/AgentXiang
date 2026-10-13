// 冒烟测试：命令系统 / 风格卡 / 印象
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, DATA_DIR } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as db from '../src/db.js';
import * as cmds from '../src/modules/commands.js';
import * as admins from '../src/modules/admins.js';
import * as persona from '../src/modules/persona.js';
import * as imp from '../src/modules/impression.js';
import * as llm from '../src/llm.js';
import { defaultBotSettings, loadGlobal, saveGlobal } from '../src/config.js';
import { normalizeEvent } from '../src/message.js';

ensureDirs();
const TEST_DB = path.join(DATA_DIR, 'test2.sqlite');
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

// ============ 命令注册表 ============
console.log('--- 注册表 ---');
check('能找到 learn', cmds.findCommand('learn')?.name === 'learn');
check('大小写无关', cmds.findCommand('LEARN')?.name === 'learn');
check('未知命令返回 null', cmds.findCommand('nope') === null);
check('命令数正确', cmds.uniqueCommands().length === 8, String(cmds.uniqueCommands().length));
check('八个命令都注册了', ['learn', 'undo', 'help', 'spend', 'spendtrend', 'api', 'talk', 'voice']
  .every((n) => cmds.findCommand(n)?.name === n));
check('spendtrend 有短别名', cmds.findCommand('trend')?.name === 'spendtrend');
check('voice 的两个别名都指回 voice', cmds.findCommand('voiceon')?.name === 'voice' && cmds.findCommand('voiceoff')?.name === 'voice');
check('learn 仅管理员', cmds.isAdminOnly('learn'));
check('talk 仅管理员', cmds.isAdminOnly('talk'));
check('voice 仅管理员', cmds.isAdminOnly('voice'));

console.log('--- 帮助文本 ---');
const help = cmds.renderHelp(S);
check('含默认正文', help.includes('我能听懂这几个口令'), help.slice(0, 60));
check('含 learn goodex 行', help.includes('/learn goodex —— 记住这条，这样说对'));
check('含 undo 行', help.includes('/undo'));
check('含页脚', help.includes('口令只对管理员开放'));
check('说明了 @ 指名规则', help.includes('@我 /help'), help.slice(-160));
const helpCustom = cmds.renderHelp({
  help: { body: '自定义正文', footer: '自定义页脚', descriptions: { 'learn.goodex': '改过的说明' } },
});
check('正文可覆盖', helpCustom.includes('自定义正文'));
check('说明可覆盖', helpCustom.includes('/learn goodex —— 改过的说明'));
check('页脚可覆盖', helpCustom.includes('自定义页脚'));
check('未覆盖的仍用默认', helpCustom.includes('/undo —— 撤销上一条口令（要引用它）'));

// ============ 管理员 ============
console.log('--- 管理员 ---');
check('默认没人（空名单）', !admins.isAdmin(botId, '20001'));
admins.addAdmin(botId, '20001');
check('加入后是管理员', admins.isAdmin(botId, '20001'));
check('其他人不是', !admins.isAdmin(botId, '20002'));

// 大小号绑定后，小号继承权限
const p1 = db.ensurePersonByQq(botId, '20001');
db.run('insert into person_qqs (bot_id, qq, person_id, is_primary, created_at) values (?,?,?,?,?)',
  botId, '20009', p1, 0, Date.now());
check('绑定的小号继承管理员', admins.isAdmin(botId, '20009'));
admins.removeAdmin(botId, '20001');
check('移除后小号也失去权限', !admins.isAdmin(botId, '20009'));

// ============ 风格卡 ============
console.log('--- 风格卡 ---');
check('初始无风格卡', persona.activePersona(botId) === null);
const prompt0 = persona.buildSystemPrompt(botId);
check('无卡时也能生成 prompt', prompt0.includes('尚未设定风格'));

persona.upsertPersona(botId, {
  name: '测试人格',
  body: '【高频口头禅】\n· 我们来看\n· 也就是说',
  examples: ['这是一门什么样的课程呢', '恭喜你猜对了'],
  params: { avgSentenceChars: 22, addressStyle: '以「大家」为主' },
});
const prompt1 = persona.buildSystemPrompt(botId);
check('prompt 含风格正文', prompt1.includes('我们来看'));
check('prompt 含例句', prompt1.includes('恭喜你猜对了'));
check('prompt 含输出规则', prompt1.includes('只输出你要说的那句话本身'));
check('prompt 含参数约束', prompt1.includes('每句话大约 22 个字'));
check('prompt 不含规则泄漏提示', !prompt1.includes('不要提到这些规则，不要提到') === false);

console.log('--- prompt 稳定性（缓存前提）---');
const a = persona.buildSystemPrompt(botId);
const b = persona.buildSystemPrompt(botId);
check('同样输入产出逐字节相同', a === b);
persona.upsertPersona(botId, { body: '【改过】\n· 新的口头禅' });
const c = persona.buildSystemPrompt(botId);
check('改卡后 prompt 变化', c !== a && c.includes('新的口头禅'));

console.log('--- 快照 ---');
const snapId = persona.snapshot(botId, '基准版', 'base');
check('快照创建成功', snapId > 0);
persona.upsertPersona(botId, { body: '【被学歪了】' });
check('当前卡已变', persona.buildSystemPrompt(botId).includes('被学歪了'));
persona.restoreSnapshot(botId, snapId);
check('还原成功', persona.buildSystemPrompt(botId).includes('新的口头禅'));
const snaps = persona.listSnapshots(botId);
check('还原前自动留了备份', snaps.some((s) => s.kind === 'auto' && s.label.includes('还原前自动备份')));
check('基准快照仍在', snaps.some((s) => s.kind === 'base' && s.label === '基准版'));

// ============ 印象 ============
console.log('--- 印象 ---');
check('无印象返回空串', imp.formatForPrompt(botId, p1) === '');
imp.upsertAuto(botId, p1, { facts: '在准备考研', feelings: '爱开玩笑' });
const f1 = imp.formatForPrompt(botId, p1);
check('自动印象可读出', f1.includes('在准备考研') && f1.includes('爱开玩笑'), f1);
imp.setManual(botId, p1, '这是我带的班的学生，说话别太正式');
const f2 = imp.formatForPrompt(botId, p1);
check('手写内容进 prompt', f2.includes('说话别太正式'));
check('手写与自动共存', f2.includes('考研') && f2.includes('别太正式'));
imp.upsertAuto(botId, p1, { facts: '换了新内容' });
const f3 = imp.formatForPrompt(botId, p1);
check('自动更新不覆盖手写', f3.includes('别太正式') && f3.includes('换了新内容'));

// ============ 命令处理（端到端，用假 client）============
console.log('--- /help 与 /learn 处理 ---');
const session = db.ensureSession(botId, 'private', '20001');
admins.addAdmin(botId, '20001');

const sent = [];
const fakeClient = {
  async deleteMsg(id) { sent.push({ deleted: id }); return true; },
};
function mkCtx(over = {}) {
  return {
    botId, settings: S, sessionId: session.id, personId: p1,
    senderQq: '20001', kind: 'private', peerId: '20001',
    client: fakeClient, quoteId: null,
    send: async (t) => { sent.push({ text: t }); return 'out-' + sent.length; },
    ...over,
  };
}

const helpDef = cmds.findCommand('help');
const r1 = await helpDef.handler(mkCtx(), []);
check('/help 发出了文本', sent.some((x) => x.text?.includes('我能听懂这几个口令')));
check('/help 返回消息产物', r1.effect.kind === 'message' && !!r1.effect.outMsgId);
check('/help 静默', r1.silent === true);

// 手工造一条机器人的历史消息
db.run(`insert into messages (bot_id, session_id, msg_id, role, person_id, sender_qq, sender_name, text, flags, ts)
        values (?,?,?,?,?,?,?,?,?,?)`,
  botId, session.id, 'botmsg-1', 'bot', null, '10001', '机器人', '这是一门什么样的课程呢', '', Date.now());
const botMsg = db.one('select * from messages where msg_id = ?', 'botmsg-1');

const learnDef = cmds.findCommand('learn');
sent.length = 0;
const r2 = await learnDef.handler(mkCtx({ quoteId: 'botmsg-1' }), ['goodex']);
check('/learn 标记了引用那条', r2.effect.kind === 'mark' && r2.effect.messageId === botMsg.id, JSON.stringify(r2.effect));
check('/learn 发出了确认回话', sent.some((x) => typeof x.text === 'string' && x.text.length > 0), JSON.stringify(sent));
check('确认回话用的是 goodex 文案', sent.some((x) => x.text === '好，我记住这种说法了。'), JSON.stringify(sent));
check('记录了回话 id 供 /undo 撤回', (r2.effect.outMsgIds ?? []).length === 1, JSON.stringify(r2.effect));
const markedReplyId = (r2.effect.outMsgIds ?? [])[0];
const markRow = db.one('select * from marks where message_id = ?', botMsg.id);
check('marks 表有记录', !!markRow && markRow.kind === 'good');

sent.length = 0;
const r2b = await learnDef.handler(mkCtx({ quoteId: 'botmsg-1' }), ['badex']);
check('/learn badex 记录了负面标记', r2b.effect.markKind === 'bad');
check('badex 用另一套文案', sent.some((x) => x.text.includes('会改变语言风格')), JSON.stringify(sent));

// 回话文案可以在设置里改
const custom = { ...S, speak: { ...S.speak, learnReplies: { goodex: '照这个来', badex: '换一个说法' } } };
sent.length = 0;
await learnDef.handler(mkCtx({ quoteId: 'botmsg-1', settings: custom }), ['goodex']);
check('回话文案可用设置覆盖', sent.some((x) => x.text === '照这个来'), JSON.stringify(sent));

const r3 = await learnDef.handler(mkCtx(), ['nonsense']);
check('/learn 参数非法被拒', !!r3.error, JSON.stringify(r3));

const r4 = await learnDef.handler(mkCtx({ quoteId: 'someone-else' }), ['goodex']);
check('/learn 引用非自己消息被拒', !!r4.error);

// ============ /undo ============
console.log('--- /undo ---');
cmds.logCommand({
  botId, sessionId: session.id, actorQq: '20001', command: 'learn', args: 'goodex',
  cmdMsgId: 'cmd-1', outMsgId: null, effect: r2.effect,
});
const undoDef = cmds.findCommand('undo');
sent.length = 0;
const u1 = await undoDef.handler(mkCtx({ quoteId: 'cmd-1' }), []);
check('/undo 回退了标记', u1.silent === true && !u1.error, JSON.stringify(u1));
check('marks 已删除', !db.one('select * from marks where id = ?', r2.effect.markId));
check('/undo 顺带撤回了那句确认回话',
  sent.some((x) => x.deleted === markedReplyId), JSON.stringify(sent));

cmds.logCommand({
  botId, sessionId: session.id, actorQq: '20001', command: 'help', args: '',
  cmdMsgId: 'cmd-2', outMsgId: 'out-9', effect: { kind: 'message', outMsgId: 'out-9' },
});
const u2 = await undoDef.handler(mkCtx({ quoteId: 'out-9' }), []);
check('/undo 能通过产出消息定位', u2.silent === true && !u2.error, JSON.stringify(u2));
check('确实调用了撤回', sent.some((x) => x.deleted === 'out-9'));

const u3 = await undoDef.handler(mkCtx({ quoteId: null }), []);
check('/undo 未引用被拒', !!u3.error);
const u4 = await undoDef.handler(mkCtx({ quoteId: 'unknown' }), []);
check('/undo 引用无关消息被拒', !!u4.error);

// 超时撤回
cmds.logCommand({
  botId, sessionId: session.id, actorQq: '20001', command: 'help', args: '',
  cmdMsgId: 'cmd-3', outMsgId: 'out-old', effect: { kind: 'message', outMsgId: 'out-old' },
});
db.run("update command_log set created_at = ? where cmd_msg_id = 'cmd-3'", Date.now() - 200_000);
const u5 = await undoDef.handler(mkCtx({ quoteId: 'out-old' }), []);
check('/undo 超时给出明确原因', !!u5.error && u5.error.includes('超过可撤回时限'), u5.error);

// ============ /spend 与 /api ============
console.log('--- /spend ---');
const spendDef = cmds.findCommand('spend');
check('/spend 已注册', !!spendDef);
check('/help 里列出了 spend', cmds.renderHelp(S).includes('/spend'));
check('/help 里列出了 api', cmds.renderHelp(S).includes('/api'));

sent.length = 0;
const sp1 = await spendDef.handler(mkCtx(), []);
check('/spend 有输出', sent.some((x) => typeof x.text === 'string' && x.text.includes('花费')), JSON.stringify(sent));
check('/spend 记录了消息 id', !!sp1.effect.outMsgId, JSON.stringify(sp1.effect));
check('/spend 是消息型 effect（可被 /undo 撤回）', sp1.effect.kind === 'message');

console.log('--- /spendtrend ---');
const trendDef = cmds.findCommand('spendtrend');
check('/spendtrend 已注册', !!trendDef);
check('/help 里列出了 spendtrend', cmds.renderHelp(S).includes('/spendtrend'));

// 一条数据都没有时要说清楚，而不是报个 ¥0 让人以为正常
sent.length = 0;
await trendDef.handler(mkCtx(), []);
check('没数据时如实说明',
  sent.some((x) => String(x.text).includes('还没有调用过模型')), JSON.stringify(sent));

// 造几天数据，验算「今天 vs 历史日均」。
// 只用 miss token，价格 1.10 元/百万，手算得出来：
//   miss 1,000,000 → ¥1.10
db.run(`insert into api_usage (bot_id, day, scene, prompt_tokens, cache_hit_tokens, cache_miss_tokens,
        completion_tokens, reasoning_tokens, calls, created_at) values (?,?,?,?,?,?,?,?,?,?)`,
  botId, '2026-09-20', 'chat', 1000000, 0, 1000000, 0, 0, 3, Date.now());
db.run(`insert into api_usage (bot_id, day, scene, prompt_tokens, cache_hit_tokens, cache_miss_tokens,
        completion_tokens, reasoning_tokens, calls, created_at) values (?,?,?,?,?,?,?,?,?,?)`,
  botId, '2026-09-21', 'chat', 500000, 0, 500000, 0, 0, 2, Date.now());
db.run(`insert into api_usage (bot_id, day, scene, prompt_tokens, cache_hit_tokens, cache_miss_tokens,
        completion_tokens, reasoning_tokens, calls, created_at) values (?,?,?,?,?,?,?,?,?,?)`,
  botId, '2026-09-22', 'chat', 200000, 0, 200000, 0, 0, 1, Date.now());

const t1 = llm.spendTrend([botId], { today: '2026-09-22' });
const near = (a, b) => Math.abs(a - b) < 0.001;
check('今天的花费按当天算', near(t1.today, 0.22), String(t1.today));
check('历史日均按有数据的天平均', near(t1.avg, (1.10 + 0.55) / 2), String(t1.avg));
check('样本天数是历史天数（不含今天）', t1.samples === 2, String(t1.samples));
check('今天的调用次数也算进来', t1.todayCalls === 1, String(t1.todayCalls));
check('分号明细带上今天花费', t1.perBot[0]?.todaySpent !== undefined && near(t1.perBot[0].todaySpent, 0.22));

// 只有今天的数据：不该编一个日均出来
const t2 = llm.spendTrend([botId], { today: '2026-09-20' });
check('只有今天数据时 samples 为 0', t2.samples === 0, String(t2.samples));
check('只有今天数据时 avg 为 0', t2.avg === 0, String(t2.avg));
check('今天的花费照旧给出', near(t2.today, 1.10), String(t2.today));

// 多机器人：默认合计，按 id 挑人
const botB = db.createBot('第二个号', '10002');
db.run(`insert into api_usage (bot_id, day, scene, prompt_tokens, cache_hit_tokens, cache_miss_tokens,
        completion_tokens, reasoning_tokens, calls, created_at) values (?,?,?,?,?,?,?,?,?,?)`,
  botB, '2026-09-22', 'chat', 100000, 0, 100000, 0, 0, 5, Date.now());
const tAll = llm.spendTrend([], { today: '2026-09-22' });
check('不指定就统计所有机器人', tAll.botIds.length === 2, JSON.stringify(tAll.botIds));
check('合计包含两个号', near(tAll.today, 0.22 + 0.11), String(tAll.today));
const tOne = llm.spendTrend([botB], { today: '2026-09-22' });
check('指定单个机器人只算它', near(tOne.today, 0.11), String(tOne.today));
check('指定单个机器人时只有它一个', tOne.botIds.length === 1);
check('分号明细按今天花费排序', tAll.perBot[0].botId === botId, JSON.stringify(tAll.perBot.map((b) => b.botId)));

// 非法 id 不该把别人拖下水
check('无效 id 被忽略', llm.spendTrend([999999]).botIds.length >= 1, JSON.stringify(llm.spendTrend([999999]).botIds));

sent.length = 0;
await trendDef.handler(mkCtx(), []);
const trendText = sent.map((x) => String(x.text)).join('\n');
check('回复里有「今天」和「历史日均」', trendText.includes('今天') && trendText.includes('历史日均'), trendText.slice(0, 120));
check('回复里报了样本天数', /按最近 3 个有数据的天算/.test(trendText), trendText.slice(0, 160));
check('多机器人时给出分号明细', trendText.includes('分号'), trendText.slice(0, 200));

// 今天还没调用过时不打百分比：那不是"花费下降"
check('今天没调用过时如实说明', trendText.includes('今天还没调用过'), trendText.slice(0, 200));
check('今天没调用过时不打对比百分比', !/今天比日均/.test(trendText), trendText.slice(0, 200));

// 有今天的花费时才给对比
db.run(`insert into api_usage (bot_id, day, scene, prompt_tokens, cache_hit_tokens, cache_miss_tokens,
        completion_tokens, reasoning_tokens, calls, created_at) values (?,?,?,?,?,?,?,?,?,?)`,
  botId, new Date().toISOString().slice(0, 10), 'chat', 200000, 0, 200000, 0, 0, 4, Date.now());
sent.length = 0;
await trendDef.handler(mkCtx(), []);
const trendText2 = sent.map((x) => String(x.text)).join('\n');
check('有今天的花费时给出对比', /今天比日均(高|低)/.test(trendText2), trendText2.slice(0, 200));
check('对比依据含今天这一天', /今天\s+¥0\.2/.test(trendText2), trendText2.slice(0, 120));

check('/spendtrend 是消息型 effect（可被 /undo 撤回）',
  (await trendDef.handler(mkCtx(), [])).effect.kind === 'message');

console.log('--- /talk ---');
const talkDef = cmds.findCommand('talk');
check('/talk 已注册', !!talkDef);
check('/help 里列出了 talk', cmds.renderHelp(S).includes('/talk'));

// ⚠️ 这个开关存在**全局配置**里（和密钥一样是全机共享的），不是每个机器人各一份。
// 所以测试前后必须原样恢复，否则会把真实机器人一直开着互聊模式。
const savedTalk = JSON.parse(JSON.stringify(loadGlobal().talk ?? {}));
try {
  sent.length = 0;
  await talkDef.handler(mkCtx(), []);
  check('/talk 不带参数显示状态',
    sent.some((x) => /AI 互聊现在是/.test(String(x.text))), JSON.stringify(sent));

  sent.length = 0;
  await talkDef.handler(mkCtx(), ['on']);
  check('/talk on 真的写进全局设置', loadGlobal().talk.enabled === true);
  check('/talk on 回了话', sent.some((x) => /AI 互聊开了/.test(String(x.text))), JSON.stringify(sent));
  check('回复里说明了节奏与刹车',
    sent.some((x) => /毫秒/.test(String(x.text)) && /自动停/.test(String(x.text))), JSON.stringify(sent));

  sent.length = 0;
  await talkDef.handler(mkCtx(), ['off']);
  check('/talk off 关上', loadGlobal().talk.enabled === false);

  sent.length = 0;
  await talkDef.handler(mkCtx(), ['nonsense']);
  check('/talk 参数非法时给用法', sent.some((x) => /用法/.test(String(x.text))), JSON.stringify(sent));
  check('非法参数不会误开', loadGlobal().talk.enabled === false);
} finally {
  // 强制把开关关掉，只把数值还回去。理由同 smoke-pipeline：
  // 「原样恢复成测试前的值」会把上一次运行的污染继承下去。
  saveGlobal({ talk: { ...savedTalk, enabled: false } });
  console.log('  （已恢复全局 talk 设置，开关强制为关）');
}
check('测试后 talk 是关的（绝不把生产配置留在互聊模式）',
  loadGlobal().talk.enabled === false, JSON.stringify(loadGlobal().talk));

console.log('--- /api ---');
const apiDef = cmds.findCommand('api');
check('/api 已注册', !!apiDef);

sent.length = 0;
await apiDef.handler(mkCtx(), []);
check('/api 不带参数时显示当前模式', sent.some((x) => String(x.text).includes('接入模式')), JSON.stringify(sent));

sent.length = 0;
await apiDef.handler(mkCtx(), ['on']);
check('/api on 回话正确', sent.some((x) => String(x.text).includes('强制接入')), JSON.stringify(sent));
check('/api on 真的写进设置了', JSON.parse(db.getBot(botId).settings).api.mode === 'force_on',
  JSON.parse(db.getBot(botId).settings).api.mode);

sent.length = 0;
await apiDef.handler(mkCtx(), ['off']);
check('/api off 生效', JSON.parse(db.getBot(botId).settings).api.mode === 'force_off');

sent.length = 0;
await apiDef.handler(mkCtx(), ['auto']);
check('/api auto 生效', JSON.parse(db.getBot(botId).settings).api.mode === 'auto');

sent.length = 0;
await apiDef.handler(mkCtx(), ['nonsense']);
check('/api 参数非法时给用法', sent.some((x) => String(x.text).includes('用法')), JSON.stringify(sent));
check('/api 大小写不敏感', (await (async () => {
  sent.length = 0;
  await apiDef.handler(mkCtx(), ['ON']);
  return sent.some((x) => String(x.text).includes('强制接入'));
})()) === true);

console.log('--- /voice（确认书里写的 /VoiceOn、/VoiceOff 也在这里）---');
const voiceDef = cmds.findCommand('voice');
const readVoiceMode = () => JSON.parse(db.getBot(botId).settings ?? '{}').speak?.voice?.mode;

sent.length = 0;
await voiceDef.handler(mkCtx(), []);
check('/voice 不带参数显示状态', sent.some((x) => String(x.text).includes('语音现在是')), JSON.stringify(sent));
check('/voice 状态里带本小时条数', sent.some((x) => String(x.text).includes('本小时已用')), JSON.stringify(sent));

sent.length = 0;
await voiceDef.handler(mkCtx(), ['on']);
check('/voice on 落库成语音档', readVoiceMode() === 'voice', String(readVoiceMode()));
check('/voice on 回话正确', sent.some((x) => String(x.text).includes('全用语音')), JSON.stringify(sent));

await voiceDef.handler(mkCtx(), ['off']);
check('/voice off 落库成文字档', readVoiceMode() === 'text', String(readVoiceMode()));

await voiceDef.handler(mkCtx(), ['auto']);
check('/voice auto 落库成模型决定档', readVoiceMode() === 'ai', String(readVoiceMode()));
await voiceDef.handler(mkCtx(), ['ai']);
check('/voice 也认 ai 这个写法', readVoiceMode() === 'ai', String(readVoiceMode()));

// 别名 = 不带参数的 on / off（命令名以消息里实际打的那个为准）
await voiceDef.handler(mkCtx({ msg: { command: { name: 'VoiceOn' } } }), []);
check('/VoiceOn 等于 /voice on', readVoiceMode() === 'voice', String(readVoiceMode()));
await voiceDef.handler(mkCtx({ msg: { command: { name: 'voiceoff' } } }), []);
check('/VoiceOff 等于 /voice off', readVoiceMode() === 'text', String(readVoiceMode()));

sent.length = 0;
await voiceDef.handler(mkCtx(), ['nonsense']);
check('/voice 参数非法给用法', sent.some((x) => String(x.text).includes('用法')), JSON.stringify(sent));
await voiceDef.handler(mkCtx(), ['off']);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
db.closeDb();
log.closeLogs();
process.exit(fail === 0 ? 0 : 1);
