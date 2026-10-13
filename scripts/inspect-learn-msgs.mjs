// 看清楚那两条 /learn badex 到底是什么
import { ensureDirs } from '../src/paths.js';
import * as db from '../src/db.js';

ensureDirs();
db.openDb();

const rows = db.all(`
  select id, session_id, role, text, flags, ts, sender_qq
  from messages
  where bot_id = 1 and text like '%learn%'
  order by ts asc`);

console.log(`共 ${rows.length} 条含 learn 的消息：`);
for (const r of rows) {
  const t = new Date(r.ts).toLocaleTimeString('zh-CN');
  console.log(`  #${r.id} [${t}] role=${r.role} flags="${r.flags}" text=${JSON.stringify(r.text)}`);
}

console.log('');
console.log('=== 人#2 素材里那两条的前后各 3 条（按时间） ===');
const all = db.all(`
  select id, text, flags, ts, role from messages
  where bot_id = 1 and person_id = 2
  order by ts asc`);
const idx = all.map((r, i) => ({ r, i })).filter(({ r }) => r.text === '/learn badex').map(({ i }) => i);
for (const i of idx) {
  console.log(`--- 第 ${i} 条附近 ---`);
  for (let k = Math.max(0, i - 3); k <= Math.min(all.length - 1, i + 1); k++) {
    const r = all[k];
    console.log(`  ${k === i ? '>>' : '  '} #${r.id} flags="${r.flags}" ${new Date(r.ts).toLocaleTimeString('zh-CN')} ${JSON.stringify(r.text.slice(0, 30))}`);
  }
}

db.closeDb();
