// 预取 RVC 需要的两个公共模型（走 hf-mirror，官方 HF 在国内拉不动）：
//   <tools>/rvc-work/assets/models/rmvpe.pt           音高提取
//   <tools>/rvc-work/assets/models/contentvec_base.pt 内容特征
// 放对位置后 rvc 自己就不再下载了（它只认 cwd/assets/models 下有没有文件）。
// 用法：node scripts/get-rvc-assets.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { TOOLS_DIR } from '../src/paths.js';

const HOST = 'hf-mirror.com';
const WORK = path.join(TOOLS_DIR, 'rvc-work');
const DEST = path.join(WORK, 'assets/models');

const files = [
  ['predictors/rmvpe.pt', 'rmvpe.pt'],
  ['embedders/fairseq/contentvec_base.pt', 'contentvec_base.pt'],
];

function assertPublic(u) {
  const url = new URL(u);
  if (!/^https?:$/.test(url.protocol)) throw new Error('协议不允许 ' + url.protocol);
  const h = url.hostname;
  if (h === 'localhost' || h.endsWith('.local') || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h)) {
    throw new Error('拒绝内网地址 ' + h);
  }
  if (h !== HOST) throw new Error('只允许 ' + HOST + '，收到 ' + h);
  return url;
}

fs.mkdirSync(DEST, { recursive: true });

for (const [remote, name] of files) {
  const out = path.join(DEST, name);
  if (fs.existsSync(out) && fs.statSync(out).size > 1024) {
    console.log('已有 ' + name + ' ' + (fs.statSync(out).size / 1048576).toFixed(1) + 'MB，跳过');
    continue;
  }
  const url = assertPublic(`https://${HOST}/NeoPy/Ultimate-Models/resolve/main/${remote}`);
  const t0 = Date.now();
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${name} HTTP ${r.status}`);
  await pipeline(r.body, fs.createWriteStream(out));
  const mb = (fs.statSync(out).size / 1048576).toFixed(1);
  console.log(`${name} ${mb}MB ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
console.log('DONE -> ' + DEST);
