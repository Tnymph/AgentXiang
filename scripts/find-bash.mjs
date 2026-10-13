// 找 bash：Git for Windows 自带，用来给手机脚本做语法检查
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const CANDS = [
  'C:/Program Files/Git/bin/bash.exe',
  'C:/Program Files/Git/usr/bin/bash.exe',
  'C:/Program Files (x86)/Git/bin/bash.exe',
  'C:/Windows/System32/bash.exe',
];
for (const c of CANDS) {
  const has = fs.existsSync(c);
  console.log((has ? '[有] ' : '[无] ') + c);
}

const found = CANDS.find((c) => fs.existsSync(c));
console.log('');
if (!found) {
  // 再试 PATH
  try {
    const w = execFileSync('where', ['bash'], { encoding: 'utf8' }).trim().split('\n')[0];
    console.log('where bash → ' + w);
  } catch { console.log('PATH 里也没有 bash'); }
  process.exit(0);
}
console.log('用这个：' + found);
try {
  console.log('版本：' + execFileSync(found, ['--version'], { encoding: 'utf8' }).split('\n')[0]);
} catch (e) {
  console.log('跑不起来：' + e.message.slice(0, 120));
}
