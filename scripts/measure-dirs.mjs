// 量各目录体积，决定手机包里放什么
import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'napcat', 'napcat2', 'sherpa', 'ffmpeg',
  'qq-bot-data', 'qq-bot2-data', 'model-sense-voice', 'dl']);

function size(d) {
  let total = 0, n = 0;
  const stack = [d];
  while (stack.length) {
    const p = stack.pop();
    let es = [];
    try { es = fs.readdirSync(p, { withFileTypes: true }); } catch { continue; }
    for (const e of es) {
      if (SKIP.has(e.name)) continue;
      const q = path.join(p, e.name);
      let st;
      try { st = fs.statSync(q); } catch { continue; }
      if (st.isDirectory()) stack.push(q);
      else { total += st.size; n++; }
    }
  }
  return [total, n];
}

console.log('目录体积（已跳过 NapCat / 模型 / QQ 数据）：');
for (const d of ['src', 'scripts', 'docs', 'style-samples', 'data', '.tools', 'inbox', 'dist']) {
  if (!fs.existsSync(d)) { console.log(`  ${d.padEnd(16)} （不存在）`); continue; }
  const [t, n] = size(d);
  console.log(`  ${d.padEnd(16)} ${(t / 1024 / 1024).toFixed(2).padStart(8)} MB   ${n} 个文件`);
}

console.log('');
console.log('手机包打算包含：src + scripts + docs + package.json');
const [t1, n1] = size('src');
const [t2, n2] = size('scripts');
const [t3, n3] = size('docs');
console.log(`  合计约 ${((t1 + t2 + t3) / 1024 / 1024).toFixed(2)} MB，${n1 + n2 + n3} 个文件`);
console.log('  （不含 data/：那里面是你的聊天记录和配置，走云盘同步，不塞进安装包）');
