// 给界面验证用：往一个假会话里插一条带图片的消息，看完就删。
//
// 用假群号（999000001），所以它不会进任何真实会话的历史——
// 模型读历史只读自己那个会话，看不到这条。
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, DATA_DIR } from '../src/paths.js';
import * as db from '../src/db.js';
import * as log from '../src/logger.js';
import * as history from '../src/history.js';

ensureDirs();
db.openDb();
log.setDebug(false);

const FAKE_GROUP = '999000001';
const BOT = 2;
const mode = process.argv[2] ?? 'add';

if (mode === 'del') {
  const id = Number(process.argv[3]);
  const sess = db.one("select id from sessions where bot_id = ? and kind = 'group' and peer_id = ?", BOT, FAKE_GROUP);
  db.run('delete from messages where bot_id = ? and session_id = ?', BOT, sess?.id ?? -1);
  db.run("delete from sessions where bot_id = ? and kind = 'group' and peer_id = ?", BOT, FAKE_GROUP);
  console.log(`已清理假会话里的消息${id ? `（目标 #${id}）` : ''}`);
} else {
  // 两张图：一张本机路径（必须走我们的接口），一张 http（浏览器直接取）
  const png = path.join(DATA_DIR, 'tmp', 'ui-probe.png');
  fs.writeFileSync(png, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'));
  const sess = db.ensureSession(BOT, 'group', FAKE_GROUP).id;
  const id = Number(db.run(
    `insert into messages (bot_id, session_id, msg_id, role, person_id, sender_qq, sender_name, text, flags, media, ts)
     values (?,?,?,?,?,?,?,?,?,?,?)`,
    BOT, sess, 'ui-probe', 'user', null, '20001', '界面验证',
    '[图片][图片]', 'image', history.serializeMedia([
      { kind: 'image', url: png },
      { kind: 'image', url: 'http://127.0.0.1:3011/favicon.ico' },   // 这个大概取不到，用来看兜底提示
    ]), Date.now()).lastInsertRowid);
  console.log('插入的消息 id = ' + id + '（假群 ' + FAKE_GROUP + '）');
  console.log('用完执行：node scripts/ui-image-probe.mjs del ' + id);
}

db.closeDb();
log.closeLogs();
