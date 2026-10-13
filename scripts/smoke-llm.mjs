// 冒烟测试：DeepSeek 客户端（缓存命中、effort 字段名、用量入库）
// key 从环境变量读入后存进 DPAPI 密钥库，不在源码里留字面量
import { ensureDirs } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as db from '../src/db.js';
import * as secrets from '../src/secrets.js';
import * as llm from '../src/llm.js';

ensureDirs();
db.openDb();

const KEY = process.env.DS_KEY || secrets.getApiKey(1);
if (!KEY) { console.log('SKIP: 未配置 API Key（先跑一次带 DS_KEY 的调用，或从界面填入）'); process.exit(0); }
secrets.setApiKey(1, KEY);

const botId = db.getBot(1) ? 1 : db.createBot('主机器人', '10001');
const apiKey = secrets.getApiKey(botId);
const baseUrl = 'https://api.deepseek.com/v1';
const model = 'deepseek-flash';

// 稳定的公共前缀，撑过缓存生效所需长度
const system = '你是测试助手，以下是固定前缀，永不改动：\n' +
  '线性代数先修课是一门衔接中学数学与大学线性代数的桥梁课程。'.repeat(60);

console.log('prefix chars:', system.length);
console.log('effort 字段名假设:', llm.EFFORT_PARAM);

// --- 第一次（应为全量 miss）---
const r1 = await llm.chat({
  botId, apiKey, baseUrl, model, scene: 'chat',
  system, history: [], tail: '只回复两个字：收到',
  effort: 'low', maxTokens: 32,
});
console.log('\nCALL1 ok=%s text=%j', r1.ok, r1.text);
console.log('  usage:', JSON.stringify(r1.usage), 'cost:', r1.cost?.spent?.toFixed(6));
if (!r1.ok) console.log('  error:', r1.error, r1.body);

// --- 第二次：完全相同的请求，应命中缓存 ---
const r2 = await llm.chat({
  botId, apiKey, baseUrl, model, scene: 'chat',
  system, history: [], tail: '只回复两个字：收到',
  effort: 'low', maxTokens: 32,
});
console.log('\nCALL2 ok=%s text=%j', r2.ok, r2.text);
console.log('  usage:', JSON.stringify(r2.usage), 'cost:', r2.cost?.spent?.toFixed(6));
if (r2.ok && r1.usage) {
  const gained = r2.usage.cacheHit - r1.usage.cacheHit;
  console.log('  cache hit 增量:', gained, gained > 0 ? '→ 缓存生效' : '→ 未命中');
}

// --- effort 字段是否被接受（若报错会体现在 ok/error）---
const r3 = await llm.chat({
  botId, apiKey, baseUrl, model, scene: 'learn',
  system: '你是测试助手。', history: [], tail: '回答：1+1=? 只回数字',
  effort: 'high', maxTokens: 200,
});
console.log('\nCALL3 (high effort) ok=%s text=%j', r3.ok, (r3.text || '').slice(0, 40));
console.log('  usage:', JSON.stringify(r3.usage));
if (!r3.ok) console.log('  error:', r3.error, r3.body);

console.log('\n当日用量汇总:', JSON.stringify(llm.usageSummary(botId), null, 2));

db.closeDb();
log.closeLogs();
