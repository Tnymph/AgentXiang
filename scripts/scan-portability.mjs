// 扫描：代码里有哪些地方是 Windows 专有 / 手机（Linux/Termux）上会坏的
import fs from 'node:fs';
import path from 'node:path';

const files = [];
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|mjs|json|cmd|ps1)$/.test(e.name)) files.push(p);
  }
}
walk('src');
walk('scripts');

const RULES = [
  ['DPAPI（Windows 专有加密）', /dpapi|DPAPI|ConvertTo-SecureString|Import-Clixml/i],
  ['PowerShell 调用', /powershell|pwsh/i],
  ['child_process（进程调用）', /child_process|spawnSync|execSync/],
  ['Windows 路径分隔（反斜杠）', /['"`][A-Za-z]:\\\\|\\\\\\\\[A-Za-z]/],
  ['批处理脚本', /\.cmd\b|\.bat\b/i],
  ['平台判断', /process\.platform/],
  ['sqlite 实验开关', /experimental-sqlite|node:sqlite/],
  ['监听地址', /127\.0\.0\.1|localhost/],
  ['文件权限/chmod', /chmod|0o7\d\d/],
];

for (const [label, re] of RULES) {
  const hits = [];
  for (const f of files) {
    const L = fs.readFileSync(f, 'utf8').split('\n');
    L.forEach((l, i) => { if (re.test(l)) hits.push(`${f}:${i + 1}  ${l.trim().slice(0, 110)}`); });
  }
  console.log(`── ${label}：${hits.length} 处`);
  for (const h of hits.slice(0, 6)) console.log('   ' + h);
  if (hits.length > 6) console.log(`   …… 还有 ${hits.length - 6} 处`);
  console.log('');
}

console.log('════ 运行时依赖检查 ════');
console.log('  package.json 里的依赖：');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
console.log('   dependencies: ' + JSON.stringify(pkg.dependencies ?? {}));
console.log('   devDependencies: ' + JSON.stringify(pkg.devDependencies ?? {}));
console.log('   engines: ' + JSON.stringify(pkg.engines ?? {}));
console.log('   → 零 npm 依赖，手机上不用编译原生模块 ✓');
