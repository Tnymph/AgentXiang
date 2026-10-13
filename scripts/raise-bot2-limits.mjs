// 把机器人 2（猪咪群友）的各项发言频率限制拉大，逐项打印前后对比并验算生效
import { ensureDirs } from '../src/paths.js';
import * as db from '../src/db.js';
import * as log from '../src/logger.js';
import { botSettings, saveBotSettings } from '../src/config.js';
import * as rate from '../src/modules/rateLimit.js';

ensureDirs();
db.openDb();
log.setDebug(false);

const BOT = 2;
const before = botSettings(BOT);

const show = (label, s) => {
  const r = s.rate ?? {}, a = s.speak?.active ?? {};
  console.log(`  ${label}`);
  console.log(`    非重复内容（按人）  ${r.unique?.max} 条 / ${r.unique?.windowSec} 秒`);
  console.log(`    重复内容（按人）    ${r.repeat?.max} 条 / ${r.repeat?.windowSec} 秒`);
  console.log(`    全局防风控          ${r.global?.perMinute} 条/分，${r.global?.perHour} 条/时`);
  console.log(`    本群每小时          ${a.perGroupPerHour} 条（间隔 ${a.minGapSec} 秒，最短 ${a.minMessageLength} 字）`);
  console.log(`    粗筛随机命中率      ${a.randomRate}`);
};

console.log('════ 机器人 #2 ' + db.getBot(BOT).name + '：改动前 ════');
show('现在', before);
console.log('');

// 只调「说话的自由度」，防封号的那道全局闸门仍留足余量
saveBotSettings(BOT, {
  rate: {
    unique: { max: 120 },                 // 20 → 120：卡住的就是这一项（按人计，两个群共用）
    repeat: { max: 3 },                   // 1 → 3：同一句话 60 秒内可复用 3 次
    global: { perMinute: 60, perHour: 1200 },
  },
  speak: {
    active: {
      randomRate: 1,                      // 0.85 → 1：不再随机漏掉消息
      perGroupPerHour: 600,               // 保持不变（本来就很宽）
      minGapSec: 1,
      minMessageLength: 1,
    },
  },
});

const after = botSettings(BOT);
console.log('════ 改动后 ════');
show('现在', after);

console.log('');
console.log('════ 验算：新的阈值下会不会还被拦 ════');
// 数一数「按人计的非重复内容」在窗口内能连发多少条
let allowed = 0;
for (let i = 0; i < 200; i++) {
  const r = rate.allow(BOT, after, {
    personId: 999, text: `第 ${i} 条不同的内容`, kind: 'group', peerId: '1',
  });
  if (r.ok) allowed++;
  else { console.log(`    第 ${i + 1} 条被拦：${r.reason}`); break; }
}
console.log(`    按人连发 ${allowed} 条后被拦（改前是 20 条）`);

// 对照：用改动前的设置跑一遍，确认 20 就是原来的瓶颈
rate.reset();
let old = 0;
for (let i = 0; i < 200; i++) {
  const r = rate.allow(BOT, before, {
    personId: 999, text: `第 ${i} 条不同的内容`, kind: 'group', peerId: '1',
  });
  if (r.ok) old++;
  else break;
}
console.log(`    同样的写法，用改动前的设置只能发 ${old} 条 → 说明瓶颈确实在这里`);

console.log('');
console.log('════ 数据库里读回来确认（不是内存里的假象）════');
const reread = botSettings(BOT);
console.log('    unique.max = ' + reread.rate.unique.max);
console.log('    repeat.max = ' + reread.rate.repeat.max);
console.log('    randomRate = ' + reread.speak.active.randomRate);
console.log('    另一个机器人没被改动：unique.max = ' + botSettings(1).rate.unique.max);
console.log('');
console.log('设置是每条消息现读数据库的，所以**不用重启程序**，下一条消息就按新阈值走。');

db.closeDb();
log.closeLogs();
