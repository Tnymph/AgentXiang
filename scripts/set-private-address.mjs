// 设置私聊称呼，并验证效果
import { ensureDirs } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as llm from '../src/llm.js';
import * as persona from '../src/modules/persona.js';
import * as db from '../src/db.js';
import * as secrets from '../src/secrets.js';

ensureDirs();
db.openDb();

const botId = 1;
const cur = persona.activePersona(botId);
const params = persona.parseParams(cur);
console.log('当前参数:', JSON.stringify(params, null, 2));

params.privateAddress = '同学';
persona.upsertPersona(botId, { params });
console.log('\n已设置 privateAddress = 同学');

// 确认写进去了，并看看新生成的 system prompt
const after = persona.parseParams(persona.activePersona(botId));
console.log('回读参数 privateAddress =', after.privateAddress);

const system = persona.buildSystemPrompt(botId);
const idx = system.indexOf('【称呼场景】');
console.log('\nsystem prompt 里的称呼段落:');
console.log(idx >= 0 ? system.slice(idx, idx + 130) : '（没有找到称呼场景段落！）');

// 用真实模型试几条，看私聊会不会还说「大家」
const apiKey = secrets.getApiKey(botId);
if (!apiKey) { console.log('\n没有密钥，跳过实测'); process.exit(0); }

const settings = (await (await fetch('http://127.0.0.1:6188/api/bots/1/settings')).json()).settings;

console.log('\n=== 私聊实测（看是否改口）===');
const privateTail = [
  '〔现在是一对一的私聊，没有别人在场，对方叫「跳蝻」。〕',
  '',
  '〔他说〕老师我有个地方没听懂',
].join('\n');

for (let i = 1; i <= 3; i++) {
  const r = await llm.chat({
    botId, apiKey,
    baseUrl: settings.api.baseUrl, model: settings.api.model,
    scene: 'chat', system, history: [], tail: privateTail,
    effort: 'low', maxTokens: llm.DEFAULT_MAX_TOKENS,
  });
  const t = r.text ?? '';
  const hasDajia = t.includes('大家') || t.includes('同学们');
  console.log(`\n第 ${i} 条: ${t}`);
  console.log(`  含「大家/同学们」: ${hasDajia ? '是 ✗' : '否 ✓'}   含「同学」: ${t.includes('同学') ? '是 ✓' : '否'}`);
  console.log(`  用量: hit=${r.usage?.cacheHit} miss=${r.usage?.cacheMiss}`);
}

console.log('\n=== 群里实测（对照，应保留「大家」）===');
const groupTail = [
  '〔现在在群里〕说话的人是「张三」。',
  '',
  '〔他说〕老师这道题怎么做',
].join('\n');
const rg = await llm.chat({
  botId, apiKey,
  baseUrl: settings.api.baseUrl, model: settings.api.model,
  scene: 'chat', system, history: [], tail: groupTail,
  effort: 'low', maxTokens: llm.DEFAULT_MAX_TOKENS,
});
console.log(`  回复: ${rg.text}`);
console.log(`  含「大家」: ${(rg.text ?? '').includes('大家') ? '是 ✓' : '否（本次没用到，不一定是问题）'}`);

db.closeDb();
log.closeLogs();
