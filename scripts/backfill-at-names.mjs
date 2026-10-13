// 回填：把历史消息里已经存成 QQ 号的 @ 换成人名。
//
// 修复前 message.js 把 at 段渲染成 `@QQ号`，库里因此留下了「@3046116373」这种文本，
// 既显示不出来是谁，也会被当成上下文喂给模型。这里只改 `@数字` 这一种片段，
// 其余字符原样不动；解析不出名字的保留原样。
//
// 默认干跑，加 --apply 才写库。改动前会把原文本导出到 data/tmp 备份。
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, TMP_DIR } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as db from '../src/db.js';
import * as names from '../src/names.js';
import * as history from '../src/history.js';
import { botSettings, loadGlobal } from '../src/config.js';
import { OneBot } from '../src/onebot.js';

const APPLY = process.argv.includes('--apply');

ensureDirs();
db.openDb();
log.setDebug(false);

const global = loadGlobal();
const bots = db.listBots();

// 先把每个机器人所在群的花名册取回来——这样回填出来的名字和以后新消息一致
for (const bot of bots) {
  const s = botSettings(bot.id);
  const url = s.napcatWsUrl || global?.napcat?.wsUrl || '';
  if (!url) continue;
  const groups = db.all(
    `select peer_id from sessions where bot_id = ? and kind = 'group'`, bot.id).map((g) => String(g.peer_id));
  if (!groups.length) continue;
  const client = new OneBot({ botId: bot.id, url, name: bot.name });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('连接超时')), 12000);
      client.on('ready', () => { clearTimeout(t); resolve(); });
      client.connect();
    });
    for (const gid of groups) {
      try {
        const list = await client.call('get_group_member_list', { group_id: Number(gid) }, 30000);
        names.rememberRoster(bot.id, gid, list);
      } catch { /* 取不到就靠历史名字 */ }
    }
  } catch (e) {
    console.log(`机器人 #${bot.id} 连不上（${e.message}），这个号只用历史名字`);
  } finally {
    client.close();
  }
}

for (const bot of bots) {
  const s = botSettings(bot.id);
  const aliases = Array.isArray(s.speak?.aliases) ? s.speak.aliases.filter(Boolean) : [];
  // 机器人自己被 @ 时显示的是它的名字；bots.name 通常就是群名片
  const selfNames = [bot.name, ...aliases].filter(Boolean);

  const rows = db.all(
    `select id, session_id, text from messages
      where bot_id = ? and text glob '*@[0-9]*' order by id`, bot.id);

  if (!rows.length) {
    console.log(`机器人 #${bot.id} ${bot.name}：没有需要回填的消息`);
    continue;
  }

  const session = new Map();
  for (const r of rows) {
    if (!session.has(r.session_id)) {
      session.set(r.session_id, db.one('select kind, peer_id from sessions where id = ?', r.session_id));
    }
  }

  const changes = [];
  for (const r of rows) {
    const sess = session.get(r.session_id);
    const groupId = sess?.kind === 'group' ? String(sess.peer_id) : null;
    const next = String(r.text).replace(/@(\d{4,12})/g, (whole, qq) => {
      const nm = names.resolveName(bot.id, qq, {
        groupId,
        selfId: bot.qq ? String(bot.qq) : null,
        selfNames,
      });
      return nm ? `@${nm}` : whole;
    });
    if (next !== r.text) changes.push({ id: r.id, before: r.text, after: next });
  }

  console.log('');
  console.log(`机器人 #${bot.id} ${bot.name}：扫到 ${rows.length} 条含 @数字 的消息，可改 ${changes.length} 条`);
  for (const c of changes) {
    console.log(`  #${c.id}`);
    console.log(`    改前 ${JSON.stringify(String(c.before).slice(0, 100))}`);
    console.log(`    改后 ${JSON.stringify(String(c.after).slice(0, 100))}`);
  }

  if (!APPLY || !changes.length) continue;

  // 备份原文本，万一要退回去
  const backup = path.join(TMP_DIR, `at-backfill-bot${bot.id}-${Date.now()}.json`);
  fs.writeFileSync(backup, JSON.stringify(changes.map((c) => ({ id: c.id, text: c.before })), null, 0), 'utf8');
  for (const c of changes) {
    db.run('update messages set text = ? where id = ? and bot_id = ?', c.after, c.id, bot.id);
  }
  console.log(`  已写入 ${changes.length} 条；原文本备份在 ${backup}`);
}

if (!APPLY) console.log('\n（这是干跑，没有写库。加 --apply 才真正修改）');

// 回填完顺手看一下还剩多少条带 QQ 号
const left = db.all(`select bot_id, count(*) as n from messages where text glob '*@[0-9]*' group by bot_id`);
console.log('');
console.log('剩余仍含 @数字 的消息：' + (left.length ? JSON.stringify(left) : '无'));

db.closeDb();
log.closeLogs();
