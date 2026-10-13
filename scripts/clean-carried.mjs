// 一次性清理：把历史里「承接来的」消息补上 carried 标记
//
// 承接机制是刚加的，之前那些「只发了个 @、文字从上一条借来」的消息没有标记，
// 于是它们被当成用户原话参与了印象提炼（同一句算两次）。
// 判据：同一会话里，某条用户消息的文字与紧邻的上一条完全相同、间隔在 2 分钟内、
//       且两边都没有别的标记——这正是承接产生的形态，正常聊天不会这样。
import { ensureDirs } from '../src/paths.js';
import * as db from '../src/db.js';
import * as log from '../src/logger.js';

ensureDirs();
db.openDb();

const WINDOW_MS = 120_000;

const rows = db.all(`
  select id, bot_id, session_id, role, text, flags, ts
  from messages where role = 'user' and text <> ''
  order by bot_id, session_id, ts asc, id asc`);

let marked = 0;
const samples = [];
let prev = null;

for (const r of rows) {
  const sameChain = prev
    && prev.bot_id === r.bot_id
    && prev.session_id === r.session_id
    && prev.text === r.text
    && (r.ts - prev.ts) < WINDOW_MS
    && !String(r.flags).includes('command')
    && !String(prev.flags).includes('command')
    && !String(r.flags).includes('carried');

  if (sameChain) {
    const flags = [String(r.flags ?? '').trim(), 'carried'].filter(Boolean).join(',');
    db.run('update messages set flags = ? where id = ?', flags, r.id);
    marked++;
    if (samples.length < 8) samples.push(`#${r.id} ${r.text.slice(0, 30)}`);
  }
  prev = r;
}

console.log(`扫描 ${rows.length} 条用户消息，补标记 ${marked} 条`);
for (const s of samples) console.log('  ' + s);

// 复查素材
const impression = await import('../src/modules/impression.js');
const utt = impression.recentUtterances(1, 2);
const bad = utt.filter((t) => t.includes('/learn') || t.includes('/help'));
console.log('');
console.log(`人#2 的素材现在 ${utt.length} 条，其中含命令的 ${bad.length} 条`);
for (const t of bad) console.log('  残留: ' + t);

db.closeDb();
log.closeLogs();
