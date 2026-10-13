// 看程序是不是活着、连接状态如何
import fs from 'node:fs';
import path from 'node:path';

const dir = 'E:/VibeCoding/AgentXiang/data/logs';
const file = path.join(dir, 'system-' + new Date().toISOString().slice(0, 10) + '.log');
const L = fs.readFileSync(file, 'utf8').trim().split('\n');
console.log('日志：' + file);
console.log('共 ' + L.length + ' 行，末尾 18 行：');
console.log('--------------------------------------------------');
console.log(L.slice(-18).join('\n'));
