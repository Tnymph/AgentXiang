// 冒烟测试：OneBot 连接层的重连行为
//
// 重点：握手被拒时（NapCat 没起来、或者 QQ 还没登录）必须安排重连。
// 曾经只监听 close 事件 —— 握手失败时浏览器规范只保证触发 error，close 不一定来，
// 于是第一次连不上就永远卡住，网页一直显示「未连接」，等到天亮也不会好。
import net from 'node:net';
import { OneBot } from '../src/onebot.js';
import * as log from '../src/logger.js';

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', label, extra ?? ''); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('--- 连不上时要自动重试 ---');
// 一个接上就掐断的 TCP 服务：端口在听，但不是 WebSocket —— 模拟「NapCat 还没起来」
const srv = net.createServer((s) => s.destroy());
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

const bot = new OneBot({ botId: 999001, url: `ws://127.0.0.1:${port}/` });
check('刚建好时没有重连定时器', bot.reconnectTimer === null, String(bot.reconnectTimer));
check('刚建好时没连上', bot.connected === false);

bot.connect();
// 看门狗是 8 秒，所以等到 10 秒再断言：真正的行为是「连不上一定会重试」，
// 不管对方是拒绝、还是根本没反应（后者连事件都不会发）。
await wait(10000);
console.log(`    （10 秒后：retry=${bot.retry} 定时器=${bot.reconnectTimer ? '有' : '没有'} connected=${bot.connected}）`);
check('连不上时会自己重试', bot.retry >= 1, `retry=${bot.retry}`);
check('没有假装连上', bot.connected === false);

console.log('--- close() 之后要停下来 ---');
bot.close();
await wait(300);
check('close() 清掉了重连定时器', bot.reconnectTimer === null, String(bot.reconnectTimer));
check('close() 之后不再重连', bot.closedByUser === true);
const retryAfterClose = bot.retry;
await wait(1200);
check('关掉之后不再累积重试', bot.retry === retryAfterClose, `${retryAfterClose} -> ${bot.retry}`);

await new Promise((r) => srv.close(r));
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
log.closeLogs();
