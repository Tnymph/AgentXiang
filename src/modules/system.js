// 运行控制：把 NapCat、语音识别、机器人本体的开关做成网页上的按钮。
//
// 全项目只有这一个模块会启动/停止外部进程，所以安全底线也集中在这里：
//
//   1. 对外只暴露「服务 + 动作」两个枚举值。客户端发来的字符串永远不会进命令行，
//      想加一个能开关的东西，只能往下面的函数里加一条分支。
//   2. 进命令行的参数（目录名、QQ 号）必须过 assertSafeToken / assertQq 的白名单。
//      这是防注入的关键：一个名叫 "x & del /f /q E:\" 的目录名否则就成了第二条命令。
//   3. 一律用 spawn/execFile 传参数数组，不开 shell，不拼字符串。
//
// 判断「服务在不在跑」用端口探测而不是查进程表：跨平台、便宜、语义正好。
import { spawn, execFile } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, TOOLS_DIR, LOGS_DIR } from '../paths.js';
import * as db from '../db.js';
import { botSettings, loadGlobal } from '../config.js';
import * as log from '../logger.js';

const IS_WIN = process.platform === 'win32';

/** 目录名之类的安全令牌：只允许字母数字和 . _ - */
export function assertSafeToken(v, what = '参数') {
  const s = String(v ?? '');
  // 三点注意，都是为了不让这个值变成命令的一部分：
  //   - 只允许字母数字和 . _ -
  //   - 光是点（. / .. / …）不行，那会走到当前目录之外
  //   - 以 - 开头不行，那会被下游当成命令行开关
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(s) || /^\.+$/.test(s) || s.startsWith('-')) {
    throw new Error(`${what}不合法（只允许字母数字和 . _ -，且不能是纯点号或以 - 开头）：${s.slice(0, 40)}`);
  }
  return s;
}

/** QQ 号：纯数字 */
export function assertQq(v) {
  const s = String(v ?? '');
  if (!/^\d{5,12}$/.test(s)) throw new Error(`QQ 号不合法：${s.slice(0, 20)}`);
  return s;
}

/**
 * 路径必须落在 baseDir 里面。
 * 用在「扫目录发现来的」路径上（sherpa 的程序和模型）：即使它来自本机文件系统，
 * 也不该有机会把命令行带到 .tools 外面去。
 */
