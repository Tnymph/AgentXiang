// 直接看库里 @ 到底存成了什么。不猜。
import { ensureDirs } from '../src/paths.js';
import * as db from '../src/db.js';
import * as log from '../src/logger.js';

ensureDirs();
db.openDb();

const rows = db.all(
  `select id, bot_id, role, sender_name, text, flags
   from messages
   where text like '%@%'
   order by id desc limit 40`);

console.log('含 @ 的消息共查到 ' + rows.length + ' 条（最近 40 条）：');
for (const r of rows) {
  const t = String(r.text ?? '').replace(/\n/g, '\\n');
  console.log(`#${r.id} bot${r.bot_id} ${r.role} [${r.sender_name ?? '?'}] ${r.flags ? '(' + r.flags + ') ' : ''}${t.slice(0, 140)}`);
}

console.log('');
console.log('--- 只看「@ 后面直接跟数字」的（说明 @ 被写成了 QQ 号）---');
const numeric = db.all(
  `select id, bot_id, role, text from messages
   where text like '%@%' and text glob '*@[0-9]*'
   order by id desc limit 20`);
console.log('命中 ' + numeric.length + ' 条');
for (const r of numeric) {
  console.log(`#${r.id} bot${r.bot_id} ${r.role} ${String(r.text).replace(/\n/g, '\\n').slice(0, 140)}`);
}

console.log('');
console.log('--- 所有出现过的 @xxx 片段（去重计数）---');
const all = db.all(`select text from messages where text like '%@%' order by id desc limit 500`);
const tally = new Map();
for (const r of all) {
  for (const m of String(r.text).matchAll(/@[^\s@，。！？、,.!?]{1,20}/g)) {
    tally.set(m[0], (tally.get(m[0]) ?? 0) + 1);
  }
}
const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
for (const [k, v] of sorted.slice(0, 30)) console.log(`${v} 次   ${k}`);

db.closeDb();
log.closeLogs();
