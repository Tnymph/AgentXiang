// 确认提炼素材里不再包含命令消息
import { ensureDirs } from '../src/paths.js';
import * as db from '../src/db.js';
import * as impression from '../src/modules/impression.js';

ensureDirs();
db.openDb();

const botId = 1;
const pid = 2;

const utt = impression.recentUtterances(botId, pid);
console.log(`人#${pid} 的提炼素材共 ${utt.length} 条：`);
for (const t of utt) console.log('  · ' + t.slice(0, 60));

const hasCmd = utt.some((t) => /^\//.test(t.trim()) || t.includes('/learn') || t.includes('/help'));
console.log('');
console.log('素材里是否还含命令:', hasCmd ? '是 ✗' : '否 ✓');

const cmdRows = db.all(
  `select text, flags from messages where bot_id = ? and person_id = ? and flags like '%command%' order by ts desc limit 5`,
  botId, pid);
console.log(`（该人确实发过 ${cmdRows.length} 条以上命令消息，已排除）`);
for (const r of cmdRows) console.log('  排除: ' + r.text.slice(0, 40));

const cur = impression.get(botId, pid);
console.log('');
console.log('当前档案 facts:', (cur?.facts ?? '').slice(0, 120));

console.log('');
console.log('=== 清掉旧档案后重新提炼，验证新素材干净 ===');
impression.remove(botId, pid);
const apiKey = (await import('../src/secrets.js')).getApiKey(1);
const llm = await import('../src/llm.js');
const settings = (await (await fetch('http://127.0.0.1:6188/api/bots/1/settings')).json()).settings;
const r = await impression.extractFor(botId, pid, {
  settings, apiKey, chatFn: llm.chat,
  baseUrl: settings.api.baseUrl, model: settings.api.model,
});
console.log('提炼:', r.ok ? 'ok' : '失败 ' + r.error);
if (r.ok) {
  console.log('  facts:   ', r.facts);
  console.log('  feelings:', r.feelings);
  console.log('  还提命令吗:', /\/learn|\/help|\/api|\/spend|指令/.test(r.facts + r.feelings) ? '是 ✗' : '否 ✓');
}

db.closeDb();
