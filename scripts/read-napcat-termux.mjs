// 读 NapCat 的 Termux 安装脚本正文，弄清它在手机上到底怎么跑
import { ensureDirs } from '../src/paths.js';
import * as log from '../src/logger.js';
import { fetchRemote } from '../src/net.js';
import fs from 'node:fs';

ensureDirs();
log.setDebug(false);

const r = await fetchRemote('https://ghfast.top/https://raw.githubusercontent.com/NapNeko/NapCat-Installer/main/script/install.termux.sh',
  { timeoutMs: 20000, maxBytes: 1024 * 1024 });
if (!r.ok) { console.log('取不到：HTTP ' + r.status); process.exit(1); }
const s = r.buffer.toString('utf8');
fs.writeFileSync('.tools/napcat-install.termux.sh.txt', s, 'utf8');
console.log('脚本 ' + s.length + ' 字符，已存到 .tools/napcat-install.termux.sh.txt');
console.log('');

// 关心的事实：架构判断、装了哪些东西、内存/存储要求、启动方式
const KEYS = [
  ['架构判断', /aarch64|arm64|uname -m|x86_64/],
  ['proot / 容器', /proot|distro|chroot/],
  ['QQ 包', /QQ.*\.deb|qqnt|linuxqq|deb /i],
  ['显示（X11/xvfb）', /xvfb|X11|DISPLAY|:0|vnc/i],
  ['Node / 运行时', /nodejs|node |python|uv /i],
  ['存储/内存要求', /1\.5G|GB|内存|RAM|swap/i],
  ['登录方式', /二维码|qrcode|扫码|login|token/i],
  ['启动命令', /qq --|--no-sandbox|launch/i],
];
for (const [label, re] of KEYS) {
  const lines = s.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => re.test(l));
  console.log('── ' + label + '（' + lines.length + ' 处）');
  for (const [n, l] of lines.slice(0, 6)) console.log('   ' + String(n).padStart(4) + ': ' + l.trim().slice(0, 140));
  console.log('');
}

log.closeLogs();
