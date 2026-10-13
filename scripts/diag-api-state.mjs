// ① 当前 API 开关状态 ② #271-#275 当时的拦截分支
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, LOGS_DIR } from '../src/paths.js';
import * as db from '../src/db.js';
import * as log from '../src/logger.js';
import { botSettings } from '../src/config.js';
import * as sch from '../src/modules/schedule.js';
import * as fallback from '../src/modules/fallback.js';

ensureDirs();
db.openDb();
log.setDebug(false);

console.log('════ 当前 API 状态 ════');
for (const bot of db.listBots()) {
  const s = botSettings(bot.id);
  const st = sch.isApiActive(bot.id, s);
  console.log(`  机器人 #${bot.id} ${bot.name}：api.mode=${s.api.mode}  →  现在${st.active ? '【已接入】' : '【未接入】'}（${st.reason ?? ''}）`);
}

console.log('');
console.log('════ 默认回复的冷却设置 ════');
for (const bot of db.listBots()) {
  const s = botSettings(bot.id);
  console.log(`  机器人 #${bot.id}：${JSON.stringify(s.fallback ?? {})}`);
}

console.log('');
console.log('════ 日志里 #271-#275 那段（19:27:30 - 19:35:00）════');
const all = fs.readdirSync(LOGS_DIR).filter((f) => /^chat-/.test(f)).sort();
const file = path.join(LOGS_DIR, all[all.length - 1]);
const lines = fs.readFileSync(file, 'utf8').split('\n');
for (const l of lines) {
  const m = l.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
  if (!m) continue;
  const t = m[1].slice(11);
  if (t >= '19:27:30' && t <= '19:35:00') console.log('  ' + l.trim().slice(0, 190));
}

db.closeDb();
log.closeLogs();
