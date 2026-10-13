// 冒烟测试：消息管线端到端
//
// 行为断言全部用注入的假模型（快、确定、不花钱、不因线上波动误报），
// 末尾另有一条真实 API 的集成校验，确认链路真的通。
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, DATA_DIR, ROOT, TMP_DIR } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as db from '../src/db.js';
import { BotWorker, normalizeReply, pickImageDetail } from '../src/pipeline.js';
import { defaultBotSettings, loadGlobal, saveGlobal } from '../src/config.js';
import * as talk from '../src/modules/talk.js';
import * as personaMod from '../src/modules/persona.js';
import * as speakingMod from '../src/modules/speaking.js';
import { parseWav } from '../src/wav.js';
import * as asrMod from '../src/asr.js';
import * as rate from '../src/modules/rateLimit.js';
import * as names from '../src/names.js';
import * as history from '../src/history.js';
import * as lists from '../src/modules/lists.js';
import * as admins from '../src/modules/admins.js';
import * as persona from '../src/modules/persona.js';
import * as impression from '../src/modules/impression.js';
import * as fb from '../src/modules/fallback.js';
import * as sch from '../src/modules/schedule.js';
import * as llm from '../src/llm.js';

ensureDirs();
const TEST_DB = path.join(DATA_DIR, 'test3.sqlite');
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.unlinkSync(f); } catch { /* 忽略 */ }
}
db.openDb(TEST_DB);

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', label, extra ? '→ ' + extra : ''); }
};

// ---------- 假客户端与假模型 ----------
function makeFakeClient() {
  const sent = [];
  return {
    sent,
    recordFile: null,          // 语音测试用：getRecord 返回的本地文件
    apiCalls: [],              // 记录调过的 OneBot 接口（花名册走这里）
    roster: { 10000001: '张三' },   // 假的花名册
    async call(action, params) {
      this.apiCalls.push({ action, params });
      if (action === 'get_group_member_list') {
        return Object.entries(this.roster).map(([qq, nickname]) => ({ user_id: Number(qq), nickname }));
      }
      throw new Error('假客户端没实现这个接口: ' + action);
    },
    async sendTo(kind, peerId, message) {
      const text = (message ?? []).map((s) => s?.data?.text ?? '').join('');
      // segs 留着给语音测试看原始段（type=record 时没有 text）
      sent.push({ kind, peerId, text, segs: message });
      return { message_id: 'out-' + sent.length };
    },
    async deleteMsg(id) { sent.push({ deleted: id }); return true; },
    async getLoginInfo() { return { nickname: '小向' }; },
    async getRecord() { return { file: this.recordFile, url: '' }; },
  };
}

/** 从讲稿录音里截一小段，做成测试用的短语音文件（纯 JS 重写 wav，不借助外部工具） */
function makeShortWav(fromSec, toSec) {
  const src = fs.readFileSync(path.join(ROOT, 'style-samples', 'wav', 'p02.wav'));
  const w = parseWav(src);
  const a = Math.floor(fromSec * w.sampleRate);
  const b = Math.min(w.samples.length, Math.floor(toSec * w.sampleRate));
  const slice = w.samples.subarray(a, b);
  const dataSize = slice.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(w.sampleRate, 24);
  buf.writeUInt32LE(w.sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < slice.length; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(slice[i] * 32767))), 44 + i * 2);
  }
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const p = path.join(TMP_DIR, 'test-voice.wav');
  fs.writeFileSync(p, buf);
  return p;
}

const MODEL_REPLY = '我们来看这个问题';
function makeStub(reply = MODEL_REPLY) {
  const calls = [];
  return {
    calls,
    reply,
    async chat(params) {
      calls.push(params);
      return { ok: true, text: this.reply, usage: { prompt: 100, cacheHit: 80, cacheMiss: 20, completion: 10 }, cost: { spent: 0, saved: 0 } };
    },
  };
}

// ---------- 造机器人 ----------
const BOT_QQ = '10001';
const USER = '20001';
const OTHER = '20002';
const GROUP = '555001';

const botId = db.createBot('测试机', BOT_QQ);
db.run('update bots set settings = ? where id = ?', JSON.stringify({
  api: { mode: 'force_on', effortMode: 'low' },
  speak: { defaultGroupMode: 'passive', privateMode: 'passive', groupModes: {}, active: { randomRate: 1, minMessageLength: 2 } },
}), botId);

persona.upsertPersona(botId, {
  name: '测试人格',
  body: '【高频口头禅】· 我们来看\n【不会有的说法】不要用网络流行语',
  examples: ['这是一门什么样的课程呢'],
  params: { avgSentenceChars: 22 },
});
fb.seedDefaults(botId);
sch.ensureSlots(botId, 3);
lists.addTarget(botId, 'user', 'accept', USER);
lists.addTarget(botId, 'user', 'accept', OTHER);
lists.addTarget(botId, 'group', 'accept', GROUP);
admins.addAdmin(botId, USER);

const client = makeFakeClient();
const stub = makeStub();
const worker = new BotWorker({ bot: db.getBot(botId), client, chatFn: (p) => stub.chat(p) });
await worker.onReady(BOT_QQ);

const ev = (over) => ({
  post_type: 'message', time: Math.floor(Date.now() / 1000),
  message_id: 'in-' + Math.random().toString(36).slice(2, 8),
  sender: { nickname: '张三', card: '张三', role: 'member' },
  ...over,
});
const priv = (qq, text, over = {}) => ev({ message_type: 'private', user_id: Number(qq), message: [{ type: 'text', data: { text } }], ...over });
const grp = (gid, qq, segs, over = {}) => ev({ message_type: 'group', group_id: Number(gid), user_id: Number(qq), message: segs, ...over });
// 真实形状：NapCat 的 at 段只有 qq，没有 name（它源码里把 name 注释掉了）。
// 名字得靠 names 模块解析——测试数据必须按真实形状来，否则测不出真问题。
const atSeg = { type: 'at', data: { qq: BOT_QQ } };
const atOther = (qq) => ({ type: 'at', data: { qq } });
const txt = (t) => ({ type: 'text', data: { text: t } });

// 最后一条入库的用户消息（正文存的是 textClean）
const lastUserText = () =>
  db.one("select text from messages where bot_id = ? and role = 'user' order by id desc limit 1", botId)?.text ?? '';

// ============ 名单 ============
console.log('--- 名单 ---');
client.sent.length = 0;
await worker.onMessage(priv('29999', '你好'));
check('名单外的人：无任何发送', client.sent.length === 0, JSON.stringify(client.sent));

console.log('--- 回复名单（未配置时跟随接受）---');
check('未配置时不被独立拦截', lists.canInteract(botId, { kind: 'private', senderQq: USER }).reply === true);
lists.setMode(botId, 'user', 'reply', 'blacklist');
lists.addTarget(botId, 'user', 'reply', USER);
check('切过模式后算已配置', lists.isConfigured(botId, 'user', 'reply') === true);
client.sent.length = 0;
await worker.onMessage(grp(GROUP, USER, [atSeg, txt('在吗')]));
check('黑名单里的人：被@ 也不回', client.sent.length === 0, JSON.stringify(client.sent));
check('但仍记录了他说的内容', db.all('select text from messages where bot_id = ?', botId).some((r) => r.text === '在吗'));
lists.setMode(botId, 'user', 'reply', 'whitelist');
lists.addTarget(botId, 'user', 'reply', USER);
lists.addTarget(botId, 'user', 'reply', OTHER);

// ============ 被 @ → 走模型 ============
console.log('--- 被@ 走模型 ---');
stub.calls.length = 0;
client.sent.length = 0;
await worker.onMessage(grp(GROUP, USER, [atSeg, txt(' 今天讲什么')]));
check('发出了回复', client.sent.length === 1 && client.sent[0].text === MODEL_REPLY, JSON.stringify(client.sent));
check('调用了模型', stub.calls.length === 1);
const c1 = stub.calls[0];
check('system 是风格卡', c1.system.includes('我们来看') && c1.system.includes('不会有的说法'));
check('system 不含动态时间', !/\d{4}-\d{2}-\d{2}/.test(c1.system));
check('tail 带上了消息原文', c1.tail.includes('今天讲什么'));
check('tail 标注了说话人', c1.tail.includes('张三'), c1.tail.slice(0, 120));
check('被动触发不加沉默提示', !c1.tail.includes('<pass>'));
check('群历史带说话人前缀', c1.history.some((h) => h.content.includes('张三：')), JSON.stringify(c1.history).slice(0, 200));
check('被@：正文里没有机器人QQ号', !c1.tail.includes(String(BOT_QQ)), c1.tail.slice(0, 120));

