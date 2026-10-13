// 「为什么机器人没回复」——看最近的消息，以及每条之后有没有回复。
//
// 用法：node scripts/diag-replies.mjs [条数]
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, LOGS_DIR } from '../src/paths.js';
import * as db from '../src/db.js';
import * as log from '../src/logger.js';

const N = Number(process.argv[2]) || 20;

ensureDirs();
db.openDb();
log.setDebug(false);

const bots = new Map(db.listBots().map((b) => [b.id, b.name]));

const rows = db.all(
  `select id, bot_id, role, session_id, sender_name, text, flags, ts
   from messages order by id desc limit ?`, N);

console.log(`最近 ${rows.length} 条消息（新 → 旧）：`);
console.log('时间      bot  谁            标记            内容');
console.log('─'.repeat(100));
for (const r of rows) {
  const t = String(r.text ?? '').replace(/\n/g, '\\n').slice(0, 46);
  const role = r.role === 'bot' ? '→' : '←';
  const time = new Date(r.ts).toLocaleTimeString('zh-CN');
  console.log(
    `${time}  #${String(r.bot_id).padEnd(2)} ${role} ${String(r.sender_name ?? bots.get(r.bot_id) ?? '').padEnd(12)} ${(r.flags || '-').padEnd(14)} ${t}`);
}

console.log('');
console.log('用户消息后有没有机器人回复（同一会话、更晚的 bot 消息）：');
let silent = 0;
for (const r of rows.filter((x) => x.role === 'user').slice(0, 12)) {
  const reply = db.one(
    `select id, text from messages
      where bot_id = ? and session_id = ? and id > ? and role = 'bot' order by id limit 1`,
    r.bot_id, r.session_id, r.id);
  const time = new Date(r.ts).toLocaleTimeString('zh-CN');
  const what = String(r.text ?? '').slice(0, 30) || (r.flags.includes('image') ? '(纯图片)' : '(无文字)');
  if (reply) {
    console.log(`  ${time} bot#${r.bot_id} [${what}] → 回复了：${JSON.stringify(String(reply.text).slice(0, 40))}`);
  } else {
    silent++;
    console.log(`  ${time} bot#${r.bot_id} [${what}] → ⚠️ 没有回复`);
  }
}
if (silent === 0) console.log('  （没有静默的）');

// 日志里对应的 skip 行，说明是被哪一步挡下的。
// 这些记录在 chat-*.log 里（不是 system/usage），所以按前缀挑，不能拿排序最后一个。
// 冒烟测试跑的时候会写进同一份日志（测试会话的群号是 555xxx、测试号是 100 段），
// 打上标签，免得排查真实问题时被这些假记录带偏。
const isTestLine = (l) =>
  /session=group:555\d{3}|session=private:(100|200)\d{2}|bot=999|session=group:5559/.test(l);

console.log('');
console.log('日志里的拦截原因（最近 25 条）：');
const all = fs.existsSync(LOGS_DIR) ? fs.readdirSync(LOGS_DIR).filter((f) => /\.log$/.test(f)) : [];
const chatLogs = all.filter((f) => /^chat-/.test(f)).sort();
const others = all.filter((f) => !/^chat-/.test(f)).sort();
const ordered = [...chatLogs.slice(-2), ...others.slice(-1)];
if (!ordered.length) {
  console.log('  （' + LOGS_DIR + ' 下还没有日志文件）');
} else {
  let testNoise = 0;
  for (const f of ordered) {
    const full = path.join(LOGS_DIR, f);
    const lines = fs.readFileSync(full, 'utf8').trim().split('\n');
    const hits = lines.filter((l) => /skip:|branch/.test(l)).slice(-25);
    console.log(`  ── ${f} ──`);
    if (!hits.length) { console.log('    （这段时间没有拦截记录）'); continue; }
    for (const l of hits) {
      const t = isTestLine(l);
      if (t) testNoise++;
      console.log('    ' + (t ? '[冒烟测试] ' : '') + l.slice(0, 185));
    }
  }
  if (testNoise) {
    console.log('');
    console.log(`    带 [冒烟测试] 的 ${testNoise} 条是跑测试套件时写进来的，不是你群里的真实消息。`);
  }
}

db.closeDb();
log.closeLogs();
