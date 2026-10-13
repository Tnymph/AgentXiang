// 缓存专项实验：回答「跨不同对话时，固定前缀到底有多少被缓存」
// 这直接决定机器人的成本模型，值得单独测准。
import fs from 'node:fs';
import { ensureDirs } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as db from '../src/db.js';
import * as secrets from '../src/secrets.js';

ensureDirs();
db.openDb();
const apiKey = process.env.DS_KEY || secrets.getApiKey(1);
if (!apiKey) { console.log('SKIP: 未配置 API Key'); process.exit(0); }

// 一段约 1500 token 的固定前缀（模拟真实的人设卡 + 规则 + 例句）
const FIXED = [
  '你是一个在 QQ 群里说话的人。以下是你的说话风格，必须严格遵守：',
  '【高频口头禅】我们、大家、这一讲、也就是说、换句话说、类似的、下面我们、请注意、比如说、于是、由此可见。',
  '【句子结构】以条件句组织推理；惯用下定义句「我们把……称为……」；大量设问自答；同一意思反复换述。',
  '【互动与称呼】默认称呼「大家」和「我们」，点名思考时切换单数「你」；用「请大家注意」拎出关键点。',
  '【不会有的说法】不用网络流行语、不用无意义填充词、不用书面论文腔。',
  '【示例】这是一门什么样的课程呢，我把它比作从中学数学通向大学线性代数的一个台阶。',
  '【示例】也许有同学会问，这里为什么不妨假设第一个元素不等于零。',
  '【示例】别怕，我们可以把它展开重新整理一下。',
  '【示例】恭喜你猜对了。',
  '【行为约束】只输出要说的话本身，不要加任何解释、前缀、引号或格式标记。控制在一到三句。',
].join('\n').repeat(3);

console.log('前缀字符数:', FIXED.length);

async function call(userText, label) {
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'deepseek-flash',
      messages: [{ role: 'system', content: FIXED }, { role: 'user', content: userText }],
      max_tokens: 200, temperature: 1.0, reasoning_effort: 'low', stream: false,
    }),
  });
  const d = await res.json();
  const u = d.usage ?? {};
  const hit = u.prompt_cache_hit_tokens ?? 0;
  const miss = u.prompt_cache_miss_tokens ?? 0;
  console.log(
    `${label.padEnd(26)} prompt=${String(u.prompt_tokens).padStart(5)}  hit=${String(hit).padStart(5)}  miss=${String(miss).padStart(5)}  命中率=${((hit / u.prompt_tokens) * 100).toFixed(1)}%`
  );
  return { hit, miss, prompt: u.prompt_tokens };
}

console.log('\n--- 场景 A：前缀相同，用户消息每次都不同（真实机器人场景）---');
const questions = [
  '今天上课讲什么',
  '我没听懂刚才那步',
  '这个矩阵怎么算',
  '作业是哪几题',
  '考试难不难',
  '再来一个例子',
];
for (let i = 0; i < questions.length; i++) {
  await call(questions[i], `A${i + 1} 不同问题`);
}

console.log('\n--- 场景 B：前缀 + 用户消息都相同（同一个人重复问）---');
await call('今天上课讲什么', 'B1 重复同一问');
await call('今天上课讲什么', 'B2 再重复');

console.log('\n--- 场景 C：间隔一轮后回到场景 A 的某条 ---');
await call('这个矩阵怎么算', 'C1 回到旧问题');

db.closeDb();
log.closeLogs();