// ============ @ 别人的显示名 ============
//
// NapCat 只给 QQ 号，名字靠 names 模块补。两层：库里见过的人立刻可用，
// 从没说过话的人要等群成员花名册取回来（异步），所以第一条消息只能用中性占位。
console.log('--- @ 别人的显示名 ---');
const ZHANG_QQ = 10000001;

names.clearRosters(botId);
rate.reset();
client.sent.length = 0;
client.apiCalls.length = 0;
await worker.onMessage(grp(GROUP, USER, [atOther(ZHANG_QQ), txt(' 你看这个')]));
const firstText = lastUserText();
check('花名册未就绪：不出现QQ号', !firstText.includes(String(ZHANG_QQ)), firstText);
check('花名册未就绪：用中性占位', firstText.includes('@某人'), firstText);
check('顺手请求了群成员花名册',
  client.apiCalls.some((c) => c.action === 'get_group_member_list' && String(c.params.group_id) === String(GROUP)),
  JSON.stringify(client.apiCalls));
// 同一条消息不该反复请求（占位生效）
const callsAfter1 = client.apiCalls.length;
await worker.onMessage(grp(GROUP, USER, [atOther(ZHANG_QQ), txt(' 还在吗')]));
check('同一批不重复请求花名册', client.apiCalls.length === callsAfter1, String(client.apiCalls.length));

await new Promise((r) => setTimeout(r, 30));   // 等后台把花名册存进去
await worker.onMessage(grp(GROUP, USER, [atOther(ZHANG_QQ), txt(' 你来看看')]));
const laterText = lastUserText();
check('花名册就绪后：@ 用真名', laterText.includes('@张三'), laterText);
check('花名册就绪后：仍不出现QQ号', !laterText.includes(String(ZHANG_QQ)), laterText);

// 引用消息里的 @ 也要解析
check('解析器同时给 pipeline 用', laterText.startsWith('@张三'), laterText);

// ============ 私聊 ============
console.log('--- 私聊 ---');
// 私聊的被动 = 每条都回（群里才要求 @ 或叫名字）
rate.reset();
stub.calls.length = 0;
client.sent.length = 0;
await worker.onMessage(priv(USER, '我就随便说说'));
check('私聊没叫名字也回', client.sent.length === 1 && client.sent[0].text === MODEL_REPLY, JSON.stringify(client.sent));
check('确实调用了模型', stub.calls.length === 1);

rate.reset();
stub.calls.length = 0;
client.sent.length = 0;
await worker.onMessage(priv(USER, '小向 在吗'));
check('私聊叫名字同样回', client.sent.length === 1 && client.sent[0].text === MODEL_REPLY);
check('私聊历史不带说话人前缀', !stub.calls.at(-1).history.some((h) => h.content.includes('张三：')));

// 对照：群里不叫名字就不该回
rate.reset();
stub.calls.length = 0;
client.sent.length = 0;
await worker.onMessage(grp(GROUP, USER, [txt('随便说点什么')]));
check('群里不叫名字不回', client.sent.length === 0 && stub.calls.length === 0, JSON.stringify(client.sent));

// ============ 思考吃光预算时的自愈 ============
console.log('--- 预算耗尽自愈 ---');
rate.reset();
const budgetStub = {
  calls: [],
  async chat(p) {
    this.calls.push(p);
    if (this.calls.length === 1) {
      // 第一次：全部预算被思考占掉，返回空
      return { ok: true, text: '', finishReason: 'length', usage: { prompt: 1500, cacheHit: 1280, cacheMiss: 220, completion: 2048, reasoning: 2048 } };
    }
    return { ok: true, text: MODEL_REPLY, finishReason: 'stop', usage: { prompt: 1500, cacheHit: 1280, cacheMiss: 220, completion: 180, reasoning: 110 } };
  },
};
const bw = new BotWorker({ bot: db.getBot(botId), client, chatFn: (p) => budgetStub.chat(p) });
await bw.onReady(BOT_QQ);
client.sent.length = 0;
await bw.onMessage(priv(USER, '测试自愈'));
check('检测到空回复后自动重试', budgetStub.calls.length === 2, String(budgetStub.calls.length));
check('重试时扩大了 token 预算', budgetStub.calls[1].maxTokens > budgetStub.calls[0].maxTokens,
  `${budgetStub.calls[0].maxTokens} -> ${budgetStub.calls[1].maxTokens}`);
check('重试后成功发出回复', client.sent.length === 1 && client.sent[0].text === MODEL_REPLY, JSON.stringify(client.sent));
rate.reset();

// ============ 印象进 tail ============
console.log('--- 印象 ---');
const personId = db.ensurePersonByQq(botId, USER);
impression.setManual(botId, personId, '这是我带的班的学生，说话别太正式');
stub.calls.length = 0;
await worker.onMessage(priv(USER, '小向 在吗'));
const cImp = stub.calls.at(-1);
check('印象出现在 tail', cImp.tail.includes('说话别太正式'), cImp.tail.slice(0, 120));
check('印象不在 system 里', !cImp.system.includes('说话别太正式'));

// ============ 主动模式 ============
console.log('--- 主动模式 ---');
db.run('update bots set settings = ? where id = ?', JSON.stringify({
  api: { mode: 'force_on', effortMode: 'low' },
  speak: { defaultGroupMode: 'active', privateMode: 'passive', groupModes: {}, active: { randomRate: 1, minMessageLength: 2, perGroupPerHour: 50, minGapSec: 0 } },
}), botId);
stub.calls.length = 0;
await worker.onMessage(grp(GROUP, OTHER, [txt('这道题我不太明白')]));
check('主动模式：主动接话', client.sent.length > 0);
check('主动模式 tail 带沉默提示', stub.calls.at(-1).tail.includes('<pass>'), stub.calls.at(-1).tail.slice(-160));

// 模型选择沉默
stub.reply = '<pass>';
client.sent.length = 0;
await worker.onMessage(grp(GROUP, OTHER, [txt('今天天气不错啊')]));
check('模型回 <pass> 时静默', client.sent.length === 0, JSON.stringify(client.sent));
stub.reply = MODEL_REPLY;

// 粗筛：太短
stub.calls.length = 0;
await worker.onMessage(grp(GROUP, OTHER, [txt('好')]));
check('太短被粗筛挡掉（不调模型）', stub.calls.length === 0);

db.run('update bots set settings = ? where id = ?', JSON.stringify({
  api: { mode: 'force_on', effortMode: 'low' },
  speak: { defaultGroupMode: 'passive', privateMode: 'passive', groupModes: {}, active: {} },
}), botId);

// ============ 复读 ============
console.log('--- 复读 ---');
db.run('update bots set settings = ? where id = ?', JSON.stringify({
  api: { mode: 'force_on', effortMode: 'low' },
  speak: { defaultGroupMode: 'active', privateMode: 'passive', groupModes: {}, active: { randomRate: 0, minMessageLength: 2, perGroupPerHour: 50, minGapSec: 0 } },
  repeatEcho: { enabled: true, minPeople: 2, maxGapMessages: 3, windowMessages: 15, matchMode: 'loosest', minLength: 2, onlyActiveMode: true },
}), botId);
await worker.onMessage(grp(GROUP, USER, [txt('这也太真实了')]));
stub.calls.length = 0;
await worker.onMessage(grp(GROUP, OTHER, [txt('这也太真实了！！')]));
const cEcho = stub.calls.at(-1);
check('复读被检测到并交给模型', !!cEcho && cEcho.tail.includes('同一句话'), cEcho?.tail?.slice(-200) ?? 'no call');
check('复读 tail 带原话', cEcho?.tail.includes('这也太真实了！'));
db.run('update bots set settings = ? where id = ?', JSON.stringify({
  api: { mode: 'force_on', effortMode: 'low' },
  speak: { defaultGroupMode: 'passive', privateMode: 'passive', groupModes: {}, active: {} },
}), botId);

