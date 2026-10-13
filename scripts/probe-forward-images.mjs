// 能不能取到「合并转发里的图」？直接问 NapCat。
//
// 路径：库里存着 msg_id → get_msg 拿到那条消息的段 → 取出 forward 段的 id
//       → get_forward_msg 拿到节点树 → 看图片段的 data 里有没有可取地址。
import { ensureDirs } from '../src/paths.js';
import * as db from '../src/db.js';
import * as log from '../src/logger.js';
import { botSettings, loadGlobal } from '../src/config.js';
import { OneBot } from '../src/onebot.js';

ensureDirs();
db.openDb();
log.setDebug(false);

const global = loadGlobal();

// 找出带 forward 标记的消息（有 msg_id 才有戏）
const rows = db.all(
  `select id, bot_id, msg_id, text, flags, ts from messages
   where flags like '%forward%' or text like '%聊天记录%'
   order by id desc limit 20`);
console.log('库里带转发线索的消息：');
for (const r of rows) {
  console.log(`  #${r.id} bot${r.bot_id} msg_id=${r.msg_id} flags=${r.flags} text=${JSON.stringify(String(r.text).slice(0, 40))}`);
}
if (!rows.length) { console.log('（没有，没法反查）'); db.closeDb(); log.closeLogs(); process.exit(0); }

// 按机器人分组，连各自的 NapCat
const byBot = new Map();
for (const r of rows) {
  if (!byBot.has(r.bot_id)) byBot.set(r.bot_id, []);
  byBot.get(r.bot_id).push(r);
}

for (const [botId, list] of byBot) {
  const s = botSettings(botId);
  const url = s.napcatWsUrl || global?.napcat?.wsUrl || '';
  if (!url) { console.log(`\n机器人 #${botId} 没配地址，跳过`); continue; }
  const client = new OneBot({ botId, url, name: 'probe' });
  console.log(`\n════ 机器人 #${botId}  ════`);
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('连接超时')), 12000);
      client.on('ready', () => { clearTimeout(t); resolve(); });
      client.connect();
    });

    for (const r of list) {
      console.log(`\n── 消息 #${r.id} (msg_id=${r.msg_id}) ──`);
      let got = null;
      try { got = await client.getMsg(r.msg_id); } catch (e) { console.log('  get_msg 失败：' + e.message); continue; }
      const segs = Array.isArray(got?.message) ? got.message : [];
      console.log('  段类型：' + segs.map((x) => x.type).join(', ') + `  （共 ${segs.length} 段）`);
      const fwdIds = segs.filter((x) => x?.type === 'forward').map((x) => x.data?.id).filter(Boolean);
      if (!fwdIds.length) { console.log('  这条消息里没有 forward 段'); continue; }
      console.log('  forward id：' + fwdIds.join(', '));

      for (const fid of fwdIds) {
        let fw = null;
        try { fw = await client.getForwardMsg(fid); } catch (e) { console.log(`  get_forward_msg(${fid}) 失败：` + e.message); continue; }
        const nodes = fw?.messages ?? fw?.data?.messages ?? fw?.nodes ?? [];
        console.log(`  ✅ get_forward_msg 拿到 ${nodes.length} 个节点`);
        const typeCount = new Map();
        const imageDetails = [];
        for (const n of nodes) {
          const raw = n?.message ?? n?.content ?? [];
          const segs2 = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [{ type: 'text', data: { text: raw } }] : []);
          for (const sg of segs2) {
            typeCount.set(sg?.type, (typeCount.get(sg?.type) ?? 0) + 1);
            if (sg?.type === 'image') imageDetails.push(sg.data ?? {});
          }
        }
        console.log('  段类型统计：' + [...typeCount.entries()].map(([k, v]) => `${k}×${v}`).join('  '));
        if (imageDetails.length) {
          console.log(`  ★ 里面有 ${imageDetails.length} 张图，字段如下（这就是能不能取到的关键）：`);
          for (const d of imageDetails.slice(0, 4)) {
            console.log('     ' + JSON.stringify(d).slice(0, 300));
          }
        } else {
          console.log('  （这个转发里没有图片段）');
        }
      }
    }
  } catch (e) {
    console.log('  连接失败：' + e.message);
  } finally {
    client.close();
  }
}

db.closeDb();
log.closeLogs();