export function assertInside(baseDir, p, what = '路径') {
  const abs = path.resolve(p);
  const rel = path.relative(path.resolve(baseDir), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${what}不在 ${baseDir} 里：${abs}`);
  }
  return abs;
}

/** 探一下端口有没有人在听。跨平台，比查进程表便宜得多。 */
export function probeTcp(port, { host = '127.0.0.1', timeoutMs = 900 } = {}) {
  return new Promise((resolve) => {
    if (!port) { resolve(false); return; }
    const sock = net.connect({ host, port: Number(port) });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/** 从 ws://127.0.0.1:3001 里取端口 */
export function portOfWsUrl(u) {
  try { return Number(new URL(String(u)).port) || 0; } catch { return 0; }
}

/** 某个机器人连的那套 NapCat：端口取自己的设置，没写就用全局的 */
export function napcatTarget(bot) {
  const s = botSettings(bot.id);
  const g = loadGlobal();
  const url = s.napcatWsUrl || g?.napcat?.wsUrl || '';
  return {
    botId: bot.id,
    botName: bot.name,
    qq: String(bot.qq ?? ''),
    dir: s.napcatDir || 'napcat',
    dataDir: s.napcatDataDir || 'qq-bot-data',
    port: portOfWsUrl(url),
    wsUrl: url,
  };
}

// ---------- NapCat ----------

/** NapCat 的启动命令（固定的两份模板，只有通过白名单的参数会进去） */
async function startNapcat(t) {
  // 已经在跑就别再拉一套：同一个数据目录起两个实例，QQ 会互相把对方顶下线
  if (t.port && (await probeTcp(t.port))) {
    return { ok: false, note: `监听 ${t.port} 的那套 NapCat 已经在跑了，没有重复启动` };
  }
  const dir = assertSafeToken(t.dir, 'NapCat 目录');
  const dataDir = assertSafeToken(t.dataDir, 'QQ 数据目录');
  const qq = assertQq(t.qq);

  if (IS_WIN) {
    // 用 cmd 的 start 开一个最小化的窗口：QQ 万一要重新扫码，窗口里有二维码；
    // 平时它就安静地待在任务栏里。参数一项项传（dir / qq / dataDir 各自一格），
    // 不在 JS 里拼成一条命令字符串；三个值都已过白名单，
    // 只有字母数字和 . _ -，不含 cmd 的任何元字符。
    const child = spawn('cmd.exe', [
      '/c', 'start', '', '/D', ROOT, '/MIN', 'cmd', '/k',
      'scripts\\napcat-start.cmd', dir, qq, dataDir,
    ], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    log.info('system', 'napcat start', { dir, qq });
    return { ok: true, note: '已拉起 NapCat，QQ 会自动登录；要重新扫码就去「扫码登录」页' };
  }

  // 手机（Termux）：NapCat 跑在 proot 容器里，用 screen 丢后台
  if (dir !== 'napcat') throw new Error('手机上只支持一套 NapCat（容器名 napcat），两个号请留在电脑上');
  // 手机（Termux）：NapCat 跑在 proot 容器里，用 screen 丢后台。
  // 这里 qq 嵌进了 bash -c 的字符串，但它是安全的：assertQq 保证只有数字，
  // 而数字里不含任何 shell 元字符。命令本身保持 README 里验证过的那一份原文不动。
  const inner = `xvfb-run -a /root/Napcat/opt/QQ/qq --no-sandbox -q ${qq}`;
  const child = spawn('screen', ['-dmS', 'napcat', 'bash', '-c', `proot-distro sh napcat -- bash -c "${inner}"`],
    { detached: true, stdio: 'ignore' });
  child.unref();
  log.info('system', 'napcat start (termux)', { qq });
  return { ok: true, note: '已丢到 screen 会话 napcat 里启动' };
}

/** 停掉某套 NapCat：按端口找出正在监听的进程，连它的子进程一起收掉 */
async function stopNapcat(t) {
  if (!t.port) throw new Error('这个机器人没配 ws 地址，认不出对应哪套 NapCat');
  if (IS_WIN) {
    // 插进去的是 Number(t.port)，只可能是数字，不含任何 PowerShell 语法字符。
    const ps = `(Get-NetTCPConnection -LocalPort ${Number(t.port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`;
    const pid = await new Promise((resolve) => {
      execFile('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 15000 },
        (err, stdout) => resolve(String(stdout ?? '').trim()));
    });
    if (!/^\d+$/.test(pid)) throw new Error(`没找到监听 ${t.port} 端口的进程；它可能已经停了`);
    const child = spawn('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    await new Promise((r) => child.once('close', r));
    log.info('system', 'napcat stopped', { port: t.port, pid });
    return { ok: true, note: `已停掉监听 ${t.port} 的 NapCat（pid ${pid}）` };
  }
  const child = spawn('pkill', ['-f', 'opt/QQ/qq'], { stdio: 'ignore' });
  await new Promise((r) => child.once('close', r));
  log.info('system', 'napcat stopped (termux)');
  return { ok: true, note: '已停掉 NapCat（对应进程）' };
}

// ---------- 语音识别 ----------

/** 找 sherpa 的可执行文件和模型；找不到就返回 null（语音识别是可选件） */
export function findAsrRuntime() {
  const exe = IS_WIN ? 'sherpa-onnx-offline-websocket-server.exe' : 'sherpa-onnx-offline-websocket-server';
  let bin = null;
  const sherpaDir = path.join(TOOLS_DIR, 'sherpa');
  if (fs.existsSync(sherpaDir)) {
    for (const d of fs.readdirSync(sherpaDir)) {
      const p = path.join(sherpaDir, d, 'bin', exe);
      if (fs.existsSync(p)) bin = p;
    }
    const flat = path.join(sherpaDir, 'bin', exe);
    if (!bin && fs.existsSync(flat)) bin = flat;
  }
  let modelDir = null;
  const modelRoot = path.join(TOOLS_DIR, 'model-sense-voice');
  if (fs.existsSync(modelRoot)) {
    for (const d of fs.readdirSync(modelRoot)) {
      const dir = path.join(modelRoot, d);
      if (fs.existsSync(path.join(dir, 'model.int8.onnx')) || fs.existsSync(path.join(dir, 'model.onnx'))) modelDir = dir;
    }
  }
  let model = null;
  if (modelDir) {
    const int8 = path.join(modelDir, 'model.int8.onnx');
    model = fs.existsSync(int8) ? int8 : path.join(modelDir, 'model.onnx');
  }
  if (!bin || !modelDir || !model) return null;
  // 扫目录发现的路径也要过关：只认 .tools 里面的东西，出了问题当作没装（而不是抛错，
  // 免得把状态页整个带崩）
  try {
    return {
      bin: assertInside(TOOLS_DIR, bin, '语音识别程序'),
      modelDir: assertInside(TOOLS_DIR, modelDir, '语音识别模型目录'),
      model: assertInside(TOOLS_DIR, model, '语音识别模型'),
    };
  } catch (e) {
    log.warn('system', 'sherpa 路径不在 .tools 里，当作没装', { err: e.message });
    return null;
  }
}

async function startAsr(port) {
  const p = Number(port) || 6007;
  if (await probeTcp(p)) return { ok: false, note: `语音识别服务已经在跑了（端口 ${p}）` };
  const rt = findAsrRuntime();
  if (!rt) throw new Error('没找到语音识别的程序或模型（.tools/sherpa、.tools/model-sense-voice）');
  // 必须用 --flag=值 这一种形式：sherpa 的参数解析器不认空格分隔
  // （实测 v1.13.8，`--port 6008` 会报 parse-options.cc Invalid integer option ""）。
  // 拼进去的值都来自上面 assertInside 校验过的 .tools 内部路径，跑不出这个目录。
  const args = [
    `--port=${p}`,
    `--sense-voice-model=${rt.model}`,
    `--tokens=${path.join(rt.modelDir, 'tokens.txt')}`,
    '--sense-voice-language=zh',
    '--num-threads=4',
    `--log-file=${path.join(LOGS_DIR, 'asr-server.log')}`,
  ];
  // 起不来的话不能无声无息：把它的 stdout/stderr 也收进文件，下次好查
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const errFd = fs.openSync(path.join(LOGS_DIR, 'asr-start.log'), 'a');
  const child = spawn(rt.bin, args, { detached: true, stdio: ['ignore', errFd, errFd], cwd: ROOT });
  fs.closeSync(errFd); // 子进程已经拿到副本，父进程这份要还回去
  child.unref();
  log.info('system', 'asr start', { port });
  return { ok: true, note: '已启动语音识别服务（模型加载要几秒）' };
}

async function stopAsr() {
  const name = IS_WIN ? 'sherpa-onnx-offline-websocket-server.exe' : 'sherpa-onnx-offline-websocket-server';
  if (IS_WIN) {
    const child = spawn('taskkill', ['/F', '/IM', name], { stdio: 'ignore', windowsHide: true });
    await new Promise((r) => child.once('close', r));
  } else {
    const child = spawn('pkill', ['-f', name], { stdio: 'ignore' });
    await new Promise((r) => child.once('close', r));
  }
  log.info('system', 'asr stopped');
  return { ok: true, note: '已停掉语音识别服务' };
}

// ---------- 对外接口 ----------

/** 当前各件的状态。bot 这一项：能读到这个响应，就说明它自己在跑。 */
export async function status() {
  const bots = db.listBots();
  const targets = bots.map(napcatTarget);
  const napcat = await Promise.all(targets.map(async (t) => ({
    key: `napcat:${t.botId}`,
    label: `NapCat · ${t.botName}`,
    qq: t.qq,
    port: t.port,
    running: await probeTcp(t.port),
  })));

  const asrPort = Number(botSettings(bots[0]?.id ?? 1).asr?.port) || 6007;
  const rt = findAsrRuntime();
  return {
    platform: process.platform,
    pid: process.pid,
    root: ROOT,
    bot: { running: true, pid: process.pid, uptimeSec: Math.round(process.uptime()) },
    napcat,
    asr: {
      key: 'asr',
      label: '语音识别服务',
      port: asrPort,
      installed: !!rt,
      running: rt ? await probeTcp(asrPort) : false,
    },
    restartHint: '程序本体整个停掉之后，这个页面也就没了；要重新拉起来请双击 scripts\\start-all.cmd（或把它放进开机启动）。',
  };
}

/**
 * 执行一个动作。
 *   key:    'bot' | 'asr' | 'napcat:<机器人id>'
 *   action: 'start' | 'stop' | 'restart'
 */
export async function act(key, action) {
  const k = String(key ?? '');
  const a = String(action ?? '');
  if (!['start', 'stop', 'restart'].includes(a)) throw new Error(`不认识的动作：${a}`);

  if (k === 'bot') {
    if (a === 'stop') {
      log.info('system', 'bot stop by button');
      setTimeout(() => process.exit(0), 400); // 让这次响应先发出去
      return { ok: true, note: '机器人本体正在停止，页面马上会断开' };
    }
    // restart：把自己重新拉一个，然后退出。新进程靠 server 的重试占住端口。
    // 参数写死（--no-warnings + 入口文件），不把 process.argv 透传下去：
    // 启动参数属于外部输入，不该被当成新进程的命令行。
    const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'src', 'index.js')], {
      detached: true, stdio: 'ignore', cwd: ROOT, env: { ...process.env, AGENTXIANG_RESTART: '1' },
    });
    child.unref();
    log.info('system', 'bot restart by button', { pid: child.pid });
    setTimeout(() => process.exit(0), 800); // 等新进程起来再走，避免端口空窗
    return { ok: true, note: '正在重启，几秒后刷新页面就好' };
  }

  if (k === 'asr') {
    const port = Number(botSettings(db.listBots()[0]?.id ?? 1).asr?.port) || 6007;
    if (a === 'start') return startAsr(port);
    if (a === 'stop') return stopAsr();
    await stopAsr();
    await new Promise((r) => setTimeout(r, 600));
    return startAsr(port);
  }

  if (k.startsWith('napcat:')) {
    const botId = Number.parseInt(k.slice('napcat:'.length), 10);
    const bot = db.listBots().find((b) => b.id === botId);
    if (!bot) throw new Error('机器人不存在');
    const t = napcatTarget(bot);
    if (a === 'start') return startNapcat(t);
    if (a === 'stop') return stopNapcat(t);
    await stopNapcat(t);
    await new Promise((r) => setTimeout(r, 1500));
    return startNapcat(t);
  }

  throw new Error(`不认识的服务：${k}`);
}