// ============ 兜底 ============
console.log('--- 兜底 ---');
client.sent.length = 0;
await worker.onMessage(grp(GROUP, USER, [atSeg, { type: 'video', data: {} }]));
const vidReply = client.sent[0]?.text ?? '';
check('纯视频：走兜底且不调模型', fb.listFor(botId, 'video').some((x) => x.text === vidReply), vidReply);
check('兜底不记入历史', !db.all("select text from messages where bot_id = ? and role = 'bot'", botId).some((m) => m.text === vidReply));

client.sent.length = 0;
await worker.onMessage(grp(GROUP, USER, [atSeg, { type: 'video', data: {} }]));
check('兜底冷却生效', client.sent.length === 0);

// ============ API 关闭 -> 走默认回复 ============
console.log('--- API 关闭 ---');
const s2 = JSON.parse(db.getBot(botId).settings);
s2.api.mode = 'force_off';
db.run('update bots set settings = ? where id = ?', JSON.stringify(s2), botId);
fb.resetCooldown();
client.sent.length = 0;
await worker.onMessage(grp(GROUP, USER, [atSeg, txt('这道题怎么做')]));
const offReply = client.sent[0]?.text ?? '';
check('走 api_off 默认回复', fb.listFor(botId, 'api_off').some((x) => x.text === offReply), offReply);

// API 没接入时**不该主动说话**。
// 早先的漏洞：主动触发照样成立，然后拿一句兜底话术去接一句不相干的话——
// 表现为「没接入 API，机器人还在没头没脑地自动回复」。
console.log('--- API 关闭时不主动说话 ---');
const s3 = JSON.parse(db.getBot(botId).settings);
s3.api.mode = 'force_off';
s3.speak.defaultGroupMode = 'active';
s3.speak.active = { perGroupPerHour: 300, minGapSec: 1, minMessageLength: 1, randomRate: 1 };
db.run('update bots set settings = ? where id = ?', JSON.stringify(s3), botId);

rate.reset(); fb.resetCooldown();
client.sent.length = 0;
await worker.onMessage(grp(GROUP, USER, [txt('这期视频神了')]));
check('API 关闭 + 没人点名：完全不说话', client.sent.length === 0, JSON.stringify(client.sent));

rate.reset(); fb.resetCooldown();
client.sent.length = 0;
await worker.onMessage(grp(GROUP, USER, [txt('转发了张图')]));
check('API 关闭 + 纯文字主动消息：也不说话', client.sent.length === 0, JSON.stringify(client.sent));

// 被点名是另一回事：那是「默认回复」该管的场景，仍然要回
rate.reset(); fb.resetCooldown();
client.sent.length = 0;
await worker.onMessage(grp(GROUP, USER, [atSeg, txt('在吗')]));
check('API 关闭 + 被 @：仍然回默认话术', client.sent.length === 1, JSON.stringify(client.sent));
check('回的确实是 api_off 话术',
  fb.listFor(botId, 'api_off').some((x) => x.text === (client.sent[0]?.text ?? '')),
  client.sent[0]?.text ?? '');

// 接入 API 后主动发言恢复正常——证明上面拦的是「API 状态」，不是把主动模式弄坏了
console.log('--- 接入 API 后主动发言恢复 ---');
s3.api.mode = 'force_on';
db.run('update bots set settings = ? where id = ?', JSON.stringify(s3), botId);
rate.reset(); fb.resetCooldown();
stub.calls.length = 0;
client.sent.length = 0;
await worker.onMessage(grp(GROUP, USER, [txt('这期视频神了')]));
check('API 接入后：主动接话恢复', client.sent.length === 1 && stub.calls.length === 1,
  JSON.stringify(client.sent));

const s2b = JSON.parse(db.getBot(botId).settings);
s2b.api.mode = 'force_on';
s2b.speak.defaultGroupMode = 'passive';
db.run('update bots set settings = ? where id = ?', JSON.stringify(s2b), botId);
s2.api.mode = 'force_on';
db.run('update bots set settings = ? where id = ?', JSON.stringify(s2), botId);

// ============ 命令 ============
console.log('--- 命令 ---');
fb.resetCooldown();
client.sent.length = 0;
await worker.onMessage(priv(USER, '/help'));
check('/help 有输出', client.sent.some((x) => (x.text ?? '').includes('我能听懂这几个口令')));

client.sent.length = 0;
await worker.onMessage(priv(OTHER, '/help'));
check('非管理员发命令：完全静默', client.sent.length === 0, JSON.stringify(client.sent));

rate.reset();
client.sent.length = 0;
await worker.onMessage(priv(USER, '/nonsense'));
check('未知命令在私聊按普通文本处理（会回）', client.sent.length === 1, JSON.stringify(client.sent));

// 对照：群里未知命令既不触发命令也不触发主动发言，应完全静默
rate.reset();
client.sent.length = 0;
await worker.onMessage(grp(GROUP, USER, [txt('/nonsense')]));
check('未知命令在群里静默', client.sent.length === 0, JSON.stringify(client.sent));

client.sent.length = 0;
await worker.onMessage(priv(BOT_QQ, '小向 你好呀'));
check('自己的机器人发言：不响应', client.sent.length === 0);

// 命令消息不进记忆
const histAfterCmd = db.all("select flags from messages where bot_id = ? and role = 'user' order by id desc limit 3", botId);
check('命令消息打了标记', histAfterCmd.some((r) => String(r.flags).includes('command')), JSON.stringify(histAfterCmd));

// ============ 历史 ============
console.log('--- 历史 ---');
const botMsgs = db.all("select * from messages where bot_id = ? and role = 'bot'", botId);
check('机器人的回复入库', botMsgs.length > 0, String(botMsgs.length));
check('带 msg_id', botMsgs.some((m) => m.msg_id && m.msg_id.startsWith('out-')));

// ============ 语音条识别 ============
console.log('--- 语音条 ---');
const asrUp = await asrMod.probe({ host: '127.0.0.1', port: 6007 });
if (!asrUp.ok) {
  console.log('  ⚠ 识别服务未在线（' + asrUp.error + '），跳过语音条集成测试');
  console.log('    启动方式：scripts\\asr-server.cmd');
  check('语音条识别（服务未启动则跳过）', true);
} else {
  const voiceFile = makeShortWav(16, 30);         // p02 的语音从 15.3 秒开始，避开前面的静音
  client.recordFile = voiceFile;

  // 关掉识别时：语音条应走兜底，且不调模型
  db.run('update bots set settings = ? where id = ?', JSON.stringify({
    api: { mode: 'force_on', effortMode: 'low', voiceAsr: { enabled: false } },
    speak: { defaultGroupMode: 'passive', privateMode: 'passive', groupModes: {}, active: {} },
  }), botId);
  fb.resetCooldown();
  stub.calls.length = 0;
  client.sent.length = 0;
  await worker.onMessage(grp(GROUP, USER, [atSeg, { type: 'record', data: { file: 'x.amr', url: '' } }]));
  const offPool = fb.listFor(botId, 'voice').map((x) => x.text);
  check('关闭识别时：语音条走语音兜底', offPool.includes(client.sent[0]?.text ?? ''), JSON.stringify(client.sent));
  check('关闭识别时：不调模型', stub.calls.length === 0);

  // 打开识别：应转成文字并交给模型
  db.run('update bots set settings = ? where id = ?', JSON.stringify({
    api: { mode: 'force_on', effortMode: 'low', voiceAsr: { enabled: true } },
    speak: { defaultGroupMode: 'passive', privateMode: 'passive', groupModes: {}, active: {} },
  }), botId);
  fb.resetCooldown();
  stub.calls.length = 0;
  client.sent.length = 0;
  const t0 = Date.now();
  await worker.onMessage(grp(GROUP, USER, [atSeg, { type: 'record', data: { file: 'x.amr', url: '' } }]));
  const asrMs = Date.now() - t0;

  if (stub.calls.length === 0) {
    // 兜底被触发，说明识别没成功——把失败原因带出来
    const last = db.all("select flags, text from messages where bot_id = ? order by id desc limit 1", botId)[0];
    check('打开识别时：成功转写并调用模型', false,
      '模型未被调用；最后入库消息 = ' + JSON.stringify(last) + '；收到回复 = ' + JSON.stringify(client.sent));
  } else {
    const call = stub.calls.at(-1);
    check('打开识别时：成功转写并调用模型', true);
    check('识别文字并入消息传给模型', call.tail.includes('线性'), call.tail.slice(-200));
    check('消息带语音标记', call.tail.includes('[语音]'), call.tail.slice(-200));
    check('历史里存的是转写后的文字', db.all("select text from messages where bot_id = ? and role = 'user' order by id desc limit 1", botId)[0].text.includes('线性'));
    console.log(`     整链耗时 ${asrMs}ms，模型看到的消息：${call.tail.split('〔他说〕')[1]?.slice(0, 80) ?? ''}`);
  }
  try { fs.unlinkSync(voiceFile); } catch { /* 忽略 */ }
}

