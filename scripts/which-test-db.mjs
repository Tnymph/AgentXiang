import fs from 'node:fs';
const files = fs.readdirSync('scripts').filter((f) => /^smoke-.*\.mjs$/.test(f));
const used = new Set();
for (const f of files) {
  const s = fs.readFileSync('scripts/' + f, 'utf8');
  for (const m of s.matchAll(/test(\d+)\.sqlite/g)) used.add(Number(m[1]));
  const label = (s.match(/\/\/ 冒烟测试：(.+)/) ?? [])[1] ?? '';
  console.log(f.padEnd(24) + label);
}
console.log('\n已占用的测试库编号：' + [...used].sort((a, b) => a - b).join(', '));
let n = 1;
while (used.has(n)) n++;
console.log('下一个可用编号：test' + n + '.sqlite');
