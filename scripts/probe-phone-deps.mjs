// ① 看 NapCat Termux 脚本全文（它到底下什么）② 查 sherpa-onnx 有没有 linux-arm64 版本
import { ensureDirs } from '../src/paths.js';
import * as log from '../src/logger.js';
import { fetchRemote } from '../src/net.js';
import fs from 'node:fs';

ensureDirs();
log.setDebug(false);

console.log('════ NapCat Termux 脚本全文 ════');
console.log(fs.readFileSync('.tools/napcat-install.termux.sh.txt', 'utf8'));
console.log('');

console.log('════ sherpa-onnx 有没有 linux-arm64 / android 的构建 ════');
for (const p of ['https://gh-proxy.com/', 'https://ghfast.top/']) {
  try {
    const r = await fetchRemote(p + 'https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/latest',
      { timeoutMs: 20000, maxBytes: 1024 * 1024 });
    if (!r.ok) { console.log(`✗ ${p} HTTP ${r.status}`); continue; }
    const j = JSON.parse(r.buffer.toString('utf8'));
    console.log('最新版本：' + j.tag_name + '   资源 ' + (j.assets ?? []).length + ' 个');
    const want = (j.assets ?? []).filter((a) => /arm64|aarch64|android/i.test(a.name));
    console.log('含 arm64/aarch64/android 的资源（' + want.length + ' 个）：');
    for (const a of want.slice(0, 24)) console.log('   ' + a.name);
    break;
  } catch (e) {
    console.log(`✗ ${p} ${e.message.slice(0, 60)}`);
  }
}

log.closeLogs();
