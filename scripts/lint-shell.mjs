// 没有 bash 可用时的替代检查：静态查 shell 脚本里最容易致命的几类错
//
//   node scripts/lint-shell.mjs
//
// 查什么：
//   1. shebang 是不是 /usr/bin/env bash（Termux 里 /bin/bash 不存在）
//   2. 有没有 CRLF（会让 Termux 报 bad interpreter）
//   3. 块关键字配平：if/fi、case/esac、do/done
//   4. 每行引号是否闭合（未闭合的引号是最常见的语法错）
//   5. set -u 下有没有裸用 $1 之类（没传参时会直接退出）
// 顺带查 scripts/*.cmd：cmd.exe 按系统 ANSI 读 .cmd，一旦混进非 ASCII 字节，
// 解析就会错位（注释行被当成命令执行，后面的行跟着遭殃）。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIR = path.join(ROOT, 'dist', 'phone');
let bad = 0;

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sh')).sort()) {
  const raw = fs.readFileSync(path.join(DIR, f), 'utf8');
  const lines = raw.split('\n');
  const problems = [];

  // 1. shebang
  if (lines[0] !== '#!/usr/bin/env bash') {
    problems.push(`第 1 行 shebang 不是 #!/usr/bin/env bash（实际：${lines[0]}）`);
  }
  // 2. CRLF
  if (raw.includes('\r')) problems.push('文件里有 \\r（CRLF 换行），Termux 会报 bad interpreter');
  // 3. 块关键字配平
  const count = (re) => (raw.match(re) ?? []).length;
  const pairs = [
    ['if/fi', /\bif\b/g, /\bfi\b/g],
    ['case/esac', /\bcase\b/g, /\besac\b/g],
    ['do/done', /\bdo\b/g, /\bdone\b/g],
  ];
  for (const [name, a, b] of pairs) {
    const na = count(a), nb = count(b);
    if (na !== nb) problems.push(`${name} 不配平：${na} 对 ${nb}`);
  }
  // 4. 引号闭合（按行粗查，跳过注释行）
  lines.forEach((l, i) => {
    const code = l.replace(/^\s*#.*$/, '');
    const dq = (code.match(/(?<!\\)"/g) ?? []).length;
    const sq = (code.match(/(?<!\\)'/g) ?? []).length;
    // 单引号在双引号里是普通字符，所以只在双引号数为偶数时才查单引号
    if (dq % 2 !== 0) problems.push(`第 ${i + 1} 行双引号没闭合：${l.trim().slice(0, 70)}`);
    else if (sq % 2 !== 0) problems.push(`第 ${i + 1} 行单引号没闭合：${l.trim().slice(0, 70)}`);
  });
  // 5. set -u 下的裸 $1 / $2 —— 只查函数体外面（函数体里的 $1 是调用时传的参数）
  if (/^set -u/m.test(raw)) {
    let inFunc = 0;
    lines.forEach((l, i) => {
      const head = /^\s*(?:function\s+)?[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)\s*\{/;
      if (inFunc === 0 && head.test(l)) {
        inFunc = (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
        return;
      }
      if (inFunc > 0) {
        inFunc += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
        return;
      }
      if (/^\s*#/.test(l)) return;
      const m = l.match(/\$(?!\{)[1-9]\b/g);
      if (m) problems.push(`第 ${i + 1} 行 set -u 下裸用 ${m.join(',')}（顶层没传参会直接退出）：${l.trim().slice(0, 70)}`);
    });
  }

  if (problems.length) {
    bad++;
    console.log(`✗ ${f}`);
    for (const p of problems) console.log('    ' + p);
  } else {
    console.log(`✓ ${f}  （${lines.length} 行，${(raw.length / 1024).toFixed(1)}KB）`);
  }
}

console.log('');
console.log(bad ? `${bad} 个脚本有问题` : `全部通过（共 ${fs.readdirSync(DIR).filter((x) => x.endsWith('.sh')).length} 个脚本）`);

// Windows 的 .cmd：必须是纯 ASCII，否则 cmd.exe 解析错位
const CMD_DIR = path.join(ROOT, 'scripts');
let cmdBad = 0;
for (const f of fs.readdirSync(CMD_DIR).filter((x) => x.endsWith('.cmd')).sort()) {
  const buf = fs.readFileSync(path.join(CMD_DIR, f));
  const n = [...buf].filter((b) => b > 127).length;
  if (n) {
    cmdBad++;
    console.log(`✗ scripts/${f}  有 ${n} 个非 ASCII 字节，cmd.exe 会解析错位`);
  }
}
console.log(cmdBad ? '' : '✓ scripts/*.cmd 都是纯 ASCII');
process.exit(bad || cmdBad ? 1 : 0);
