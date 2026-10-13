// 冒烟测试：数据库建表与「老库补列」
//
// 为什么要单独测这个：建表用的是 `create table if not exists`，
// 表已经在了整段就跳过——新加的列不会自己出现。测试库都是新建的，
// 走不到迁移分支，于是「老库升上来」这条路一直没人验过。
// 而真实的生产库正是老库，迁移一旦失败就是打不开。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureDirs, DATA_DIR } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as db from '../src/db.js';
import * as history from '../src/history.js';

ensureDirs();
const TEST_DB = path.join(DATA_DIR, 'test9.sqlite');
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.unlinkSync(f); } catch { /* 忽略 */ }
}

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', label, extra ? '→ ' + extra : ''); }
};

// ---------- 先手工造一个「老库」：没有 media 列的那种 ----------
console.log('--- 老库补列 ---');
{
  const old = new DatabaseSync(TEST_DB);
  old.prepare(`create table bots (
    id integer primary key autoincrement, name text not null, qq text,
    enabled_local integer not null default 1, settings text not null default '{}',
    created_at integer not null, updated_at integer not null)`).run();
  old.prepare(`create table sessions (
    id integer primary key autoincrement, bot_id integer not null, kind text not null,
    peer_id text not null, last_active integer, unique (bot_id, kind, peer_id))`).run();
  // 关键：老版本的 messages 表，没有 media 列
  old.prepare(`create table messages (
    id integer primary key autoincrement, bot_id integer not null, session_id integer not null,
    msg_id text, role text not null, person_id integer, sender_qq text, sender_name text,
    text text not null default '', flags text not null default '', ts integer not null)`).run();
  old.prepare(`insert into bots (name, qq, enabled_local, settings, created_at, updated_at)
               values ('老机器人', '10001', 1, '{}', 1, 1)`).run();
  old.prepare(`insert into sessions (bot_id, kind, peer_id, last_active) values (1, 'group', '555001', 1)`).run();
  old.prepare(`insert into messages (bot_id, session_id, msg_id, role, person_id, sender_qq, sender_name, text, flags, ts)
               values (1, 1, 'old-1', 'user', null, '20001', '张三', '老消息', '', 1)`).run();
  old.prepare(`insert into messages (bot_id, session_id, msg_id, role, person_id, sender_qq, sender_name, text, flags, ts)
               values (1, 1, 'old-2', 'user', null, '20001', '张三', '', 'image', 2)`).run();
  old.close();
}
const colsBefore = (() => {
  const d = new DatabaseSync(TEST_DB);
  const c = d.prepare('pragma table_info(messages)').all().map((x) => x.name);
  d.close();
  return c;
})();
check('造出来的老库确实没有 media 列', !colsBefore.includes('media'), colsBefore.join(','));

// ---------- 用现在的代码打开它：应当自动补列 ----------
db.openDb(TEST_DB);

const colsAfter = db.all('pragma table_info(messages)').map((c) => c.name);
check('打开后 media 列补上了', colsAfter.includes('media'), colsAfter.join(','));

const kept = db.all('select msg_id, text, flags, media from messages order by id');
check('老数据一条没丢', kept.length === 2, String(kept.length));
check('老消息正文原样', kept[0]?.text === '老消息' && kept[0]?.flags === '', JSON.stringify(kept[0]));
check('老的图片消息仍在（当时没存地址）', kept[1]?.text === '' && kept[1]?.flags === 'image', JSON.stringify(kept[1]));
check('老记录补列后 media 是空的', kept.every((r) => r.media === ''), JSON.stringify(kept.map((r) => r.media)));
check('空 media 解析成空数组', history.parseMedia(kept[0]).length === 0);
check('老库里的机器人还在', db.listBots().length === 1 && db.listBots()[0].name === '老机器人');
check('老库也能继续写消息（新列不挡写入）',
  Number(history.saveUserMessage({
    botId: 1, sessionId: 1, msgId: 'new-1', personId: null,
    senderQq: '20001', senderName: '张三', text: '[图片]', flags: 'image',
    media: [{ kind: 'image', url: '/tmp/a.png' }],
  })) > 0);
check('新写的消息 media 存下来了',
  history.parseMedia(db.one("select * from messages where msg_id = 'new-1'"))[0]?.url === '/tmp/a.png');

// 幂等：再开一次不该报错、不该重复补列、数据仍在
db.closeDb();
db.openDb(TEST_DB);
check('重复打开不报错且数据仍在',
  db.all('select count(*) as n from messages')[0].n === 3,
  String(db.all('select count(*) as n from messages')[0].n));
check('重复打开后 media 列还在', db.all('pragma table_info(messages)').some((c) => c.name === 'media'));

// ---------- 全新库：建表语句里就该带着 media ----------
console.log('--- 全新库 ---');
db.closeDb();
const FRESH_DB = path.join(DATA_DIR, 'test9b.sqlite');
for (const f of [FRESH_DB, FRESH_DB + '-wal', FRESH_DB + '-shm']) {
  try { fs.unlinkSync(f); } catch { /* 忽略 */ }
}
db.openDb(FRESH_DB);
const freshCols = db.all('pragma table_info(messages)').map((c) => c.name);
check('全新库直接就有 media 列', freshCols.includes('media'), freshCols.join(','));
check('全新库别的列也没少',
  ['id', 'bot_id', 'session_id', 'msg_id', 'role', 'person_id', 'sender_qq', 'sender_name', 'text', 'flags', 'ts']
    .every((c) => freshCols.includes(c)), freshCols.join(','));
const freshBot = db.createBot('全新机器人', '10002');
check('全新库能建机器人', freshBot > 0, String(freshBot));

// ---------- media 序列化 ----------
console.log('--- media 序列化 ---');
check('没有 media 时存空串', history.serializeMedia(null) === '');
check('空数组存空串', history.serializeMedia([]) === '');
check('地址为空的条目被丢掉', history.serializeMedia([{ kind: 'image', url: '  ' }]) === '');
check('正常条目存成 JSON',
  history.serializeMedia([{ kind: 'image', url: '/a.png' }]) === '[{"kind":"image","url":"/a.png"}]');
check('默认 kind 是 image',
  history.serializeMedia([{ url: '/a.png' }]) === '[{"kind":"image","url":"/a.png"}]');
check('坏 JSON 解析不炸', history.parseMedia({ media: '{坏' }).length === 0);
check('非数组 JSON 解析成空', history.parseMedia({ media: '{"a":1}' }).length === 0);
check('直接传字符串也能解析', history.parseMedia('[{"url":"/b.png"}]')[0]?.url === '/b.png');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
db.closeDb();
log.closeLogs();