// ============ 素材与提问分两条发 ============
console.log('--- 分条发送的素材承接 ---');
db.run('update bots set settings = ? where id = ?', JSON.stringify({
  api: { mode: 'force_on', effortMode: 'low', voiceAsr: { enabled: true } },
  speak: { defaultGroupMode: 'passive', privateMode: 'passive', groupModes: {}, active: {} },
}), botId);

// 造一张 1x1 的合法 PNG 存到本地
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const imgPath = path.join(TMP_DIR, 'test-image.png');
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.writeFileSync(imgPath, Buffer.from(TINY_PNG, 'base64'));

// 1) 先只发图（没有 @，不该触发），再发 @ + 提问
rate.reset();
stub.calls.length = 0;
client.sent.length = 0;
await worker.onMessage(grp(GROUP, USER, [{ type: 'image', data: { url: imgPath, file: imgPath } }]));
check('只发图不提及：不回复', client.sent.length === 0, JSON.stringify(client.sent));
check('只发图不提及：不调模型', stub.calls.length === 0);

// 图片要落库：聊天记录靠 media 显示图片，靠 text 里的占位知道「他发过一张图」。
// 早先两者都没有，纯图消息在聊天记录里就是一条空白。
const imgRow = db.one(
  "select text, flags, media from messages where bot_id = ? and role = 'user' order by id desc limit 1", botId);
check('纯图：正文留下 [图片] 占位', imgRow?.text === '[图片]', JSON.stringify(imgRow?.text));
check('纯图：media 里存了图片地址',
  Array.isArray(history.parseMedia(imgRow)) && history.parseMedia(imgRow)[0]?.url === imgPath,
  JSON.stringify(imgRow?.media));
check('纯图：flags 仍标 image', String(imgRow?.flags ?? '').includes('image'), String(imgRow?.flags));

rate.reset();
stub.calls.length = 0;
client.sent.length = 0;
await worker.onMessage(grp(GROUP, USER, [atSeg, txt('这张图里的字是什么')]));
const imgCall = stub.calls.at(-1);
check('下一条提问会带上前面的图', stub.calls.length === 1 && Array.isArray(imgCall.tail), typeof imgCall.tail);
check('tail 里确实有图片数据',
  Array.isArray(imgCall.tail) && imgCall.tail.some((x) => x.type === 'image_url' && String(x.image_url?.url).startsWith('data:image/')),
  JSON.stringify(Array.isArray(imgCall.tail) ? imgCall.tail.map((x) => x.type) : imgCall.tail).slice(0, 120));
check('文字部分说明了素材来自上一条',
  Array.isArray(imgCall.tail) && String(imgCall.tail[0]?.text).includes('先发了图片'),
  Array.isArray(imgCall.tail) ? String(imgCall.tail[0]?.text).slice(-120) : '');

// tail 在带图片时会变成内容数组，取文字部分用这个
const tailText = (t) => (Array.isArray(t) ? String(t[0]?.text ?? '') : String(t ?? ''));

// 2) 先只发语音（没有 @），再只发一个 @
// 这一段同时要两样东西：样音（语音要被识别）+ 识别服务（上一条转写成文字，@ 才能承接）。
// 缺哪样都跳过 —— clone 下来的人不该因为没素材或没起服务就看见整套红。
const SAMPLE_WAV = path.join(ROOT, 'style-samples', 'wav', 'p02.wav');
let shortVoice = '';
if (!fs.existsSync(SAMPLE_WAV) || !asrUp.ok) {
  console.log('  ⚠ ' + (asrUp.ok ? '缺样音 ' + SAMPLE_WAV : '识别服务未在线') + '，跳过「语音条承接」这一段');
  check('语音条承接（条件不具备则跳过）', true);
} else {
  rate.reset();
  stub.calls.length = 0;
  client.sent.length = 0;
  shortVoice = path.join(TMP_DIR, 'test-voice2.wav');
  fs.copyFileSync(makeShortWav(16, 22), shortVoice);
  await worker.onMessage(grp(GROUP, USER, [{ type: 'record', data: { file: shortVoice } }]));
  check('只发语音不提及：不回复', client.sent.length === 0, JSON.stringify(client.sent));

  rate.reset();
  stub.calls.length = 0;
  client.sent.length = 0;
  await worker.onMessage(grp(GROUP, USER, [atSeg]));
  check('光发一个 @ 会接上一条的内容', stub.calls.length === 1 && tailText(stub.calls[0].tail).includes('线性'),
    tailText(stub.calls.at(-1)?.tail).slice(-140));
  check('并说明这是承接上一条', tailText(stub.calls[0].tail).includes('补充说明'),
    tailText(stub.calls.at(-1)?.tail).slice(-160));
  check('语音那条不该把两步之前的图也带过来', !Array.isArray(stub.calls[0].tail),
    JSON.stringify(Array.isArray(stub.calls[0].tail) ? stub.calls[0].tail.map((x) => x.type) : ''));
}

// 3) 合并转发
client.getForwardMsg = async () => ({
  messages: [
    { sender: { nickname: '张三' }, message: [{ type: 'text', data: { text: '第一句话' } }] },
    { sender: { nickname: '李四' }, message: [{ type: 'text', data: { text: '第二句话' } }, { type: 'image', data: {} }] },
    { sender: { nickname: '王五' }, message: [{ type: 'record', data: {} }] },
  ],
});
db.run('update bots set settings = ? where id = ?', JSON.stringify({
  api: { mode: 'force_on', effortMode: 'low' },
  speak: { defaultGroupMode: 'passive', privateMode: 'passive', groupModes: {}, active: {} },
}), botId);
rate.reset();
stub.calls.length = 0;
client.sent.length = 0;
await worker.onMessage(grp(GROUP, USER, [atSeg, { type: 'forward', data: { id: 'fwd-1' } }]));
const fwdTail = tailText(stub.calls.at(-1)?.tail);
check('转发的聊天记录被读出来', fwdTail.includes('张三：第一句话') && fwdTail.includes('李四：第二句话'), fwdTail.slice(-200));
check('转发里的图片有占位', fwdTail.includes('[图片]'));
check('转发里的语音有占位', fwdTail.includes('[语音]'));
check('模型确实收到了转发内容', stub.calls.length === 1);
// 那次没开视觉，所以不带图片附件，但要说明转发里有几张图
// （那张图是 { data: {} }，没有地址，所以读不到——总数仍要报出来）
check('说明里报了转发里有 1 张图', fwdTail.includes('带了 1 张图'), fwdTail.slice(-180));
check('读不到时如实说明', fwdTail.includes('一张都没能取到'), fwdTail.slice(-180));
check('没开视觉时不带图片附件', !Array.isArray(stub.calls[0].tail), typeof stub.calls[0].tail);

// 4) 转发里的图片送去识别：只读前 N 张，N 由设置定
console.log('--- 转发里的图片 ---');
const fwdImgNodes = (n, url) => Array.from({ length: n }, (_, i) => ({
  sender: { nickname: '李四' }, message: [{ type: 'image', data: { url } }],
}));
client.getForwardMsg = async () => ({
  messages: [
    { sender: { nickname: '张三' }, message: [{ type: 'text', data: { text: '这几张你看看' } }] },
    ...fwdImgNodes(5, imgPath),
  ],
});
const setVision = (forwardMaxImages) => db.run('update bots set settings = ? where id = ?', JSON.stringify({
  api: { mode: 'force_on', effortMode: 'low', vision: { enabled: true, detail: 'low', perHourLimit: 60, forwardMaxImages } },
  speak: { defaultGroupMode: 'passive', privateMode: 'passive', groupModes: {}, active: {} },
}), botId);

