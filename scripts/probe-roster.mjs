// 只读探针：验证真实 NapCat 支不支持 get_group_member_list，
// 顺便看看 @ 现在能不能解析出人名。
//
// 只调只读接口，不发任何消息。用完立刻断开。
import { ensureDirs } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as db from '../src/db.js';
import * as names from '../src/names.js';
import { botSettings, loadGlobal } from '../src/config.js';
import { OneBot } from '../src/onebot.js';
import { normalizeEvent } from '../src/message.js';

ensureDirs();
db.openDb();
log.setDebug(false);

const global = loadGlobal();
const bots = db.listBots();
const probes = [];

for (const bot of bots) {
  const s = botSettings(bot.id);
  // 每个机器人可以有自己的 NapCat 地址，没配就用全局的
  const url = s.napcatWsUrl || global?.napcat?.wsUrl || '';
  const groups = db.all(
    `select peer_id from sessions where bot_id = ? and kind = 'group' order by last_active desc limit 5`, bot.id);
  probes.push({ bot, url, groups: groups.map((g) => String(g.peer_id)) });
}

for (const p of probes) {
  console.log('');
  console.log('════════ 机器人 #' + p.bot.id + ' ' + p.bot.name + ' ════════');
  console.log('WS 地址：' + (p.url || '(未配置)'));
  if (!p.url) { console.log('没配地址，跳过'); continue; }

  const client = new OneBot({ botId: p.bot.id, url: p.url, name: p.bot.name });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('连接超时')), 12000);
      client.on('ready', ({ selfId }) => { clearTimeout(t); resolve(selfId); });
      client.connect();
    });
    console.log('已连接');

    let login = null;
    try { login = await client.getLoginInfo(); } catch (e) { console.log('get_login_info 失败：' + e.message); }
    const selfId = String(login?.user_id ?? client.selfId ?? '');
    console.log('登录号：' + selfId + '   昵称：' + (login?.nickname ?? '(无)'));

    for (const gid of p.groups) {
      let list = null;
      let err = null;
      try {
        list = await client.call('get_group_member_list', { group_id: Number(gid) }, 30000);
      } catch (e) { err = e.message; }

      if (err) {
        console.log(`群 ${gid}：get_group_member_list 失败 —— ${err}`);
        continue;
      }
      const n = Array.isArray(list) ? list.length : 0;
      const filled = names.rememberRoster(p.bot.id, gid, list);
      console.log(`群 ${gid}：拿到 ${n} 个成员，其中 ${filled} 个有可用名字`);
      const sample = (list ?? []).slice(0, 3).map((m) =>
        `${m.user_id}=${JSON.stringify(m.card || m.nickname || '')}`);
      console.log('   样例：' + sample.join('   '));
      // 确认 at 段会真的用上：模拟库里出现过的两个 QQ
      for (const qq of ['3046116373', '3998561404', '10000001', '10000002']) {
        const nm = names.resolveName(p.bot.id, qq, { groupId: gid, selfId, selfNames: [login?.nickname ?? ''] });
        if (nm) console.log(`   ${qq} → ${nm}`);
      }
    }
  } catch (e) {
    console.log('连接失败：' + e.message);
  } finally {
    client.close();
  }
}

// 用真实事件形状走一遍 normalizeEvent，对比修复前后
console.log('');
console.log('════════ 修复效果对照（真实 at 段形状：只有 qq）════════');
names.clearRosters();
const fakeEvent = {
  post_type: 'message', message_type: 'group', group_id: 555001, user_id: 20001,
  message_id: 1, time: 1730000000, sender: { card: '张三' },
  message: [
    { type: 'at', data: { qq: 3046116373 } },     // 机器人自己
    { type: 'text', data: { text: ' 你看这个' } },
    { type: 'at', data: { qq: 10000001 } },       // 群友
    { type: 'at', data: { qq: 777777 } },         // 谁都没见过
  ],
};
const noResolver = normalizeEvent(fakeEvent, { selfId: '3046116373', nicknames: ['客服小向'] });
console.log('没有解析器时 text ：' + JSON.stringify(noResolver.text));

const bots1 = bots.find((b) => b.id === 1);
if (bots1) {
  const s1 = botSettings(1);
  const login = null;
  const resolver = (qq) => names.resolveName(1, qq, { groupId: '555001', selfId: '3046116373', selfNames: ['客服小向'] });
  const withResolver = normalizeEvent(fakeEvent, {
    selfId: '3046116373', nicknames: ['客服小向', ...(s1.speak?.aliases ?? [])], resolveName: resolver,
  });
  console.log('有解析器时 textClean：' + JSON.stringify(withResolver.textClean));
  console.log('（库里已见过的人会从历史名字解析出来，所以张三能显示）');
}

db.closeDb();
log.closeLogs();
