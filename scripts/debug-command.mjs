// 把最近几条消息的原始字符打出来，找看不见的字符
import { ensureDirs } from '../src/paths.js';
import * as db from '../src/db.js';
import { parseCommand } from '../src/message.js';

ensureDirs();
db.openDb();

const rows = db.all(
  `select id, msg_id, role, text, flags, ts from messages
   where bot_id = 1 and role = 'user' order by ts desc limit 8`);

for (const r of rows.reverse()) {
  const text = String(r.text ?? '');
  const codes = [...text].slice(0, 20).map((ch) => {
    const c = ch.codePointAt(0);
    const printable = c >= 32 && c !== 127;
    return printable ? ch : `\\u${c.toString(16).padStart(4, '0')}`;
  }).join('');
  const cmd = parseCommand(text);
  console.log(`#${r.id} flags=[${r.flags}]`);
  console.log(`   原文(可打印化): ${codes}`);
  console.log(`   解析命令: ${cmd ? JSON.stringify({ name: cmd.name, args: cmd.args }) : 'null'}`);
  console.log(`   首字符码点: ${text.length ? 'U+' + text.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') : '(空)'}`);
  console.log('');
}

db.closeDb();
