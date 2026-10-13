// 打手机部署包：把 Termux 脚本 + 程序源码装进一个 zip
//
//   node scripts/build-phone-package.mjs
//
// 产物：dist/agentxiang-phone.zip
//
// 刻意不打包的东西：
//   data/           聊天记录和配置（含隐私），走云盘同步，不进安装包
//   .tools/         NapCat、语音模型（几十上百 MB，手机上要装 arm64 版）
//   style-samples/  666MB 的讲稿录音，手机用不上
//   inbox/          收件箱，是同步用的
// 所有 shell 脚本一律写 LF 换行：CRLF 会让 Termux 报 bad interpreter。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const PHONE = path.join(ROOT, 'dist', 'phone');
const PHONE_SRC = path.join(ROOT, 'phone'); // 手机脚本和清单的源码位置（dist/ 只是产物）
const APP = path.join(PHONE, 'app');
const ZIP = path.join(ROOT, 'dist', 'agentxiang-phone.zip');

// ---------- 0. 产物目录清空重来 ----------
// dist/phone/app 是纯产物：不先删干净，源码里删掉的文件会以旧副本留在包里。
fs.rmSync(APP, { recursive: true, force: true });
// 手机脚本的源码在 phone/，拷进 dist/phone 再打包（保证包里的就是 phone/ 里的）
let shCount = 0;
for (const e of fs.readdirSync(PHONE_SRC)) {
  fs.copyFileSync(path.join(PHONE_SRC, e), path.join(PHONE, e));
  if (e.endsWith('.sh')) shCount++;
}
console.log('从 phone/ 取来交付脚本 ' + shCount + ' 个 + 清单');

// ---------- 1. 组装 app/ ----------
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

console.log('组装 app/ …');
let files = 0;
for (const d of ['src', 'scripts', 'docs']) {
  const from = path.join(ROOT, d);
  if (!fs.existsSync(from)) continue;
  copyDir(from, path.join(APP, d));
  console.log('  + ' + d);
}
for (const f of ['package.json']) {
  fs.copyFileSync(path.join(ROOT, f), path.join(APP, f));
  console.log('  + ' + f);
}

// 手机包里不需要的开发脚本（Windows 专用：.ps1/.cmd，手机上跑不了）
const DROP = [
  'napcat-start.cmd', 'asr-server.cmd', 'start-all.cmd', 'stop-all.cmd',
  'batch-asr.ps1', 'browsers.ps1', 'check-formats.ps1',
  'find-asr.ps1', 'find-napcat.ps1', 'find-vad.ps1', 'get-asr.ps1', 'get-ffmpeg.ps1',
  'get-napcat.ps1', 'get-ytdlp.ps1', 'inspect-asr.ps1', 'probe-bili.ps1', 'probe-formats.ps1',
  'redownload.ps1', 'set-alias.ps1', 'setup-test.ps1', 'setup-tools.ps1', 'test-asr.ps1',
  'test-asr2.ps1', 'test-coexist.ps1', 'test-download.ps1', 'test-hotwords.ps1',
  'to-wav.ps1', 'try-cookies.ps1', 'verify-audio.ps1', 'build-phone-package.mjs',
];
let dropped = 0;
for (const f of DROP) {
  const p = path.join(APP, 'scripts', f);
  if (fs.existsSync(p)) { fs.unlinkSync(p); dropped++; }
}
console.log('  去掉 Windows 专用脚本 ' + dropped + ' 个');

// ---------- 2. 换行符统一成 LF ----------
// Windows 上复制过去的是 CRLF，Termux 里跑会报 bad interpreter
let fixed = 0;
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!/\.(sh|mjs|js|json|md|txt)$/.test(e.name)) continue;
    const buf = fs.readFileSync(p);
    if (buf.includes(0x0d)) {
      fs.writeFileSync(p, Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));
      fixed++;
    }
  }
};
walk(PHONE);
console.log('  换行符修正 ' + fixed + ' 个文件');

// ---------- 3. 语法检查 ----------
// 本机没有 bash（Windows 上没装 Git bash，WSL 里也没发行版），所以门槛用 Node 做静态检查：
// shebang / CRLF / if-fi 配平 / 引号闭合 / set -u 下的裸参数
try {
  const out = execFileSync(process.execPath, ['--no-warnings', path.join(ROOT, 'scripts', 'lint-shell.mjs')],
    { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  for (const l of out.trim().split('\n')) console.log('  ' + l);
} catch (e) {
  console.log('  ✗ 静态检查没过，包没打：');
  console.log(String(e.stdout ?? e.message).slice(0, 800));
  process.exit(1);
}
// 如果哪天本机有了真 bash，再验一遍（没有就跳过，上面的静态检查已经兜住了）
const BASH = ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe']
  .find((p) => fs.existsSync(p));
if (BASH) {
  const cmd = fs.readdirSync(PHONE).filter((f) => f.endsWith('.sh'))
    .map((f) => `bash -n "${f}"`).join(' && ');
  try {
    execFileSync(BASH, ['-lc', cmd], { cwd: PHONE, stdio: 'pipe' });
    console.log('  bash -n 也通过');
  } catch (e) {
    console.log('  ✗ bash -n 失败：');
    console.log(String(e.stderr ?? e.message).slice(0, 600));
    process.exit(1);
  }
}

// 统计
const count = (d) => {
  let n = 0;
  const w = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, e.name);
      if (e.isDirectory()) w(q); else n++;
    }
  };
  w(d);
  return n;
};

// ---------- 4. 打 zip ----------
fs.mkdirSync(path.dirname(ZIP), { recursive: true });
if (fs.existsSync(ZIP)) fs.unlinkSync(ZIP);
console.log('');
console.log('打 zip …');
try {
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${PHONE}\\*' -DestinationPath '${ZIP}' -Force`], { stdio: 'pipe' });
  const mb = (fs.statSync(ZIP).size / 1024 / 1024).toFixed(2);
  console.log('  ✅ ' + ZIP + '  （' + mb + 'MB）');
} catch (e) {
  console.log('  ✗ 打包失败：' + String(e.stderr ?? e.message).slice(0, 300));
  process.exit(1);
}

console.log('');
console.log('包内容：');
console.log('  脚本 5 个：check-phone.sh / install-phone.sh / verify-phone.sh / start-bot.sh / stop-bot.sh');
console.log('  清单 1 个：README-phone.md');
console.log('  程序：src + scripts + docs + package.json，共 ' + count(APP) + ' 个文件');
console.log('');
console.log('传到手机上，解压后先跑：bash check-phone.sh');
