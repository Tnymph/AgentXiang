// 验收这一轮三件事（真模型 + 生产库里的真卡片）：
//   ① 小向讲题时给不给具体例子（具体数字、算子步骤）
//   ② 小向讲的知识面宽不宽（是不是还只会讲矩阵）
//   ③ 猪咪能不能用上网上抓来的素材
//
// 只读卡片、只调模型；客户端是假的，不往 QQ 发东西。
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, DATA_DIR } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as db from '../src/db.js';
import * as secrets from '../src/secrets.js';
import * as llm from '../src/llm.js';
import * as lists from '../src/modules/lists.js';
import * as persona from '../src/modules/persona.js';
import * as jokes from '../src/modules/jokes.js';
import { saveBotSettings, botSettings } from '../src/config.js';
import { BotWorker } from '../src/pipeline.js';

ensureDirs();
log.setDebug(false);

// ---------- 从生产库抄一份卡片和设置 ----------
db.openDb();
const CARDS = {};
const SETTINGS = {};
for (const id of [1, 2]) {
  const row = persona.activePersona(id);
  CARDS[id] = { body: row.body, examples: persona.parseExamples(row), params: persona.parseParams(row) };
  SETTINGS[id] = botSettings(id);
}
const NAMES = { 1: '客服小向', 2: '猪咪群友' };
const QQS = { 1: '3046116373', 2: '3998561404' };
db.closeDb();

// ---------- 测试库 ----------
const TEST_DB = path.join(DATA_DIR, 'test12.sqlite');
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.unlinkSync(f); } catch { /* 忽略 */ }
}
db.openDb(TEST_DB);

const GROUP = '555001';                 // 示例群号，跑之前改成你自己的
const USER = '10000002';                // 示例号，跑之前改成你自己的

function makeWorker(prodId) {
  const testId = db.createBot(NAMES[prodId], QQS[prodId]);
  const src = SETTINGS[prodId];
  saveBotSettings(testId, {
    api: {
      mode: 'force_on', effortMode: 'low', vision: { enabled: false },
      webJokes: { ...(src.api?.webJokes ?? { enabled: false }), enabled: prodId === 2 },
    },
    speak: {
      defaultGroupMode: src.speak?.defaultGroupMode ?? 'passive',
      privateMode: 'passive', groupModes: {}, active: src.speak?.active ?? {},
      replyMaxChars: src.speak?.replyMaxChars,
      replyMaxCharsDetailed: src.speak?.replyMaxCharsDetailed,
      maxSentences: src.speak?.maxSentences,
      maxSentencesDetailed: src.speak?.maxSentencesDetailed,
      maxMessages: src.speak?.maxMessages,
      splitLongReplies: src.speak?.splitLongReplies,
    },
  });
  persona.upsertPersona(testId, CARDS[prodId]);
  lists.addTarget(testId, 'group', 'accept', GROUP);
  lists.addTarget(testId, 'user', 'accept', USER);
  lists.addTarget(testId, 'user', 'reply', USER);

  const sent = [];
  const calls = [];
  const client = {
    sent,
    async call() { throw new Error('假客户端没实现'); },
    async sendTo(kind, peerId, message) {
      sent.push((message ?? []).map((s) => s?.data?.text ?? '').join(''));
      return { message_id: 'out-' + sent.length };
    },
    async deleteMsg() { return true; },
    async getLoginInfo() { return { user_id: Number(QQS[prodId]), nickname: NAMES[prodId] }; },
    async getRecord() { return { file: null, url: '' }; },
    async getForwardMsg() { return { messages: [] }; },
  };
  const worker = new BotWorker({
    bot: db.getBot(testId),
    client,
    // 借生产库那个号来取密钥（secrets 是全机共享的，只读）
    chatFn: async (p) => {
      calls.push({ tail: p.tail, system: p.system });
      return llm.chat({ ...p, apiKey: secrets.getApiKey(prodId) });
    },
  });
  return { testId, worker, sent, calls };
}

const ask = async (w, text) => {
  w.sent.length = 0;
  await w.worker.onMessage({
    post_type: 'message', message_type: 'private', user_id: Number(USER),
    message_id: 'q-' + Math.random().toString(36).slice(2, 8), time: Math.floor(Date.now() / 1000),
    sender: { nickname: '跳蝻', card: '跳蝻' },
    message: [{ type: 'text', data: { text } }],
  });
  return w.sent.join(' | ');
};

// ============ ① 小向：讲题给不给具体例子 ============
console.log('════ ① 小向讲题：有没有具体例子 ════');
const A = makeWorker(1);
await A.worker.onReady(QQS[1]);

const q1 = await ask(A, '给我举个例子讲讲行列式怎么算');
console.log('问：给我举个例子讲讲行列式怎么算');
console.log('答：' + q1);
const hasDigits = /\d/.test(q1);
const hasCalc = /[=+×\-]|\d\s*[×*]\s*\d|展开|余子式/.test(q1);
console.log(`   含具体数字？${hasDigits ? '✅' : '❌'}   含计算步骤？${hasCalc ? '✅' : '❌'}   总字数 ${q1.length}`);
console.log('');

// ============ ② 小向：知识面宽不宽 ============
console.log('════ ② 小向的知识面：还会不会只会讲矩阵 ════');
const q2 = await ask(A, '高代里除了矩阵还有什么值得讲的？');
console.log('问：高代里除了矩阵还有什么值得讲的？');
console.log('答：' + q2);
// 数一数提到了几个非矩阵的题材
const TOPICS = {
  行列式: /行列式/, 线性方程组: /方程组/, 向量组: /向量组|线性相关|线性无关/,
  特征值: /特征值|特征向量|对角化/, 二次型: /二次型/, 多项式: /多项式/,
  向量空间: /向量空间|子空间|基与维数|基和维数/,
};
const hitTopics = Object.entries(TOPICS).filter(([, re]) => re.test(q2)).map(([k]) => k);
console.log(`   提到的题材：${hitTopics.length ? hitTopics.join('、') : '（一个都没提到）'}`);
console.log(`   非矩阵题材数：${hitTopics.filter((t) => t !== '矩阵').length}  ${hitTopics.length >= 3 ? '✅' : '⚠️ 偏少'}`);
console.log('');

// ============ ③ 猪咪：能不能用上抓来的素材 ============
console.log('════ ③ 猪咪用网上素材 ════');
const B = makeWorker(2);
await B.worker.onReady(QQS[2]);

// 先直接验一下抓取本身（真网络）
jokes.resetJokes();
const fetched = await jokes.fetchOne({ force: true });
console.log('实时抓一条：' + (fetched.ok ? `「${fetched.text}」（${fetched.source}）` : '❌ ' + fetched.reason));
console.log('');

const q3 = await ask(B, '来个好玩的段子');
console.log('问：来个好玩的段子');
console.log('答：' + q3);
console.log('   提示词里带了网上素材？' + (/网上刚刷到/.test(String(B.calls.at(-1)?.tail)) ? '✅' : '❌'));
console.log('   回复字数：' + q3.length);
console.log('');

console.log('════ 猪咪的网友感 ════');
const q4 = await ask(B, '今天数学考了五十九分');
console.log('问：今天数学考了五十九分');
console.log('答：' + q4);
console.log('');

const q5 = await ask(B, '你觉得我这个人怎么样');
console.log('问：你觉得我这个人怎么样');
console.log('答：' + q5);

db.closeDb();
log.closeLogs();
