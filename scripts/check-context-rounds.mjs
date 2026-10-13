// 确认两个机器人的记忆窗口设置
import { ensureDirs } from '../src/paths.js';
import * as db from '../src/db.js';
import * as log from '../src/logger.js';
import { botSettings, defaultBotSettings } from '../src/config.js';

ensureDirs();
db.openDb();
log.setDebug(false);

console.log('默认值：context.rounds = ' + defaultBotSettings().context.rounds);
console.log('');
for (const b of db.listBots()) {
  const s = botSettings(b.id);
  console.log(`机器人 #${b.id} ${b.name}`);
  console.log(`  context.rounds = ${s.context?.rounds}  （一轮 ≈ 一条用户消息 + 一条回复）`);
  console.log(`  摘要功能 = ${JSON.stringify(s.context?.summary)}`);
  // 这个会话现在实际会带多少条进提示词
  for (const sess of db.all('select id, kind, peer_id from sessions where bot_id = ?', b.id)) {
    const n = db.one(
      `select count(*) as n from messages where bot_id = ? and session_id = ? and text <> ?`,
      b.id, sess.id, '')?.n ?? 0;
    const willSend = Math.min(n, Math.max(2, (s.context?.rounds ?? 20) * 2));
    console.log(`    ${sess.kind}:${sess.peer_id}  库里 ${n} 条 → 实际带进提示词 ${willSend} 条`);
  }
}

db.closeDb();
log.closeLogs();
