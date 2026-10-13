// 端到端验证：让真实的 22 图转发走一遍，看模型能不能读懂图里的信息。
//
// 用真实转发 id（库里查到的），所以 get_forward_msg 和图片下载都是真的；
// 客户端是假的、数据库是测试库，不会往 QQ 发任何东西。
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, DATA_DIR } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as db from '../src/db.js';
import * as secrets from '../src/secrets.js';
import * as llm from '../src/llm.js';
import * as lists from '../src/modules/lists.js';
import * as persona from '../src/modules/persona.js';
import { saveBotSettings, loadGlobal } from '../src/config.js';
import { BotWorker } from '../src/pipeline.js';
import { OneBot } from '../src/onebot.js';

ensureDirs();
log.setDebug(false);

const global = loadGlobal();
const LIVE_BOT = 1;                     // 借用真实机器人的 API key（secrets 是全局的，只读）
const BOT_QQ = '3046116373';
const USER = '10000002';                // 示例号，跑之前改成你自己的
const GROUP = '555001';                 // 示例群号，跑之前改成你自己的

// ---------- 先在**生产库**里找一条真实的、带图的转发 ----------
db.openDb();
const live = db.one(
  `select m.msg_id, m.bot_id from messages m
   where m.bot_id = ? and m.flags like '%forward%' order by m.id desc limit 1`, LIVE_BOT);
if (!live) { console.log('生产库里没有转发记录，跳过'); db.closeDb(); process.exit(0); }
const liveMsgId = live.msg_id;
db.closeDb();

// 借真实 NapCat 把转发 id 查出来（只读）
const liveClient = new OneBot({ botId: LIVE_BOT, url: 'ws://127.0.0.1:3001', name: 'probe' });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('连接超时')), 12000);
  liveClient.on('ready', () => { clearTimeout(t); resolve(); });
  liveClient.connect();
});
const gotMsg = await liveClient.getMsg(liveMsgId);
const FORWARD_ID = (gotMsg.message ?? []).find((x) => x?.type === 'forward')?.data?.id;
liveClient.close();
if (!FORWARD_ID) { console.log('那条消息里没有 forward 段，跳过'); process.exit(0); }
console.log('用真实转发 id：' + FORWARD_ID);

// ---------- 再切到测试库跑流程 ----------
const TEST_DB = path.join(DATA_DIR, 'test10.sqlite');
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.unlinkSync(f); } catch { /* 忽略 */ }
}
db.openDb(TEST_DB);

// ---- 建测试机器人（id 借 1，好让 secrets 读到真 key）----
const botId = db.createBot('客服小向', BOT_QQ);
saveBotSettings(botId, {
  api: {
    mode: 'force_on', effortMode: 'low',
    vision: { enabled: true, detail: 'low', perHourLimit: 60, forwardMaxImages: 8 },
  },
  speak: { defaultGroupMode: 'passive', privateMode: 'passive', groupModes: {}, active: {} },
});
persona.upsertPersona(botId, {
  name: '测试人格',
  body: '【整体印象】\n一个说话很短的老师。看到别人转发的东西会随口点评一句，说明你看到了什么。\n\n【不会有的说法】\n不写长篇、不分点。',
  examples: [], params: {},
});
lists.addTarget(botId, 'group', 'accept', GROUP);
lists.addTarget(botId, 'user', 'accept', USER);
lists.addTarget(botId, 'user', 'reply', USER);

const key = secrets.getApiKey(botId);
console.log('API key：' + (key ? '已读到' : '❌ 没读到'));
console.log('');

const sent = [];
const client = {
  sent,
  async call() { throw new Error('假客户端没实现'); },
  async getForwardMsg(id) {                        // 真转发 → 让真 NapCat 去取
    const real = new OneBot({ botId: LIVE_BOT, url: 'ws://127.0.0.1:3001', name: 'fwd' });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('连接超时')), 12000);
      real.on('ready', () => { clearTimeout(t); resolve(); });
      real.connect();
    });
    try { return await real.getForwardMsg(id); } finally { real.close(); }
  },
  async sendTo(kind, peerId, message) {
    sent.push((message ?? []).map((s) => s?.data?.text ?? '').join(''));
    return { message_id: 'out-' + sent.length };
  },
  async deleteMsg() { return true; },
  async getLoginInfo() { return { user_id: Number(BOT_QQ), nickname: '小向' }; },
  async getRecord() { return { file: null, url: '' }; },
};

// 记录模型实际收到的图片张数
const calls = [];
const worker = new BotWorker({
  bot: db.getBot(botId),
  client,
  chatFn: async (p) => {
    const n = Array.isArray(p.tail) ? p.tail.filter((x) => x.type === 'image_url').length : 0;
    calls.push({ images: n, tail: p.tail });
    return llm.chat(p);
  },
});
await worker.onReady(BOT_QQ);

console.log('════ 发一段真实转发 + 一句「这里面有啥」════');
await worker.onMessage({
  post_type: 'message', message_type: 'group', group_id: Number(GROUP), user_id: Number(USER),
  message_id: 'in-fwd-probe', time: Math.floor(Date.now() / 1000),
  sender: { card: '跳蝻', nickname: 'tn', role: 'member' },
  message: [
    { type: 'at', data: { qq: BOT_QQ } },
    { type: 'text', data: { text: ' 这段聊天记录里都发了些啥' } },
    { type: 'forward', data: { id: FORWARD_ID } },
  ],
});

const call = calls.at(-1);
const text = Array.isArray(call?.tail)
  ? call.tail.filter((x) => x.type === 'text').map((x) => x.text).join('\n')
  : String(call?.tail ?? '');

console.log('');
console.log('模型收到的图片张数：' + (call?.images ?? 0));
const desc = (text.match(/〔说明〕[^\n]*/) ?? ['（没有说明）'])[0];
console.log(desc);
console.log('');
console.log('转发的文字部分（前 200 字）：');
console.log('  ' + (text.split('【转发的聊天记录】')[1] ?? text).replace(/\n/g, '\n  ').slice(0, 200));
console.log('');
console.log('机器人的回复：');
console.log('  ' + (sent.join(' | ') || '（没有回复）'));
console.log('');

const usage = db.all(
  `select scene, prompt_tokens, cache_hit_tokens, completion_tokens, reasoning_tokens, calls
   from api_usage where bot_id = ?`, botId);
console.log('本次用量：' + JSON.stringify(usage));
if (usage.length) {
  const u = usage[0];
  // 同一段系统提示词第二次调用会命中缓存，所以按「未命中」那部分算真实开销
  console.log(`  输入 ${u.prompt_tokens}（命中缓存 ${u.cache_hit_tokens}）  输出 ${u.completion_tokens}（其中思考 ${u.reasoning_tokens}）`);
}
console.log('');
if ((call?.images ?? 0) > 0) {
  console.log('✅ 转发里的图确实送去识别了');
  console.log('   判断回复质量：上面那句回复里有没有说到图里的具体内容（而不是只说"一堆图"）。');
} else {
  console.log('❌ 一张都没读到 —— 很可能是图床的临时链接（rkey）已经过期。');
}

db.closeDb();
log.closeLogs();
