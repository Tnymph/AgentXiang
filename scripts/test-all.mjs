// 统一测试入口：跑 scripts/ 下所有 smoke-*.mjs，汇总结果
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(here).filter((f) => /^smoke-.*\.mjs$/.test(f)).sort();

let ok = 0, bad = 0;
const failed = [];

for (const f of files) {
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(here, f)], {
    encoding: 'utf8',
    timeout: 300000,
    windowsHide: true,
  });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const m = out.match(/结果:\s*(\d+)\s*通过,\s*(\d+)\s*失败/);
  const summary = m ? `${m[1]} 通过 / ${m[2]} 失败` : '(无结果行)';
  const good = r.status === 0 && (!m || Number(m[2]) === 0);
  if (good) { ok++; console.log(`  ✅ ${f.padEnd(24)} ${summary}`); }
  else {
    bad++; failed.push(f);
    console.log(`  ❌ ${f.padEnd(24)} ${summary}  exit=${r.status}`);
    const tail = out.split('\n').filter((l) => l.includes('FAIL') || l.includes('Error')).slice(0, 6);
    tail.forEach((l) => console.log('       ' + l.trim()));
  }
}

console.log(`\n套件: ${ok} 通过, ${bad} 失败`);
if (failed.length) console.log('失败清单:', failed.join(', '));
process.exit(bad === 0 ? 0 : 1);
