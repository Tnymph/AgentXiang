// 把 17:00 前后的原始日志逐行打印，并标出每条的关键字符
import fs from 'node:fs';
import { LOGS_DIR } from '../src/paths.js';

const t = new Date().toISOString().slice(0, 10);
const file = `${LOGS_DIR}/chat-${t}.log`;
const lines = fs.readFileSync(file, 'utf8').split('\n');

const shown = lines.filter((l) => l.includes('17:00:') || l.includes('17:01:'));
for (const l of shown) {
  // 把 text 之后的部分里的控制字符可视化
  const idx = l.indexOf('| ');
  const prefix = idx >= 0 ? l.slice(0, idx) : l;
  const body = idx >= 0 ? l.slice(idx + 2) : '';
  const vis = [...body].map((ch) => {
    const c = ch.codePointAt(0);
    if (c === 9) return '\\t';
    if (c < 32) return `\\u${c.toString(16).padStart(4, '0')}`;
    return ch;
  }).join('');
  console.log(prefix.replace(/^.*?(\d\d:\d\d:\d\d\.\d+)/, '$1'));
  console.log('   ' + vis);
}
console.log('');
console.log('总行数:', lines.length);
