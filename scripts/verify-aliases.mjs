// 验证：机器人 1 的别名是不是「看起来配了 5 个，实际一个都没生效」
import { ensureDirs } from '../src/paths.js';
import * as db from '../src/db.js';
import * as log from '../src/logger.js';
import { botSettings } from '../src/config.js';
import { normalizeEvent } from '../src/message.js';
import { isMentioned, accumulate } from '../src/message.js';

ensureDirs();
db.openDb();
log.setDebug(false);

const BOT = 1;
const s = botSettings(BOT);
const aliases = s.speak?.aliases ?? [];
const selfId = String(db.getBot(BOT).qq ?? '');
const nicknames = ['客服小向', ...aliases];      // worker 里的拼法：登录昵称 + 别名

console.log('别名数组：' + JSON.stringify(aliases));
console.log('元素个数：' + aliases.length + '（界面的规则是「一行一个」，所以这里有 ' + aliases.length + ' 行）');
console.log('');

// worker 实际用的是这个拼法
console.log('════ 实际参与匹配的昵称列表 ════');
nicknames.forEach((n, i) => console.log(`  [${i}] ${JSON.stringify(n)}  （长度 ${n.length}）`));
console.log('');

const cases = ['客服小向', '小向 在吗', '向老师 在吗', '张老师 在吗', '张小向 在吗', '小张 在吗'];
console.log('════ 直接叫它，能不能被认出来 ════');
for (const t of cases) {
  const acc = accumulate([{ type: 'text', data: { text: t } }]);
  const hit = isMentioned(acc, { selfId, nicknames });
  console.log(`  ${hit ? '✅ 认得出' : '❌ 认不出'}  ${JSON.stringify(t)}`);
}

console.log('');
console.log('════ 为什么 ════');
console.log('  匹配规则是「消息里包含某个昵称整串」（text.includes(nickname)）。');
console.log('  那个别名是一整串 "小向 张老师 张小向 向老师 小张"，');
console.log('  只有消息里原样出现这 11 个字才会命中——没人会那么说话。');
console.log('');
console.log('  也就是说：这 5 个称呼实际上**一个都没在起作用**。');
console.log('  现在能回话，靠的是「主动模式」恰好吃到粗筛，以及 @ 它。');

console.log('');
console.log('════ 拆开之后会怎样（仅演示，未改动）════');
const split = ['小向', '张老师', '张小向', '向老师', '小张'];
for (const t of cases) {
  const acc = accumulate([{ type: 'text', data: { text: t } }]);
  const hit = isMentioned(acc, { selfId, nicknames: ['客服小向', ...split] });
  console.log(`  ${hit ? '✅ 认得出' : '❌ 认不出'}  ${JSON.stringify(t)}`);
}
console.log('  ⚠️ 注意「小向」「小张」这类短的通用词容易误触发（别人说「小向」不一定是叫它）');

db.closeDb();
log.closeLogs();
