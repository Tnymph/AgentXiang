// 端到端验证：主动模式下「发一张图」会不会真的得到回复
//
// 设计要点（你在远程，这条链必须一次跑通）：
//   · 客户端是假的 → 不会往 QQ 发任何东西
//   · 数据库用 test8.sqlite → 不碰生产库
//   · 机器人 id 用 1 → secrets 是全局存储，能读到真实 API key（只读，不写）
//   · chatFn 用真实的 llm.chat → 真调一次模型，看它拿到图片后会不会接话
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, DATA_DIR } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as db from '../src/db.js';
import * as secrets from '../src/secrets.js';
import * as llm from '../src/llm.js';
import * as lists from '../src/modules/lists.js';
import * as admins from '../src/modules/admins.js';
import * as persona from '../src/modules/persona.js';
import * as rate from '../src/modules/rateLimit.js';
import { saveBotSettings } from '../src/config.js';
import { BotWorker } from '../src/pipeline.js';

ensureDirs();
const TEST_DB = path.join(DATA_DIR, 'test8.sqlite');
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.unlinkSync(f); } catch { /* 忽略 */ }
}
db.openDb(TEST_DB);
log.setDebug(false);

const BOT_QQ = '10001';
const USER = '20001';
const GROUP = '555001';
const GROUP2 = '555002';   // 干净会话，用来测「没有任何可借用的上下文」时的空消息

// 用真实存在的图片文件（NapCat 缓存里的二维码）
const IMG = path.resolve('.tools/napcat/cache/qrcode.png');
if (!fs.existsSync(IMG)) { console.log('找不到测试图片：' + IMG); process.exit(1); }
console.log('测试图片：' + IMG + '  (' + fs.statSync(IMG).size + ' 字节)');

const botId = db.createBot('客服小向', BOT_QQ);
saveBotSettings(botId, {
  api: { mode: 'force_on', vision: { enabled: true, detail: 'low' }, effortMode: 'low' },
  speak: {
    defaultGroupMode: 'active',
    privateMode: 'passive',
    replyMaxChars: 45,
    // 粗筛的随机闸门调到 100%，否则这次验证会因为随机而时好时坏
    active: { perGroupPerHour: 300, minGapSec: 1, minMessageLength: 1, randomRate: 1 },
  },
});
persona.upsertPersona(botId, {
  name: '测试人格',
  body: '【整体印象】\n一个说话很短的老师，看到学生发的东西会随口评论一句。\n\n【不会有的说法】\n不写长篇、不分点。',
  examples: [],
  params: {},
});
lists.addTarget(botId, 'group', 'accept', GROUP);
lists.addTarget(botId, 'group', 'accept', GROUP2);
lists.addTarget(botId, 'user', 'accept', USER);
lists.addTarget(botId, 'user', 'reply', USER);
admins.addAdmin(botId, USER);

const key = secrets.getApiKey(botId);
console.log('API key：' + (key ? '已读到（' + String(key).slice(0, 6) + '…）' : '没读到 —— 下面会失败'));

// ---- 假客户端：记录发送内容，绝不真的发出去 ----
const sent = [];
const client = {
  sent,
  async call(action) { throw new Error('假客户端没实现: ' + action); },
  async sendTo(kind, peerId, message) {
    const text = (message ?? []).map((s) => s?.data?.text ?? '').join('');
    sent.push({ kind, peerId, text });
    return { message_id: 'out-' + sent.length };
  },
  async deleteMsg() { return true; },
  async getLoginInfo() { return { user_id: Number(BOT_QQ), nickname: '小向' }; },
  async getRecord() { return { file: null, url: '' }; },
};

const worker = new BotWorker({ bot: db.getBot(botId), client, chatFn: (p) => llm.chat(p) });
await worker.onReady(BOT_QQ);

const atSeg = { type: 'at', data: { qq: BOT_QQ } };
const imgSeg = { type: 'image', data: { url: IMG, file: IMG } };
const txt = (t) => ({ type: 'text', data: { text: t } });
const grp = (segs, groupId = GROUP) => ({
  post_type: 'message', message_type: 'group', group_id: Number(groupId), user_id: Number(USER),
  message_id: 'in-' + Math.random().toString(36).slice(2, 8),
  time: Math.floor(Date.now() / 1000),
  sender: { card: '跳蝻', nickname: 'tn', role: 'member' },
  message: segs,
});

async function run(label, segs, groupId = GROUP) {
  rate.reset();
  sent.length = 0;
  const before = db.all('select count(*) as n from messages where bot_id = ?', botId)[0].n;
  try {
    await worker.onMessage(grp(segs, groupId));
  } catch (e) {
    console.log(`\n【${label}】处理时抛错：${e.message}`);
    return;
  }
  const rows = db.all('select role, text, flags from messages where bot_id = ? order by id desc limit 2', botId);
  const after = db.all('select count(*) as n from messages where bot_id = ?', botId)[0].n;
  console.log(`\n【${label}】`);
  console.log('  入库了 ' + (after - before) + ' 条；写的什么：' +
    JSON.stringify(rows.filter((r) => r.role === 'user').map((r) => r.text)));
  if (sent.length) console.log('  机器人回复：' + JSON.stringify(sent.map((s) => s.text).join(' | ')));
  else console.log('  没有回复');
}

console.log('');
console.log('════════ 真实模型 + 真实图片，跑四种情形 ════════');

// 这是用户报的那一种：只有图，没文字，也没 @ 机器人
await run('① 只发图（无文字、没 @ 机器人）—— 这就是报的那个问题', [imgSeg]);

// 对照：图 + @ 机器人（一直都能工作的路径）
await run('② 图 + @ 机器人（对照）', [atSeg, imgSeg]);

// 对照：纯文字（主动模式本来就该接话）
await run('③ 纯文字（对照）', [txt('这期视频神了')]);

// 边界：在干净会话里发一条真正的空消息。
// 必须用新会话——同一个群里上一条的文字会被「借用」过去，那测的就不是空消息了。
await run('④ 干净会话里的空消息（边界，应当不回、也不该调模型）', [txt('')], GROUP2);

console.log('');
console.log('════════ 怎么看结果 ════════');
console.log('① 有回复 = 你报的问题修好了（而且模型确实看见了图）');
console.log('② 有回复 = 原有的 @ 路径没被弄坏');
console.log('③ 有回复 = 纯文字路径没被弄坏');
console.log('④ 没有回复 = 空消息守卫还在，不会白花一次模型调用');

db.closeDb();
log.closeLogs();
