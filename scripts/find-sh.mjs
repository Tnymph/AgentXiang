// 找任何一个能解释 sh 脚本的东西：WSL / Git 的 sh / busybox
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const CANDS = [
  'C:/Windows/System32/wsl.exe',
  'C:/Program Files/Git/bin/sh.exe',
  'C:/Program Files/Git/usr/bin/sh.exe',
  'C:/Program Files (x86)/Git/bin/sh.exe',
  'C:/Program Files/Git/bin/bash.exe',
  'C:/msys64/usr/bin/bash.exe',
  'C:/cygwin64/bin/bash.exe',
  'C:/Program Files/BusyBox/busybox.exe',
];
console.log('候选解释器：');
for (const c of CANDS) console.log((fs.existsSync(c) ? '  [有] ' : '  [无] ') + c);

console.log('');
console.log('PATH 里找 sh / bash / busybox：');
for (const name of ['sh', 'bash', 'busybox', 'wsl']) {
  try {
    const out = execFileSync('where', [name], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    console.log('  ' + name + ' → ' + out.split('\n')[0]);
  } catch {
    console.log('  ' + name + ' → 没有');
  }
}

// 有 wsl 的话试试里面有没有可用的发行版
if (fs.existsSync('C:/Windows/System32/wsl.exe')) {
  console.log('');
  try {
    const out = execFileSync('C:/Windows/System32/wsl.exe', ['-l', '-q'], {
      encoding: 'utf8', timeout: 20000, windowsHide: true,
    });
    const distros = out.split('\n').map((s) => s.replace(/\0/g, '').trim()).filter(Boolean);
    console.log('WSL 里的发行版：' + (distros.length ? distros.join(', ') : '（一个都没有）'));
  } catch (e) {
    console.log('WSL 调用失败：' + String(e.message).slice(0, 100));
  }
}
