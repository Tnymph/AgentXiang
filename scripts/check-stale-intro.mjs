// 群里的记忆窗口（最近 20 轮）里还有没有「我是张老师」这类旧自我介绍
import { ensureDirs } from '../src/paths.js';
import * as db from '../src/db.js';
import * as log from '../src/logger.js';
import { botSettings } from '../src/config.js';

ensureDirs();
db.openDb();
log.setDebug(false);

const BOT = 1;
const rounds = botSettings(BOT).context?.rounds ?? 20;

console.log(`记忆窗口 = 最近 ${rounds} 轮（${rounds * 2} 条）`);
console.log('');

for (const s of db.all('select id, kind, peer_id from sessions where bot_id = ?', BOT)) {
  const limit = Math.max(2, rounds * 2);
  const rows = db.all(
    `select id, role, text, ts from messages
     where bot_id = ? and session_id = ? and text <> ''
     order by ts desc, id desc limit ?`, BOT, s.id, limit);
  if (!rows.length) continue;

  const stale = rows.filter((r) => r.role === 'bot' && /张老师|张小向/.test(r.text));
  const total = db.one(
    'select count(*) as n from messages where bot_id = ? and session_id = ? and text <> ?', BOT, s.id, '')?.n ?? 0;

  console.log(`会话 ${s.kind}:${s.peer_id}  窗口内 ${rows.length} 条（全库 ${total} 条）`);
  if (!stale.length) {
    console.log('  ✅ 窗口里没有旧的自我介绍');
  } else {
    for (const r of stale) {
      console.log(`  ⚠️ 还留在窗口里 #${r.id} ${new Date(r.ts).toLocaleTimeString('zh-CN')} ${JSON.stringify(String(r.text).slice(0, 50))}`);
    }
    // 这条旧消息后面还有多少条，决定它多久滑出去
    for (const r of stale) {
      const after = db.one(
        `select count(*) as n from messages where bot_id = ? and session_id = ? and id > ? and text <> ?`,
        BOT, s.id, r.id, '')?.n ?? 0;
      console.log(`     它后面还有 ${after} 条 → 再有 ${Math.max(0, limit - after)} 条它就滑出窗口`);
    }
  }
}

db.closeDb();
log.closeLogs();