setVision(3);
rate.reset();
stub.calls.length = 0;
client.sent.length = 0;
await worker.onMessage(grp(GROUP, USER, [atSeg, { type: 'forward', data: { id: 'fwd-img' } }]));
const fwdImgTail = stub.calls.at(-1)?.tail;
const fwdImgsAttached = Array.isArray(fwdImgTail)
  ? fwdImgTail.filter((x) => x.type === 'image_url').length : 0;
check('转发里的图被送去识别了', fwdImgsAttached === 3, String(fwdImgsAttached));
check('按上限只读前 3 张（转发里共 5 张）',
  Array.isArray(fwdImgTail) && fwdImgTail.filter((x) => x.type === 'image_url').length === 3,
  JSON.stringify(Array.isArray(fwdImgTail) ? fwdImgTail.map((x) => x.type) : fwdImgTail));
check('说明里报了总数 5 张', tailText(fwdImgTail).includes('带了 5 张图'), tailText(fwdImgTail).slice(-160));
check('说明了读到几张（3 张）', tailText(fwdImgTail).includes('其中 3 张'), tailText(fwdImgTail).slice(-160));
check('转发文字照旧读出来', tailText(fwdImgTail).includes('张三：这几张你看看'));

// 不足上限就全读
setVision(8);
rate.reset();
stub.calls.length = 0;
await worker.onMessage(grp(GROUP, USER, [atSeg, { type: 'forward', data: { id: 'fwd-img2' } }]));
const allRead = Array.isArray(stub.calls.at(-1)?.tail)
  ? stub.calls.at(-1).tail.filter((x) => x.type === 'image_url').length : 0;
check('不足上限时全部读完（5 张）', allRead === 5, String(allRead));

// 设 0 = 不读转发里的图
setVision(0);
rate.reset();
stub.calls.length = 0;
await worker.onMessage(grp(GROUP, USER, [atSeg, { type: 'forward', data: { id: 'fwd-img3' } }]));
const zeroTail = stub.calls.at(-1)?.tail;
check('设 0 时一张也不读', !Array.isArray(zeroTail), typeof zeroTail);
check('设 0 时仍说明转发里有几张图',
  tailText(zeroTail).includes('带了 5 张图'), tailText(zeroTail).slice(-160));

// 关掉视觉总开关同样不读
setVision(8);
db.run('update bots set settings = ? where id = ?', JSON.stringify({
  api: { mode: 'force_on', effortMode: 'low', vision: { enabled: false, forwardMaxImages: 8 } },
  speak: { defaultGroupMode: 'passive', privateMode: 'passive', groupModes: {}, active: {} },
}), botId);
rate.reset();
stub.calls.length = 0;
await worker.onMessage(grp(GROUP, USER, [atSeg, { type: 'forward', data: { id: 'fwd-img4' } }]));
check('视觉总开关关掉后不读转发里的图', !Array.isArray(stub.calls.at(-1)?.tail));


// 4) 借用的边界：纯粹发个视频 @ 一下，不该把上一条的文字算进来
rate.reset();
stub.calls.length = 0;
client.sent.length = 0;
fb.resetCooldown();
await worker.onMessage(grp(GROUP, USER, [atSeg, { type: 'video', data: {} }]));
const vidPool2 = fb.listFor(botId, 'video').map((x) => x.text);
check('纯视频仍然走兜底（不被上一条文字污染）',
  vidPool2.includes(client.sent[0]?.text ?? ''), JSON.stringify(client.sent));
check('纯视频不走模型', stub.calls.length === 0);

try { fs.unlinkSync(imgPath); fs.unlinkSync(shortVoice); } catch { /* 忽略 */ }

// ============ 昵称别名与图片档位 ============
console.log('--- 别名与清晰度 ---');
rate.reset();
stub.calls.length = 0;
client.sent.length = 0;
await worker.onMessage(grp(GROUP, USER, [txt('小向 在吗')]));
check('叫昵称本身能触发', stub.calls.length === 1, String(stub.calls.length));

// 「向老师」不在昵称里，默认不该触发
rate.reset();
stub.calls.length = 0;
client.sent.length = 0;
await worker.onMessage(grp(GROUP, USER, [txt('向老师 在吗')]));
check('别名没配时不触发', stub.calls.length === 0, String(stub.calls.length));

// 配上别名后应该能触发
const withAlias = JSON.parse(db.getBot(botId).settings);
withAlias.speak.aliases = ['向老师'];
db.run('update bots set settings = ? where id = ?', JSON.stringify(withAlias), botId);
rate.reset();
stub.calls.length = 0;
client.sent.length = 0;
await worker.onMessage(grp(GROUP, USER, [txt('向老师 在吗')]));
check('配上别名后能触发', stub.calls.length === 1, String(stub.calls.length));
withAlias.speak.aliases = [];
db.run('update bots set settings = ? where id = ?', JSON.stringify(withAlias), botId);
check('默认别名列表为空', Array.isArray(defaultBotSettings().speak.aliases)
  && defaultBotSettings().speak.aliases.length === 0);

check('认字场景自动用高清', pickImageDetail('这张图里的字是什么') === 'high');
check('看图不带认字意图用低清', pickImageDetail('这张图好看吗') === 'low');
check('用户设了 low 就听用户的', pickImageDetail('图里的字', 'low') === 'low');
check('用户设了 high 就听用户的', pickImageDetail('好看吗', 'high') === 'high');
check('默认档是 auto', defaultBotSettings().api.vision.detail === 'auto');

// ============ 输出清洗 ============
console.log('--- 输出清洗 ---');
check('去包裹引号', normalizeReply('"你好啊"') === '你好啊');
check('去书名号包裹', normalizeReply('「你好啊」') === '你好啊');
check('pass 标记 → 空', normalizeReply('<pass>') === '');
check('纯旁白 → 空', normalizeReply('（沉默）') === '');
check('代码块剥离', normalizeReply('```\n你好\n```') === '你好');
check('正常文本原样', normalizeReply('我们来看这个问题') === '我们来看这个问题');

// ============ 真实 API 集成（唯一依赖线上的一条）============
console.log('--- 真实 API 集成 ---');
const realStub = makeStub();
const realWorker = new BotWorker({ bot: db.getBot(botId), client, chatFn: null });
await realWorker.onReady(BOT_QQ);
const before = client.sent.length;
await realWorker.onMessage(priv(USER, '小向 在吗'));
const realReply = client.sent.slice(before).map((x) => x.text).join('');
if (!realReply) {
  console.log('  ⚠ 真实 API 未返回（lastError=' + realWorker.lastError + '）—— 网络或配额问题，非逻辑问题');
  check('真实 API 集成（网络不通则跳过）', true);
} else {
  check('真实 API 返回了非空回复', realReply.length > 0);
  check('回复不含 pass 标记', !realReply.includes('<pass>'));
  console.log('     真实回复：', realReply);
  console.log('     本次用量：', JSON.stringify(llm.usageSummary(botId).calls) + ' 次调用, 命中率 ' +
    (llm.usageSummary(botId).hitRate * 100).toFixed(1) + '%');
}

// ============ @ 指名命令：群里只有被点到的那个号响应 ============
//
// 放在最后：要新建一个机器人来凑出「群里有多个号」的局面，
// 而 selfQqs 是构造 worker 时抓的，所以必须用新 worker 测。
console.log('--- @ 指名命令 ---');
const SECOND_QQ = '30003';
db.createBot('第二台', SECOND_QQ);
const client2 = makeFakeClient();
const worker2 = new BotWorker({ bot: db.getBot(botId), client: client2, chatFn: (p) => stub.chat(p) });
await worker2.onReady(BOT_QQ);
check('两个机器人都在自己人名单里（用于判断 @ 的是不是机器人）',
  worker2.selfQqs.has(BOT_QQ) && worker2.selfQqs.has(SECOND_QQ),
  JSON.stringify([...worker2.selfQqs]));

rate.reset(); fb.resetCooldown();
client2.sent.length = 0;
await worker2.onMessage(grp(GROUP, USER, [atOther(SECOND_QQ), txt(' /help')]));
check('@ 指名别的机器人：本号完全沉默', client2.sent.length === 0, JSON.stringify(client2.sent));

rate.reset(); fb.resetCooldown();
client2.sent.length = 0;
await worker2.onMessage(grp(GROUP, USER, [atOther(BOT_QQ), txt(' /help')]));
check('@ 指名本号：照常响应', client2.sent.length === 1, JSON.stringify(client2.sent));
check('响应内容是帮助文本',
  String(client2.sent[0]?.text ?? '').includes('我能听懂这几个口令'),
  String(client2.sent[0]?.text).slice(0, 60));

