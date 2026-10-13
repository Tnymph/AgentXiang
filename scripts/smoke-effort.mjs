// 专门验证 reasoning_effort：字段名是否生效、各档位对思考 token 的影响
import { ensureDirs } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as db from '../src/db.js';
import * as secrets from '../src/secrets.js';

ensureDirs();
db.openDb();
const KEY = process.env.DS_KEY || secrets.getApiKey(1);
if (!KEY) { console.log('SKIP: 未配置 API Key'); process.exit(0); }
secrets.setApiKey(1, KEY);
const apiKey = secrets.getApiKey(1);

const url = 'https://api.deepseek.com/v1/chat/completions';
const body = {
  model: 'deepseek-flash',
  messages: [
    { role: 'system', content: '你是助手。' },
    { role: 'user', content: '一个班有 30 人，其中 18 人学线代，12 人学高数，5 人两门都学。问只学线代不学高数的有几人？最后一行只写数字。' },
  ],
  max_tokens: 400,
  temperature: 1.0,
  stream: false,
};

const variants = [
  ['（不传 effort）', null],
  ['reasoning_effort=low', { reasoning_effort: 'low' }],
  ['reasoning_effort=high', { reasoning_effort: 'high' }],
  ['reasoning_effort=max', { reasoning_effort: 'max' }],
  ['effort=low（对照组）', { effort: 'low' }],
];

console.log('变体                      status  思考tok  输出tok  总tok  首行文本');
for (const [label, extra] of variants) {
  const payload = { ...body, ...(extra ?? {}) };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    });
    const t = await res.text();
    let d;
    try { d = JSON.parse(t); } catch { d = null; }
    if (!res.ok || !d) {
      console.log(`${label.padEnd(24)} ${res.status}  ${t.slice(0, 90)}`);
      continue;
    }
    const u = d.usage ?? {};
    const reasoning = u.completion_tokens_details?.reasoning_tokens ?? 0;
    const completion = u.completion_tokens ?? 0;
    const text = (d.choices?.[0]?.message?.content ?? '').replace(/\n/g, ' ').slice(0, 30);
    console.log(`${label.padEnd(24)} ${String(res.status).padEnd(7)} ${String(reasoning).padStart(7)} ${String(completion).padStart(8)} ${String(u.total_tokens).padStart(6)}  ${text}`);
  } catch (e) {
    console.log(`${label.padEnd(24)} ERR ${e.message}`);
  }
}

db.closeDb();
log.closeLogs();
