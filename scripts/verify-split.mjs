// 验证逐句发送：日常问题一条一句，讲解类问题放宽
import { ensureDirs } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as llm from '../src/llm.js';
import * as persona from '../src/modules/persona.js';
import * as speaking from '../src/modules/speaking.js';
import * as db from '../src/db.js';
import * as secrets from '../src/secrets.js';

ensureDirs();
db.openDb();

const settings = (await (await fetch('http://127.0.0.1:6188/api/bots/1/settings')).json()).settings;
const apiKey = secrets.getApiKey(1);
if (!apiKey) { console.log('没有密钥'); process.exit(1); }

const system = persona.buildSystemPrompt(1, { settings });
const shape = speaking.replyShape(settings);
console.log('设置:', JSON.stringify({ maxSentences: shape.maxSentences, maxSentencesDetailed: shape.maxSentencesDetailed, maxMessages: shape.maxMessages }));
console.log('');

const questions = ['在吗', '今天讲什么', '什么是矩阵', '行列式怎么算'];

for (const q of questions) {
  const tail = `〔现在在群里〕说话的人是「跳蝻」。\n\n〔他说〕${q}`;
  const r = await llm.chat({
    botId: 1, apiKey,
    baseUrl: settings.api.baseUrl, model: settings.api.model,
    scene: 'chat', system, history: [], tail,
    effort: 'low', maxTokens: llm.DEFAULT_MAX_TOKENS,
  });
  const text = (r.text ?? '').trim();
  const limit = speaking.pickSentenceLimit(q, settings);
  const msgs = speaking.splitReply(text, { maxSentences: limit.maxSentences, maxMessages: shape.maxMessages });

  console.log(`Q: ${q}   [${limit.detailed ? '讲解档' : '日常档'} · 每条最多 ${limit.maxSentences} 句${limit.matched ? ' · 命中"' + limit.matched + '"' : ''}]`);
  console.log(`   模型原始回复（${speaking.splitSentences(text).length} 句 / ${text.length} 字）:`);
  console.log(`   ${text}`);
  console.log(`   实际会发出 ${msgs.length} 条:`);
  msgs.forEach((m, i) => console.log(`     ${i + 1}) ${m}`));
  console.log('');
}

db.closeDb();
log.closeLogs();
