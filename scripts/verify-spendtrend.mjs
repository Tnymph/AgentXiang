// 在生产数据上跑一遍 /spendtrend 的算法，看它到底会说什么（只读）
import { ensureDirs } from '../src/paths.js';
import * as db from '../src/db.js';
import * as log from '../src/logger.js';
import * as llm from '../src/llm.js';

ensureDirs();
db.openDb();
log.setDebug(false);

const today = new Date().toISOString().slice(0, 10);
console.log('UTC 今天 = ' + today);
console.log('');

console.log('库里有数据的日子（按天汇总调用次数）：');
const days = db.all(
  `select day, sum(calls) as calls, count(distinct bot_id) as bots from api_usage group by day order by day desc`);
if (!days.length) console.log('  （api_usage 还是空的）');
for (const d of days.slice(0, 20)) {
  console.log(`  ${d.day}  ${d.calls} 次调用  涉及 ${d.bots} 个机器人`);
}
console.log('');

for (const [label, ids] of [['全部机器人', []], ['只看客服小向', [1]], ['只看猪咪群友', [2]]]) {
  const t = llm.spendTrend(ids);
  console.log(`════ ${label}（botIds=${JSON.stringify(t.botIds)}）════`);
  console.log(`  今天      ¥${t.today.toFixed(4)}（${t.todayCalls} 次调用）`);
  console.log(`  历史日均  ¥${t.avg.toFixed(4)}   样本 ${t.samples} 天`);
  if (t.avg > 0 && t.today > 0) {
    const diff = (t.today - t.avg) / t.avg;
    console.log(`  对比      今天比日均${diff >= 0 ? '高' : '低'} ${Math.abs(diff * 100).toFixed(0)}%`);
  } else {
    console.log('  对比      （今天没调用过，或还没有历史数据，不给百分比）');
  }
  if (t.perBot.length > 1) {
    console.log('  分号      ' + t.perBot.map((b) => `${b.name} 今天 ¥${b.todaySpent.toFixed(4)}`).join('  /  '));
  }
  console.log('');
}

db.closeDb();
log.closeLogs();
