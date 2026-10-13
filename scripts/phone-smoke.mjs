// 手机上的冒烟自检：确认这份代码在这台机器上真能跑起来。
//
//   node --no-warnings scripts/phone-smoke.mjs
//
// 只碰 data/ 下的库和日志，不发任何网络请求、不连 QQ。
// 装完之后如果界面打不开，先跑这个 —— 它能把「代码跑不起来」和
// 「网络/NapCat 的问题」分开。
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const line = (s) => console.log(s);
line('AgentXiang 手机冒烟自检');
line('  平台 ' + process.platform + ' / ' + process.arch);
line('  Node  ' + process.version);
line('  内存  约 ' + Math.round(os.totalmem() / 1024 / 1024 / 1024) + 'GB');
line('');

// ① 最关键的一项：Node 自带的 sqlite。过不了后面都不用看了。
try {
  await import('node:sqlite');
  line('  ✓ node:sqlite 可用');
} catch (e) {
  line('  ✗ node:sqlite 用不了：' + String(e.message).slice(0, 120));
  line('');
  line('    这个模块是程序存数据的唯一依赖（不装任何 npm 包）。');
  line('    当前 Node 版本 ' + process.version + '，需要 22.13 以上。');
  line('    试试：pkg upgrade nodejs   （或 pkg install nodejs-lts）');
  line('    还不行把这行结果发我：node -e "require(\'node:sqlite\')"');
  process.exit(1);
}

// ② 真正的初始化：建库、建表
// 用 fileURLToPath 而不是 .pathname —— 后者在 Windows 上会给出 /C:/… 这种路径。
// 切到程序根目录，data/ 才会建在程序旁边（跟 start-bot.sh 跑起来时一致）。
process.chdir(fileURLToPath(new URL('../', import.meta.url)));

try {
  const paths = await import('../src/paths.js');
  paths.ensureDirs();
  const db = await import('../src/db.js');
  db.openDb();
  const tables = db.all("select name from sqlite_master where type = 'table'").map((r) => r.name);
  const bots = db.listBots().length;
  line('  ✓ 数据库能建、能读（' + tables.length + ' 张表，现有 ' + bots + ' 个机器人）');
  line('    库文件：' + paths.DB_FILE);
  db.closeDb();
} catch (e) {
  line('  ✗ 初始化失败：' + String(e.message).slice(0, 200));
  line('');
  line('    把这段输出发我。');
  process.exit(1);
}

// ③ 顺手看一眼配置/密钥能不能读（读不到不算错，只是提示）
try {
  const cfg = await import('../src/config.js');
  const settings = cfg.botSettings(1);
  line('  ✓ 配置能读（默认模型 ' + settings.api.model + '）');
} catch (e) {
  line('  ! 配置读取有问题：' + String(e.message).slice(0, 120));
}

line('');
line('自检通过：这份代码在这台机器上能跑。');
line('接下来如果界面打不开，那就是端口占用或程序没起来，不是代码问题。');
