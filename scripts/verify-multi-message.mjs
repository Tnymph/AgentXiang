// 验收「分消息说、每条装几句话」：看每条实际装了几句
import { ensureDirs, DATA_DIR } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as db from '../src/db.js';
import * as secrets from '../src/secrets.js';
import * as llm from '../src/llm.js';
import * as lists from '../src/modules/lists.js';
import * as persona from '../src/modules/persona.js';
import * as speaking from '../src/modules/speaking.js';
import { saveBotSettings, botSettings } from '../src/config.js';
import { BotWorker } from '../src/pipeline.js';
import path from 'node:path';

ensureDirs();
log.setDebug(false);

// 抄一份机器人 2 的卡片与设置
db.openDb();
const row = persona.activePersona(2);
const CARD = { body: row.body, examples: persona.parseExamples(row), params: persona.parseParams(row) };
const SRC = botSettings(2);
db.closeDb();

const TEST_DB = path.join(DATA_DIR, 'test13.sqlite');
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.unlinkSync(f); } catch { /* 忽略 */ }
}
db.openDb(TEST_DB);

const QQ = '3998561404';
const USER = '10000002';                // 示例号，跑之前改成你自己的
const GROUP = '555001';                 // 示例群号，跑之前改成你自己的
const botId = db.createBot('猪咪群友', QQ);
saveBotSettings(botId, {
  api: { mode: 'force_on', effortMode: 'low', vision: { enabled: false } },
  speak: {
    defaultGroupMode: 'passive', privateMode: 'passive', groupModes: {}, active: {},
    replyMaxChars: SRC.speak.replyMaxChars,
    replyMaxCharsDetailed: SRC.speak.replyMaxCharsDetailed,
    maxSentences: SRC.speak.maxSentences,
    maxSentencesDetailed: SRC.speak.maxSentencesDetailed,
    maxMessages: SRC.speak.maxMessages,
    segmentDelayMs: SRC.speak.segmentDelayMs,
  },
});
persona.upsertPersona(botId, CARD);
lists.addTarget(botId, 'group', 'accept', GROUP);
lists.addTarget(botId, 'user', 'accept', USER);
lists.addTarget(botId, 'user', 'reply', USER);

const s = botSettings(botId).speak;
console.log('当前设置：每条最多 ' + s.maxSentences + ' 句 / 一次最多 ' + s.maxMessages
  + ' 条 / 字数目标 ' + s.replyMaxChars + ' / 间隔 ' + s.segmentDelayMs + 'ms');
console.log('');

const sent = [];
const client = {
  async call() { throw new Error('假客户端'); },
  async sendTo(kind, peerId, message) {
    sent.push((message ?? []).map((x) => x?.data?.text ?? '').join(''));
    return { message_id: 'out-' + sent.length };
  },
  async deleteMsg() { return true; },
  async getLoginInfo() { return { user_id: Number(QQ), nickname: '猪咪群友' }; },
  async getRecord() { return { file: null, url: '' }; },
  async getForwardMsg() { return { messages: [] }; },
};

const worker = new BotWorker({
  bot: db.getBot(botId),
  client,
  chatFn: async (p) => {
    const r = await llm.chat({ ...p, apiKey: secrets.getApiKey(2) });
    // 把模型原始输出打出来，才能看清本地是怎么拆的
    console.log('  ⟦模型原始输出⟧ ' + JSON.stringify(String(r.text ?? '')));
    const sents = speaking.splitSentences(String(r.text ?? ''));
    console.log(`  ⟦切成 ${sents.length} 句⟧ ` + JSON.stringify(sents));
    return r;
  },
});
await worker.onReady(QQ);

const ask = async (text) => {
  sent.length = 0;
  await worker.onMessage({
    post_type: 'message', message_type: 'private', user_id: Number(USER),
    message_id: 'q-' + Math.random().toString(36).slice(2, 8), time: Math.floor(Date.now() / 1000),
    sender: { nickname: '跳蝻', card: '跳蝻' },
    message: [{ type: 'text', data: { text } }],
  });
  console.log('问：' + text);
  sent.forEach((t, i) => {
    const n = speaking.splitSentences(t).length;
    console.log(`  [${i + 1}] (${n} 句 / ${t.length} 字) ${t}`);
  });
  console.log(`  → 共 ${sent.length} 条`);
  console.log('');
};

// 挑几个会让它多说几句的问题
await ask('今天遇到一件特别离谱的事');
await ask('给我讲讲你平时都干嘛');
await ask('你觉得大学和高中最大的区别是什么');

db.closeDb();
log.closeLogs();
