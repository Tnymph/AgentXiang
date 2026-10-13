// 验证三条风格调整：比喻收敛、篇幅变短、适当联系计算机
import { ensureDirs } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as llm from '../src/llm.js';
import * as persona from '../src/modules/persona.js';
import * as speaking from '../src/modules/speaking.js';
import * as db from '../src/db.js';
import * as secrets from '../src/secrets.js';

ensureDirs();
db.openDb();

const botId = 1;
const settings = (await (await fetch('http://127.0.0.1:6188/api/bots/1/settings')).json()).settings;
const apiKey = secrets.getApiKey(botId);
if (!apiKey) { console.log('没有密钥'); process.exit(1); }

const shape = speaking.replyShape(settings);
console.log('篇幅设置:', JSON.stringify(shape));
console.log('');

const system = persona.buildSystemPrompt(botId, { settings });

// 私聊里问几个问题，看回答长度、比喻密度、有没有联系到计算机
const questions = [
  '什么是矩阵',
  '行列式是什么',
  '老师说下怎么算逆矩阵',
  '这个我不会',
  '群里有同学问，向量和数组有什么区别',
];

const tails = questions.map((q) =>
  [`〔现在是一对一的私聊，没有别人在场，对方叫「跳蝻」。〕`, '', `〔他说〕${q}`].join('\n'));

console.log('=== 私聊实测 ===');
for (let i = 0; i < questions.length; i++) {
  const r = await llm.chat({
    botId, apiKey,
    baseUrl: settings.api.baseUrl, model: settings.api.model,
    scene: 'chat', system, history: [], tail: tails[i],
    effort: 'low', maxTokens: llm.DEFAULT_MAX_TOKENS,
  });
  const t = (r.text ?? '').trim();
  const segs = speaking.splitReply(t, shape);

  // 粗看比喻密度：出现「像」「好比」「好比说」「就像」「如同」「相当于」这类
  const analogy = (t.match(/像|好比|如同|相当于|恰似|好似|犹如/g) ?? []).length;
  const coding = /算法|数组|程序|计算机|计算机|代码|循环|递归|复杂度|数据结构|人工智能|机器|变量|函数/i.test(t);

  console.log(`\nQ: ${questions[i]}`);
  console.log(`A: ${t}`);
  console.log(`   字数 ${t.length}（上限 ${shape.maxChars}）  拟切 ${segs.length} 段  比喻词 ${analogy}  联系计算机 ${coding ? '有' : '无'}`);
  console.log(`   用量 hit=${r.usage?.cacheHit} miss=${r.usage?.cacheMiss} reasoning=${r.usage?.reasoning}`);
}

db.closeDb();
log.closeLogs();
