// 冒烟测试：运行控制（网页「运行」页那些启停按钮背后的东西）
//
// 这个套件**不会真的启动或停止任何东西**：只验证参数白名单、端口探测、状态结构和
// 非法输入被拒。唯一会真动的一次是「已经在跑时不重复启动」——前提是它确实在跑。
import net from 'node:net';
import path from 'node:path';
import {
  assertSafeToken, assertQq, assertInside, portOfWsUrl, probeTcp, status, act, findAsrRuntime, napcatTarget,
} from '../src/modules/system.js';
import * as db from '../src/db.js';
import * as log from '../src/logger.js';

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', label, extra ?? ''); }
};

// ---------- 参数白名单：这是防命令注入的闸门 ----------
console.log('--- assertSafeToken ---');
for (const s of ['napcat', 'napcat2', 'qq-bot2-data', 'a.b_c-d', 'A1']) {
  let ok = true;
  try { assertSafeToken(s); } catch { ok = false; }
  check(`放行 ${JSON.stringify(s)}`, ok);
}
for (const s of ['x & del /f /q E:\\', '..', '.', '...', '-x', '--user-data-dir=evil', 'a b', '', 'a/b', 'a\\b', 'x;y', '$(whoami)', 'a|b', 'a>b', 'a"b', 'x\n&amp;y']) {
  let threw = false;
  try { assertSafeToken(s); } catch { threw = true; }
  check(`拒绝 ${JSON.stringify(s.slice(0, 24))}`, threw);
}

console.log('--- assertQq ---');
for (const s of ['3046116373', '3998561404', '10001']) {
  let ok = true;
  try { assertQq(s); } catch { ok = false; }
  check(`放行 ${s}`, ok);
}
for (const s of ['abc', '123', '3046116373abc', '', ' 3046116373', '3046 116373', '3046116373;rm']) {
  let threw = false;
  try { assertQq(s); } catch { threw = true; }
  check(`拒绝 ${JSON.stringify(s)}`, threw);
}

// ---------- 路径必须落在允许的目录里（扫目录发现来的路径也走这一关） ----------
console.log('--- assertInside ---');
const baseDir = path.join(process.cwd(), 'data');
for (const rel of [path.join('sub', 'x.exe'), path.join('a', 'b', 'c.onnx')]) {
  let ok = true;
  try { assertInside(baseDir, path.join(baseDir, rel)); } catch { ok = false; }
  check(`放行 ${rel}`, ok);
}
for (const bad of [path.join(baseDir, '..', 'evil.exe'), path.join(process.cwd(), 'src'), baseDir, '']) {
  let threw = false;
  try { assertInside(baseDir, bad); } catch { threw = true; }
  check(`拒绝 ${bad || '(空)'}`, threw);
}

// ---------- 从 ws 地址取端口 ----------
console.log('--- portOfWsUrl ---');
check('ws://127.0.0.1:3001 -> 3001', portOfWsUrl('ws://127.0.0.1:3001') === 3001);
check('ws://127.0.0.1:3011 -> 3011', portOfWsUrl('ws://127.0.0.1:3011') === 3011);
check('空串 -> 0', portOfWsUrl('') === 0);
check('乱七八糟 -> 0', portOfWsUrl('不是地址') === 0);
check('没有端口 -> 0', portOfWsUrl('ws://127.0.0.1/ws') === 0);

// ---------- 端口探测 ----------
console.log('--- probeTcp ---');
check('没人听的端口 -> false', (await probeTcp(61899)) === false);
check('端口 0 -> false', (await probeTcp(0)) === false);
const srv = net.createServer();
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const openPort = srv.address().port;
check('有人在听的端口 -> true', (await probeTcp(openPort)) === true);
await new Promise((r) => srv.close(r));

// ---------- 状态结构 ----------
console.log('--- status ---');
db.openDb();
const st = await status();
check('有 platform', typeof st.platform === 'string');
check('bot.running 为真（能算出来就说明本进程活着）', st.bot.running === true);
check('bot.pid 是数字', Number.isInteger(st.bot.pid));
check('napcat 是数组', Array.isArray(st.napcat));
check('每个 napcat 项都有 key/port', st.napcat.every((n) => String(n.key).startsWith('napcat:') && Number.isInteger(n.port)));
check('asr.port 是数字', Number.isInteger(st.asr.port));
check('asr.installed 是布尔', typeof st.asr.installed === 'boolean');
check('有 restartHint 文案', typeof st.restartHint === 'string' && st.restartHint.length > 10);
console.log('    （本机：napcat ' + st.napcat.map((n) => `${n.port}=${n.running ? '在线' : '离线'}`).join(' ') +
  '；asr ' + st.asr.port + '=' + (st.asr.running ? '在线' : '离线') + '）');

// ---------- 非法输入必须被拒，且不能有任何副作用 ----------
console.log('--- act 拒绝非法输入 ---');
const rejects = [
  ['bot', 'explode'],
  ['nope', 'start'],
  ['napcat:999999999', 'start'],
];
for (const [k, a] of rejects) {
  let threw = false, msg = '';
  try { await act(k, a); } catch (e) { threw = true; msg = e.message; }
  check(`拒绝 ${k}/${a}`, threw);
  if (!threw) console.log('    居然没抛错：', k, a);
  else if (!msg) console.log('    抛了但没消息：', k, a);
}

// ---------- 已有实例不重复启动（只在它真在跑时测，否则会真拉起来） ----------
console.log('--- 不重复启动 ---');
const bot0 = db.listBots()[0];
if (bot0) {
  const t = napcatTarget(bot0);
  if (await probeTcp(t.port)) {
    const r = await act(`napcat:${t.botId}`, 'start');
    check(`端口 ${t.port} 已在跑时不再拉一套`, r.ok === false, JSON.stringify(r));
  } else {
    console.log(`    （跳过：端口 ${t.port} 现在没人听，真点会把它拉起来）`);
  }
} else {
  console.log('    （跳过：库里还没有机器人）');
}

// ---------- 语音识别运行时 ----------
console.log('--- findAsrRuntime ---');
const rt = findAsrRuntime();
check('找得到 sherpa 可执行文件', !!rt && !!rt.bin);
check('找得到 SenseVoice 模型', !!rt && !!rt.model);
if (rt) console.log('    ' + rt.bin + '\n    ' + rt.model);

db.closeDb();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
log.closeLogs();
