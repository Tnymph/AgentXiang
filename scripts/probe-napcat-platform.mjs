// 查 NapCat 到底支持哪些平台：走当初下载成功的那几个 GitHub 代理
import { ensureDirs } from '../src/paths.js';
import * as log from '../src/logger.js';
import { fetchRemote } from '../src/net.js';

ensureDirs();
log.setDebug(false);

const PROXIES = ['https://ghfast.top/', 'https://gh-proxy.com/', ''];
const TARGETS = [
  { label: 'NapCat-Installer README', url: 'https://raw.githubusercontent.com/NapNeko/NapCat-Installer/main/README.md', match: /termux|android|arm64|aarch64/i },
  { label: 'NapCatQQ README', url: 'https://raw.githubusercontent.com/NapNeko/NapCatQQ/main/README.md', match: /termux|android|arm64|aarch64|linux/i },
  { label: 'NapCatQQ release API', url: 'https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest', match: /"name":/ },
];

for (const t of TARGETS) {
  let done = false;
  for (const p of PROXIES) {
    if (done) break;
    const url = p + t.url;
    try {
      const r = await fetchRemote(url, { timeoutMs: 15000, maxBytes: 512 * 1024 });
      if (!r.ok) { console.log(`✗ ${t.label}  via ${p || '(直连)'}  HTTP ${r.status}`); continue; }
      const text = r.buffer.toString('utf8');
      console.log(`✅ ${t.label}  via ${p || '(直连)'}  ${Math.round(r.bytes / 1024)}KB`);
      // 把关心的行打出来
      const lines = text.split('\n').filter((l) => t.match.test(l));
      for (const l of lines.slice(0, 14)) console.log('   ' + l.trim().slice(0, 150));
      if (!lines.length) console.log('   （没有命中关键词的行）');
      done = true;
    } catch (e) {
      console.log(`✗ ${t.label}  via ${p || '(直连)'}  ${e.message.slice(0, 70)}`);
    }
  }
  console.log('');
}

// 再单独确认一下那个 Termux 安装脚本是否真的存在
console.log('════ 传说中的 Termux 一键脚本是否存在 ════');
for (const u of [
  'https://raw.githubusercontent.com/NapNeko/NapCat-Installer/main/script/install.termux.sh',
  'https://nclatest.znin.net/NapNeko/NapCat-Installer/main/script/install.termux.sh',
  'https://raw.githubusercontent.com/NapNeko/NapCat-Installer/main/script/install.sh',
]) {
  for (const p of ['https://ghfast.top/', '']) {
    try {
      const r = await fetchRemote(p + u, { timeoutMs: 15000, maxBytes: 256 * 1024 });
      const head = r.ok ? r.buffer.toString('utf8').slice(0, 300).replace(/\n/g, ' ⏎ ') : '';
      console.log(`${r.ok ? '✅ 存在' : '✗ HTTP ' + r.status}  ${p}${u.replace('https://raw.githubusercontent.com/', '')}`);
      if (r.ok) { console.log('   开头：' + head.slice(0, 240)); break; }
    } catch (e) {
      console.log(`✗ ${e.message.slice(0, 50)}  ${p}${u.replace('https://raw.githubusercontent.com/', '')}`);
    }
  }
}

log.closeLogs();