// 不指名 = 不限定执行者（原有的行为保留）
rate.reset(); fb.resetCooldown();
client2.sent.length = 0;
await worker2.onMessage(grp(GROUP, USER, [txt('/help')]));
check('不指名任何机器人：本号仍然响应', client2.sent.length === 1, JSON.stringify(client2.sent));

// @ 真人不是指名——那条消息本来就不是给机器人的命令
rate.reset(); fb.resetCooldown();
client2.sent.length = 0;
await worker2.onMessage(grp(GROUP, USER, [atOther('888888'), txt(' /help')]));
check('@ 真人后跟命令：仍按原有行为响应（不算指名）', client2.sent.length === 1, JSON.stringify(client2.sent));

// 指名本号 + 后面再 @ 另一个号 → 后面的当参数，不影响路由
rate.reset(); fb.resetCooldown();
client2.sent.length = 0;
await worker2.onMessage(grp(GROUP, USER, [atOther(BOT_QQ), txt(' /spendtrend '), atOther(SECOND_QQ)]));
check('指名本号 + 参数里带 @：本号响应', client2.sent.length === 1, JSON.stringify(client2.sent));
check('/spendtrend 回复里带了趋势',
  /花费趋势/.test(String(client2.sent[0]?.text ?? '')), String(client2.sent[0]?.text).slice(0, 80));

// ============ AI 互聊（/talk） ============
//
// 放在最后，理由同上一节：要新建机器人、要用新 worker。
// ⚠️ 开关存在**全局配置**里（全机共享），所以测试前后必须原样恢复。
console.log('--- AI 互聊 ---');
const savedTalk = JSON.parse(JSON.stringify(loadGlobal().talk ?? {}));
const botMsgCount = (flag) => db.all(
  `select 1 from messages where bot_id = ? and flags like ?`, botId, `%${flag}%`).length;
// 出问题时把可疑的行打出来，别只报个数字
const frombotRows = () => db.all(
  `select sender_qq, text, flags from messages where bot_id = ? and flags like '%frombot%'`, botId)
  .map((r) => `${r.sender_qq}:${r.text}`).join(' | ');

try {
  // 关着：另一个机器人的话当它不存在（这是原有行为，不能被弄坏）
  saveGlobal({ talk: { enabled: false } });
  talk.resetGaps();
  rate.reset(); fb.resetCooldown();
  const fbBefore = botMsgCount('frombot');
  if (fbBefore) console.log('  （进这节之前库里已有 frombot 行：' + frombotRows() + '）');
  client2.sent.length = 0;
  stub.calls.length = 0;
  await worker2.onMessage(grp(GROUP, SECOND_QQ, [txt('我是另一个机器人')]));
  check('互聊关着：不响应另一个机器人', client2.sent.length === 0, JSON.stringify(client2.sent));
  check('互聊关着：不调模型', stub.calls.length === 0, String(stub.calls.length));
  check('互聊关着：连历史都不记（当它不存在）', botMsgCount('frombot') === fbBefore,
    `多出的行：${frombotRows()}`);

  // 打开：接话，并把对方的话记进历史
  saveGlobal({ talk: { enabled: true, minGapMs: 1, maxChain: 3 } });
  talk.resetGaps();
  rate.reset(); fb.resetCooldown();
  client2.sent.length = 0;
  stub.calls.length = 0;
  await worker2.onMessage(grp(GROUP, SECOND_QQ, [txt('我今天有点困')]));
  check('互聊开着：会接另一个机器人的话', client2.sent.length >= 1, JSON.stringify(client2.sent));
  check('互聊开着：对方的话进了历史（带 frombot 标记）', botMsgCount('frombot') === fbBefore + 1,
    `期望 +1，实际 ${botMsgCount('frombot') - fbBefore}；库里的行：${frombotRows()}`);
  check('互聊开着：自己说的也进了历史',
    db.one("select count(*) as n from messages where bot_id = ? and role = 'bot'", botId).n > 0);
  check('互聊开着：对方的话进了模型的上下文',
    stub.calls.length >= 1 && tailText(stub.calls.at(-1)?.tail).includes('我今天有点困'),
    tailText(stub.calls.at(-1)?.tail).slice(-120));

  // 刹车：连续几条都是机器人在说就停
  saveGlobal({ talk: { enabled: true, minGapMs: 1, maxChain: 3 } });
  talk.resetGaps();
  rate.reset(); fb.resetCooldown();
  client2.sent.length = 0;
  let blocked = false;
  for (let i = 0; i < 6; i++) {
    await worker2.onMessage(grp(GROUP, SECOND_QQ, [txt(`机器人第 ${i + 1} 句`)]));
    const chain = history.botChainLength(botId, db.ensureSession(botId, 'group', GROUP).id);
    if (chain >= 3 && client2.sent.length === 0) { blocked = true; break; }
  }
  check('连续到上限后停下（不会无限对聊）', blocked, `chain 上限内一直没停，已发 ${client2.sent.length} 条`);

  // 真人一开口，链子断开，又能聊
  rate.reset(); fb.resetCooldown();
  client2.sent.length = 0;
  await worker2.onMessage(grp(GROUP, USER, [atOther(BOT_QQ), txt(' 你们俩聊什么呢')]));
  const afterHuman = history.botChainLength(botId, db.ensureSession(botId, 'group', GROUP).id);
  check('真人说话把连续计数断开', afterHuman <= 1, String(afterHuman));
  client2.sent.length = 0;
  await worker2.onMessage(grp(GROUP, SECOND_QQ, [txt('我们聊数学呢')]));
  check('断开之后又能接话', client2.sent.length >= 1, JSON.stringify(client2.sent));

  // 私聊里不搞互聊
  rate.reset(); fb.resetCooldown();
  client2.sent.length = 0;
  await worker2.onMessage(priv(SECOND_QQ, '你好'));
  check('互聊只在群里生效（私聊不接）', client2.sent.length === 0, JSON.stringify(client2.sent));
} finally {
  // 恢复时**强制把开关关掉**，只把数值还原。
  // 早先这里是「原样恢复成测试前的值」——如果那个值本身已经被上一次运行弄脏了，
  // 错误就会一直继承下去，而「恢复成功」的相等断言还照样通过。
  // 2026-09-23 真的把生产配置留成了 enabled:true，所以改成这个写法：
  // 数值照旧还回去，开关永远回到关。
  if (savedTalk.enabled === true) {
    console.log('  ⚠️ 测试开始前 talk 就是开着的，恢复时强制关掉（不会把生产配置留在互聊模式）');
  }
  saveGlobal({ talk: { ...savedTalk, enabled: false } });
  talk.resetGaps();
}
check('测试后 talk 一定是关的（绝不把生产配置留在互聊模式）',
  loadGlobal().talk.enabled === false, JSON.stringify(loadGlobal().talk));
check('测试后数值还原成功',
  loadGlobal().talk.minGapMs === (savedTalk.minGapMs ?? 1500)
  && loadGlobal().talk.maxChain === (savedTalk.maxChain ?? 6),
  JSON.stringify(loadGlobal().talk));

// ============ 网上素材（段子）============
//
// 测试一律不碰网络：这里只验「开关短路」和「素材怎么呈现给模型」，
// 真去抓一条是 verify 脚本干的事。
console.log('--- 网上素材 ---');
const baseSettings = defaultBotSettings();
check('默认不开',
  (await worker2.maybeFetchJoke({ textClean: '来个段子' }, baseSettings, 'passive')) === null);

const onNotAsked = defaultBotSettings();
onNotAsked.api.webJokes = { enabled: true, randomRate: 0 };
check('开了但没人要、随机率 0：不抓（不碰网络）',
  (await worker2.maybeFetchJoke({ textClean: '今天天气不错' }, onNotAsked, 'active')) === null);

