// 数一数最近一小时：谁被频控丢了多少条、成功发出多少条
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, LOGS_DIR } from '../src/paths.js';
import * as db from '../src/db.js';
import * as log from '../src/logger.js';
import { botSettings } from '../src/config.js';

ensureDirs();
db.openDb();
log.setDebug(false);

console.log('════ 频控阈值设置 ════');
for (const bot of db.listBots()) {
  const r = botSettings(bot.id).rate ?? {};
  console.log(`  机器人 #${bot.id} ${bot.name}：`);
  console.log(`    非重复内容  ${r.unique?.max ?? 20} 条 / ${r.unique?.windowSec ?? 3600} 秒（按人计）`);
  console.log(`    重复内容    ${r.repeat?.max ?? 1} 条 / ${r.repeat?.windowSec ?? 60} 秒（按人计）`);
  console.log(`    全局        ${r.global?.perMinute ?? 10} 条/分，${r.global?.perHour ?? 300} 条/时（不分人）`);
}

// 解析聊天日志：统计最近一小时的分支
const files = fs.readdirSync(LOGS_DIR).filter((f) => /^chat-/.test(f)).sort();
const lines = [];
for (const f of files.slice(-2)) {
  lines.push(...fs.readFileSync(path.join(LOGS_DIR, f), 'utf8').split('\n'));
}

const now = Date.now();
const HOUR = 60 * 60 * 1000;
const stat = new Map();       // botId -> { sent, limited, skipped, passed }

for (const l of lines) {
  const m = l.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.(\d+)/);
  if (!m) continue;
  const ts = new Date(m[1].replace(' ', 'T') + '.' + m[2] + 'Z').getTime();
  if (!(now - ts < HOUR)) continue;
  const bot = Number((l.match(/bot=(\d+)/) ?? [])[1] ?? 0);
  if (!bot) continue;
  const s = stat.get(bot) ?? { sent: 0, limited: 0, skipped: 0, passed: 0, random: 0 };
  if (/branch=(passive|active|echo)\b/.test(l) || / out who=bot /.test(l)) s.sent++;
  if (/ratelimited:/.test(l)) s.limited++;
  if (/branch=active:empty|branch=passive:empty/.test(l)) s.passed++;
  if (/branch=skip:/.test(l)) s.skipped++;
  if (/随机未命中/.test(l)) s.random++;
  stat.set(bot, s);
}

console.log('');
console.log('════ 最近一小时（按日志统计）════');
for (const [botId, s] of [...stat.entries()].sort()) {
  const name = db.getBot(botId)?.name ?? '';
  console.log(`  机器人 #${botId} ${name}：`);
  console.log(`    成功发出（含被后续步骤拦下的）  ${s.sent}`);
  console.log(`    ⚠️ 被频控丢掉                    ${s.limited}`);
  console.log(`    模型自己选择不说（<pass>）        ${s.passed}`);
  console.log(`    粗筛拦下                        ${s.skipped}（其中随机未命中 ${s.random}）`);
}

console.log('');
console.log('被频控丢掉的那些，原文（前 12 条）：');
const lost = lines.filter((l) => /ratelimited:/.test(l)).slice(-12);
for (const l of lost) console.log('  ' + l.trim().slice(0, 150));

console.log('');
console.log('════ 最近一小时里机器人实际发出的消息（数据库）════');
const since = now - HOUR;
for (const r of db.all(
  `select bot_id, count(*) as n from messages where role = 'bot' and ts > ? group by bot_id`, since)) {
  console.log(`  机器人 #${r.bot_id}：${r.n} 条`);
}

db.closeDb();
log.closeLogs();
