// 诊断：为什么 map 阶段的 JSON 解析会失败
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, TRANSCRIPT_DIR } from '../src/paths.js';
import { MAP_SYSTEM } from '../src/prompts.js';
import * as log from '../src/logger.js';
import * as db from '../src/db.js';
import * as secrets from '../src/secrets.js';

ensureDirs();
db.openDb();
const apiKey = secrets.getApiKey(1);
if (!apiKey) { console.log('NO KEY'); process.exit(1); }

const text = fs.readFileSync(path.join(TRANSCRIPT_DIR, 'p02.fixed.txt'), 'utf8');
console.log('p02 转写稿长度:', text.length, '字');

for (const maxTokens of [1200, 3000, 6000]) {
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'deepseek-flash',
      messages: [
        { role: 'system', content: MAP_SYSTEM },
        { role: 'user', content: `以下是转写稿：\n\n${text}` },
      ],
      max_tokens: maxTokens,
      temperature: 0.3,
      reasoning_effort: 'high',
      stream: false,
    }),
  });
  const d = await res.json();
  const choice = d.choices?.[0];
  const content = choice?.message?.content ?? '';
  const u = d.usage ?? {};
  console.log(`\n===== max_tokens=${maxTokens} =====`);
  console.log('finish_reason:', choice?.finish_reason, '| usage:', JSON.stringify(u));
  console.log('content 长度:', content.length,
    '| 含{ :', content.includes('{'), '| 含} :', content.includes('}'));
  console.log('开头 160:', JSON.stringify(content.slice(0, 160)));
  console.log('结尾 160:', JSON.stringify(content.slice(-160)));

  if (maxTokens === 6000) {
    const dir = path.join('data', 'work', 'persona');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '_debug-p02.txt'), content, 'utf8');
    console.log('→ 已存 data/work/persona/_debug-p02.txt');
  }
}

db.closeDb();
log.closeLogs();