// 呈现方式：直接调 buildTail，喂一条假素材
const tailBase = {
  msg: { kind: 'group', senderName: '张三', textClean: '来个段子' },
  personId: null, settings: baseSettings, trigger: 'passive', echoCandidate: null, hasImages: false,
};
const tailWith = worker2.buildTail({ ...tailBase, joke: { ok: true, text: '鱼和熊掌不可兼得，除非加钱。', from: '网友' } });
check('素材写进了提示词', tailWith.includes('鱼和熊掌不可兼得'), tailWith.slice(-200));
check('标了出处是网友', tailWith.includes('网友'), tailWith.slice(-200));
check('提醒别原样念出处', tailWith.includes('别原样念出处'), tailWith.slice(-220));
check('提醒不搭就别硬塞', tailWith.includes('别硬塞'), tailWith.slice(-220));
const tailNo = worker2.buildTail({ ...tailBase, joke: null });
check('没素材时不出现那一段', !tailNo.includes('网上刚刷到'), tailNo.slice(-160));
const tailBad = worker2.buildTail({ ...tailBase, joke: { ok: false, reason: '没取到' } });
check('抓失败时不出现那一段（失败不影响回复）', !tailBad.includes('网上刚刷到'), tailBad.slice(-160));

// 两档字数目标都写进提示词
const sLen = defaultBotSettings();
sLen.speak.replyMaxChars = 30;
sLen.speak.replyMaxCharsDetailed = 222;
const sysLen = personaMod.buildSystemPrompt(botId, { botName: '小向', settings: sLen });
check('闲聊字数目标写进去了', sysLen.includes('30 字'), sysLen.slice(sysLen.indexOf('【篇幅】'), sysLen.indexOf('【篇幅】') + 200));
check('讲题字数目标也写进去了', sysLen.includes('222 字'),
  sysLen.slice(sysLen.indexOf('【篇幅】'), sysLen.indexOf('【篇幅】') + 240));
check('明确要求给具体例子', sysLen.includes('具体的数'), sysLen.slice(sysLen.indexOf('【篇幅】'), sysLen.indexOf('【篇幅】') + 320));

// ============ 一次发多条 + 间隔 ============
//
// 用户要的是「模型返回一长串句子 → 本地拆成多条、每条装几句话（可调）」，
// 所以要验：真拆了、每条句数受控、条与条之间按设置停顿。
console.log('--- 一次发多条 + 分条间隔 ---');
const FIVE = '笑死我了。这也太抽象了吧。你从哪找的这玩意儿。我上周也遇到一个。真的绷不住。';
const multiStub = makeStub(FIVE);
const mw = new BotWorker({ bot: db.getBot(botId), client, chatFn: (p) => multiStub.chat(p) });
await mw.onReady(BOT_QQ);
const setMulti = (maxSentences, segmentDelayMs) => db.run(
  'update bots set settings = ? where id = ?', JSON.stringify({
    api: { mode: 'force_on', effortMode: 'low' },
    speak: {
      defaultGroupMode: 'passive', privateMode: 'passive', groupModes: {}, active: {},
      replyMaxChars: 40, maxSentences, maxSentencesDetailed: maxSentences,
      maxMessages: 5, segmentDelayMs,
    },
  }), botId);

// 每条 2 句：5 句 → 3 条（2+2+1）
setMulti(2, 150);
rate.reset(); fb.resetCooldown();
client.sent.length = 0;
let t0 = Date.now();
await mw.onMessage(grp(GROUP, USER, [atSeg, txt(' 说点什么')]));
const elapsed = Date.now() - t0;
const parts = client.sent.map((x) => x.text);
check('5 句、每条 2 句 → 发 3 条', parts.length === 3, JSON.stringify(parts));
check('每条不超过 2 句',
  parts.every((t) => speakingMod.splitSentences(t).length <= 2), JSON.stringify(parts));
check('分条内容不丢', parts.join('') === FIVE, parts.join(''));
check('条与条之间按设置停顿（2 个间隔 × 150ms）', elapsed >= 280, `实际 ${elapsed}ms`);
console.log(`     5 句 → ${parts.length} 条，实测总耗时 ${elapsed}ms`);

// 每条 3 句：5 句 → 2 条（3+2）
setMulti(3, 0);
multiStub.calls.length = 0;
rate.reset(); fb.resetCooldown();
client.sent.length = 0;
await mw.onMessage(grp(GROUP, USER, [atSeg, txt(' 再来一个')]));
const parts3 = client.sent.map((x) => x.text);
check('每条 3 句 → 发 2 条', parts3.length === 2, JSON.stringify(parts3));
check('每条 3 句时每条确实装了 3 句',
  speakingMod.splitSentences(parts3[0] ?? '').length === 3, JSON.stringify(parts3));

// 间隔设 0 就不该等
setMulti(3, 0);
multiStub.calls.length = 0;
rate.reset(); fb.resetCooldown();
client.sent.length = 0;
t0 = Date.now();
await mw.onMessage(grp(GROUP, USER, [atSeg, txt(' 第三个')]));
const fast = Date.now() - t0;
check('间隔设 0：几乎不等', fast < 250, `${fast}ms`);
check('间隔设 0：仍分多条发', client.sent.length === 2, JSON.stringify(client.sent.map((x) => x.text)));

// ============ 四档语音输出 ============
//
// 四档：text 只发文字 / voice 全语音 / prob 按概率 / ai 由模型自己决定（第一行写 [语音]）。
// 语音这条路上最容易错的是「发出去的段不是 record」和「文件被提前删了」，
// 所以这里会真的合成一条（本地、不花钱，约 11 秒）并检查发给 NapCat 的原始段。
console.log('--- 四档语音输出 ---');
const setVoice = (voice) => db.run('update bots set settings = ? where id = ?', JSON.stringify({
  api: { mode: 'force_on', effortMode: 'low' },
  speak: {
    defaultGroupMode: 'passive', privateMode: 'passive', groupModes: {}, active: {},
    voice,
  },
}), botId);
const lastSeg = () => client.sent[client.sent.length - 1]?.segs?.[0];
const lastBotText = () =>
  db.one("select text from messages where bot_id = ? and role = 'bot' order by id desc limit 1", botId)?.text ?? '';

const voiceStub = makeStub('我们来看这个问题');
const vw = new BotWorker({ bot: db.getBot(botId), client, chatFn: (p) => voiceStub.chat(p) });
await vw.onReady(BOT_QQ);

// 文字档（默认）：不能因为开了语音功能就改变原来的行为
setVoice({ mode: 'text' });
rate.reset(); fb.resetCooldown();
client.sent.length = 0;
await vw.onMessage(priv(USER, '你好'));
check('文字档还是发文字', lastSeg()?.type === 'text', JSON.stringify(lastSeg()));
const textModeTail = tailText(voiceStub.calls.at(-1)?.tail);

