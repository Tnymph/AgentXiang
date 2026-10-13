// 看两个机器人当前的发言模式与主动粗筛参数
import { ensureDirs } from '../src/paths.js';
import * as db from '../src/db.js';
import * as log from '../src/logger.js';
import { botSettings } from '../src/config.js';

ensureDirs();
db.openDb();
log.setDebug(false);

for (const bot of db.listBots()) {
  const s = botSettings(bot.id);
  const sp = s.speak ?? {};
  console.log('════ 机器人 #' + bot.id + ' ' + bot.name + ' ════');
  console.log('  默认群模式：' + sp.defaultGroupMode);
  console.log('  按群覆盖：' + JSON.stringify(sp.groupModes ?? {}));
  console.log('  私聊模式：' + sp.privateMode);
  console.log('  主动粗筛：' + JSON.stringify(sp.active ?? {}));
  console.log('  复读：' + JSON.stringify(sp.repeatEcho ?? {}));
  const groups = db.all(
    `select peer_id from sessions where bot_id = ? and kind = 'group' order by last_active desc`, bot.id);
  for (const g of groups) {
    const per = sp.groupModes?.[String(g.peer_id)];
    const effective = ['active', 'passive', 'off'].includes(per) ? per : (sp.defaultGroupMode ?? 'passive');
    console.log(`  群 ${g.peer_id} → 生效模式 = ${effective}${per ? '（该群单独设置）' : ''}`);
  }
  console.log('');
}

db.closeDb();
log.closeLogs();
