// 看清当前机器人与 NapCat 的状态
import fs from 'node:fs';
import path from 'node:path';
import { TOOLS_DIR } from '../src/paths.js';

const base = 'http://127.0.0.1:6188';
const bots = await (await fetch(base + '/api/bots')).json();

console.log('=== 程序里的机器人 ===');
for (const b of bots) {
  console.log(`  #${b.id} 「${b.name}」 QQ=${b.qq ?? '(未填)'} 运行=${b.running} 连接=${b.connected}`);
  console.log(`       自己的 NapCat 地址: ${b.napcatWsUrl || '(未填)'}   实际使用: ${b.effectiveWsUrl}`);
  console.log(`       密钥: ${b.apiKeyMasked || '(未设)'}`);
}

console.log('');
console.log('=== NapCat 目录 ===');
for (const d of fs.readdirSync(TOOLS_DIR, { withFileTypes: true }).filter((x) => x.isDirectory())) {
  if (!d.name.includes('napcat') && !d.name.includes('qq-bot')) continue;
  const full = path.join(TOOLS_DIR, d.name);
  console.log(`  ${d.name}/`);
  const cfg = path.join(full, 'config');
  if (fs.existsSync(cfg)) {
    for (const f of fs.readdirSync(cfg).filter((x) => x.startsWith('onebot11_') || x === 'webui.json')) {
      console.log(`     config/${f}`);
      if (f.startsWith('onebot11_')) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(cfg, f), 'utf8'));
          const servers = j.network?.websocketServers ?? [];
          for (const s of servers) console.log(`        ws ${s.host}:${s.port} enable=${s.enable}`);
          console.log(`        parseMultMsg=${j.parseMultMsg} enableLocalFile2Url=${j.enableLocalFile2Url}`);
        } catch { /* 忽略 */ }
      }
    }
  }
}

console.log('');
console.log('=== 监听中的 OneBot 端口 ===');
const { execSync } = await import('node:child_process');
try {
  const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', windowsHide: true });
  const lines = out.split('\n').filter((l) => /:(3001|3011|6099|6100|6101)\s/.test(l) && /LISTEN/i.test(l));
  if (lines.length === 0) console.log('  （没有）');
  for (const l of lines) console.log('  ' + l.trim());
} catch (e) {
  console.log('  查询失败: ' + String(e.message));
}