// 语音档：真的合成一条发出去
setVoice({ mode: 'voice', maxMessages: 2, maxChars: 26, perHour: 20 });
rate.reset(); fb.resetCooldown();
client.sent.length = 0;
await vw.onMessage(priv(USER, '在吗'));
const vseg = lastSeg();
check('语音档发的是 record 段', vseg?.type === 'record', JSON.stringify(client.sent));
check('record 用的是 file:// 加正斜杠', String(vseg?.data?.file ?? '').startsWith('file:///') && !String(vseg?.data?.file).includes('\\'), String(vseg?.data?.file));
const wavPath = decodeURIComponent(String(vseg?.data?.file ?? '').replace(/^file:\/\/\//, ''));
check('合成出来的 wav 还在（NapCat 要靠它读）', fs.existsSync(wavPath), wavPath);
if (fs.existsSync(wavPath)) {
  check('是 wav（RIFF 头）', fs.readFileSync(wavPath).subarray(0, 4).toString('ascii') === 'RIFF');
  check('时长合理', fs.statSync(wavPath).size > 8000 && fs.statSync(wavPath).size < 26 * 32000 * 3, String(fs.statSync(wavPath).size));
}
// 入库**不带**记号：带过前缀，模型就学会往正文里写 [语音]（2026-09-24 真事故）。
// 记号只写在日志里给人看，模型看到的和日志是分开的。
check('入库不带记号（免得模型学会它）', lastBotText() === '我们来看这个问题', lastBotText());

// 太长的回答不硬塞进语音（一条 11 秒，十条没人等）
setVoice({ mode: 'voice', maxMessages: 2, maxChars: 26 });
const longStub = makeStub('线性代数里有三种主要的变换，第一种是初等行变换，第二种是初等列变换，第三种是矩阵的相似变换，它们的区别在于作用的对象不同。');
const lw = new BotWorker({ bot: db.getBot(botId), client, chatFn: (p) => longStub.chat(p) });
await lw.onReady(BOT_QQ);
rate.reset(); fb.resetCooldown();
client.sent.length = 0;
await lw.onMessage(priv(USER, '随便说点什么'));
check('长回答退回文字', client.sent.every((x) => x.segs[0]?.type === 'text'), JSON.stringify(client.sent.map((x) => x.segs[0]?.type)));

// 讲题也走文字：语音念一遍记不住，而且要能回头翻
setVoice({ mode: 'voice', maxMessages: 2, maxChars: 26 });
rate.reset(); fb.resetCooldown();
client.sent.length = 0;
await vw.onMessage(priv(USER, '为什么矩阵可以这样乘'));
check('讲题走文字（虽然开了语音档）', lastSeg()?.type === 'text', JSON.stringify(lastSeg()));

// 概率档：prob=1 必发，prob=0 必不发
setVoice({ mode: 'prob', prob: 0 });
rate.reset(); fb.resetCooldown();
client.sent.length = 0;
await vw.onMessage(priv(USER, '概率零'));
check('prob=0 不发语音', lastSeg()?.type === 'text', JSON.stringify(lastSeg()));

// ai 档：模型自己写 [语音] 就发语音，且记号不能念出来
setVoice({ mode: 'ai', maxMessages: 2, maxChars: 26 });
const aiStub = makeStub('[语音] 好，我们继续');
const aw = new BotWorker({ bot: db.getBot(botId), client, chatFn: (p) => aiStub.chat(p) });
await aw.onReady(BOT_QQ);
rate.reset(); fb.resetCooldown();
client.sent.length = 0;
await aw.onMessage(priv(USER, '继续讲'));
check('ai 档写了记号就发语音', lastSeg()?.type === 'record', JSON.stringify(lastSeg()));
check('记号被剥掉，只念说话内容；入库也不带记号',
  lastBotText() === '好，我们继续', JSON.stringify(lastBotText()));
check('ai 档的提示词里说明了语音怎么写', tailText(aiStub.calls.at(-1)?.tail).includes('〔语音〕'), tailText(aiStub.calls.at(-1)?.tail).slice(-120));

// 记号写在句子中间（2026-09-24 真实事故：只在开头剥，那个 [语音] 原样发到群里了）
const aiStub3 = makeStub('海浪会来，生活总会继续。  [语音] 你那半份作业也继续一下。');
const aw3 = new BotWorker({ bot: db.getBot(botId), client, chatFn: (p) => aiStub3.chat(p) });
await aw3.onReady(BOT_QQ);
rate.reset(); fb.resetCooldown();
client.sent.length = 0;
await aw3.onMessage(priv(USER, '说两句'));
check('中间的记号也剥掉，不会原样发出去',
  !client.sent.some((x) => String(x.text).includes('语音')) && !lastBotText().includes('语音'),
  JSON.stringify({ sent: client.sent.map((x) => x.text), db: lastBotText() }));
check('剥掉中间记号后内容还在', lastBotText().includes('生活总会继续') && lastBotText().includes('半份作业'), lastBotText());

// 真实事故 2：模型用 〔语音〕（六角括号）打算念诗，记号没被认出来 → 整句当文字发进群
const aiStub4 = makeStub('〔语音〕君不见黄河之水天上来 奔流到海不复回');
const aw4 = new BotWorker({ bot: db.getBot(botId), client, chatFn: (p) => aiStub4.chat(p) });
await aw4.onReady(BOT_QQ);
rate.reset(); fb.resetCooldown();
client.sent.length = 0;
await aw4.onMessage(priv(USER, '猪咪念首诗'));
check('〔语音〕也当成要发语音（不再漏成文字）', lastSeg()?.type === 'record', JSON.stringify(client.sent.map((x) => x.segs[0]?.type)));
check('念出来的内容就是那句诗、不带记号', lastBotText() === '君不见黄河之水天上来 奔流到海不复回', JSON.stringify(lastBotText()));

// 真实事故 3：让人「朗读一下将进酒」，模型也写了记号，但整段 100 多字被
// 「一次最多 2 条」卡住 → 又当文字发了，群里说「我的意思是让你朗读出来」。
// 现在模型点名要语音时额度放宽到 4 条。
setVoice({ mode: 'ai', maxMessages: 2, maxMessagesForced: 4, maxChars: 26, perHour: 20 });
const longPoem = makeStub('〔语音〕君不见黄河之水天上来 奔流到海不复回 君不见高堂明镜悲白发 朝如青丝暮成雪 人生得意须尽欢 莫使金樽空对月');
const pw2 = new BotWorker({ bot: db.getBot(botId), client, chatFn: (p) => longPoem.chat(p) });
await pw2.onReady(BOT_QQ);
rate.reset(); fb.resetCooldown();
client.sent.length = 0;
await pw2.onMessage(priv(USER, '朗读一下将进酒'));
const poemTypes = client.sent.map((x) => x.segs[0]?.type);
check('点名要语音时整段诗都念出来', poemTypes.length >= 2 && poemTypes.every((t) => t === 'record'), JSON.stringify(poemTypes));
check('念诗时一条语音不超过字数上限', client.sent.length <= 4, String(client.sent.length));

// 一条回复要么整条语音、要么整条文字：配额只够一条时不许发一半
setVoice({ mode: 'voice', maxMessages: 2, maxChars: 26, perHour: 1 });
const twoPart = makeStub('前面这句话大概有这么长的一串字。后面这句话大概也有这么长的一串字。');
const tw = new BotWorker({ bot: db.getBot(botId), client, chatFn: (p) => twoPart.chat(p) });
await tw.onReady(BOT_QQ);
rate.reset(); fb.resetCooldown();
client.sent.length = 0;
await tw.onMessage(priv(USER, '来两句'));
const types = client.sent.map((x) => x.segs[0]?.type);
check('配额只够一条时不发一半（整条走文字）', types.length > 0 && types.every((t) => t === 'text'), JSON.stringify(types));
check('退回文字后两句都还在', client.sent.map((x) => x.text).join('').includes('后面这句话大概也有'), JSON.stringify(client.sent.map((x) => x.text)));

// 配额够两条时，两条都发语音（不能一条语音一条文字）
setVoice({ mode: 'voice', maxMessages: 2, maxChars: 26, perHour: 20 });
rate.reset(); fb.resetCooldown();
client.sent.length = 0;
await tw.onMessage(priv(USER, '再来两句'));
const types2 = client.sent.map((x) => x.segs[0]?.type);
check('配额够时整条都是语音（不混着发）', types2.length >= 1 && types2.every((t) => t === 'record'), JSON.stringify(types2));

// 配额用完：这一条退回文字，不能让回复整个消失
setVoice({ mode: 'voice', maxMessages: 2, maxChars: 26, perHour: 0 });
rate.reset(); fb.resetCooldown();
client.sent.length = 0;
await vw.onMessage(priv(USER, '配额为零'));
check('配额为 0 时退回文字', lastSeg()?.type === 'text', JSON.stringify(lastSeg()));
check('退回文字后内容没丢', client.sent.map((x) => x.text).join('') === '我们来看这个问题', JSON.stringify(client.sent.map((x) => x.text)));

// ai 档没写记号：老实发文字
const aiStub2 = makeStub('我随便说说');
const aw2 = new BotWorker({ bot: db.getBot(botId), client, chatFn: (p) => aiStub2.chat(p) });
await aw2.onReady(BOT_QQ);
rate.reset(); fb.resetCooldown();
client.sent.length = 0;
await aw2.onMessage(priv(USER, '再来一句'));
check('ai 档没记号就发文字', lastSeg()?.type === 'text', JSON.stringify(lastSeg()));
check('文字档的提示词里不提语音', !textModeTail.includes('〔语音〕'), textModeTail.slice(-120));

// 配额用完：这一条退回文字，不能让回复整个消失
setVoice({ mode: 'voice', maxMessages: 2, maxChars: 26, perHour: 0 });
rate.reset(); fb.resetCooldown();
client.sent.length = 0;
await vw.onMessage(priv(USER, '配额为零'));
check('配额为 0 时退回文字', lastSeg()?.type === 'text', JSON.stringify(lastSeg()));
check('退回文字后内容没丢', client.sent.map((x) => x.text).join('') === '我们来看这个问题', JSON.stringify(client.sent.map((x) => x.text)));

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
db.closeDb();
log.closeLogs();
process.exit(fail === 0 ? 0 : 1);
