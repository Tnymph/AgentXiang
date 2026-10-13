// 验收：生产库的 media 列到位、数据没丢、接口能取到图片
import { ensureDirs } from '../src/paths.js';
import * as db from '../src/db.js';
import * as log from '../src/logger.js';
import * as history from '../src/history.js';

ensureDirs();
db.openDb();
log.setDebug(false);

const cols = db.all('pragma table_info(messages)').map((c) => c.name);
console.log('messages 表的列：' + cols.join(', '));
console.log('有 media 列：' + (cols.includes('media') ? '✅' : '❌'));

const n = db.one('select count(*) as n from messages').n;
const bots = db.all('select bot_id, count(*) as n from messages group by bot_id');
console.log(`\n消息总数 ${n}，按机器人：${bots.map((r) => `#${r.bot_id}=${r.n}`).join('  ')}`);

console.log('\n最近的图片消息（media 列）：');
const imgs = db.all(
  `select id, bot_id, text, flags, media, ts from messages
   where flags like '%image%' or media <> '' order by id desc limit 8`);
if (!imgs.length) console.log('  （没有）');
for (const r of imgs) {
  const parsed = history.parseMedia(r);
  const time = new Date(r.ts).toLocaleString('zh-CN');
  console.log(`  #${r.id} bot${r.bot_id} ${time}  text=${JSON.stringify(r.text)}  media=${parsed.length} 条`);
  for (const m of parsed) console.log(`      ${m.kind}: ${m.url.slice(0, 90)}`);
}
console.log('');
console.log('说明：media 是这次新加的列，所以**历史图片消息的地址是补不回来的**——');
console.log('      当时的图片地址根本没落到库里。从那以后新收到的图才会带地址。');

db.closeDb();
log.closeLogs();
