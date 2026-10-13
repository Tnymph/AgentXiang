// 重启后的验收：进程在不在、界面通不通、跑的到底是不是新代码
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

// ---- 1) 进程与启动时间 ----
let pid = null, startedAt = null;
try {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object { $_.CommandLine -like '*index.js*' } | ForEach-Object { '{0}|{1:o}' -f $_.ProcessId, $_.CreationDate }",
  ], { encoding: 'utf8' }).trim();
  if (out) {
    const [p, t] = out.split('|');
    pid = p; startedAt = new Date(t);
  }
} catch (e) { /* 下面统一报 */ }

console.log('进程：' + (pid ? `PID ${pid}，启动于 ${startedAt.toLocaleString('zh-CN')}` : '❌ 没找到'));

// ---- 2) 改过的文件 vs 进程启动时间：进程必须比文件新 ----
const edited = [
  'src/modules/speaking.js', 'src/message.js', 'src/names.js', 'src/pipeline.js',
  'src/web/public/app.js', 'src/cmdline.js', 'src/llm.js', 'src/modules/commands.js',
  'src/modules/forward.js', 'src/modules/impression.js', 'src/modules/talk.js',
];
console.log('\n代码新鲜度（进程启动时间必须晚于文件改动时间）：');
let fresh = true;
for (const f of edited) {
  const m = fs.statSync(f).mtime;
  const ok = startedAt ? startedAt.getTime() >= m.getTime() : false;
  if (!ok) fresh = false;
  const lag = startedAt ? Math.round((startedAt.getTime() - m.getTime()) / 1000) : null;
  console.log(`  ${ok ? '✅' : '❌'} ${f.padEnd(30)} 改动 ${m.toLocaleTimeString('zh-CN')}   进程晚 ${lag} 秒`);
}

// ---- 3) 界面与接口 ----
console.log('\n接口探测：');
let web = true;
for (const [path, label] of [['/', '首页'], ['/api/overview', '概览']]) {
  try {
    const res = await fetch('http://127.0.0.1:6188' + path, { signal: AbortSignal.timeout(8000) });
    let extra = '';
    if (path.startsWith('/api')) {
      const j = JSON.parse(await res.text());
      const bots = (j.bots ?? []).map((b) => `#${b.id}${b.name}${b.connected ? '(已连接)' : '(未连接)'}`);
      extra = '  ' + bots.join(' / ');
      if (!(j.bots ?? []).every((b) => b.connected)) web = false;
    }
    console.log(`  ${res.status === 200 ? '✅' : '❌'} ${label}  HTTP ${res.status}${extra}`);
    if (res.status !== 200) web = false;
  } catch (e) {
    console.log(`  ❌ ${label}  失败：${e.message}`);
    web = false;
  }
}

// ---- 4) 粗筛对纯图的判定（直接引用磁盘上的模块，确认改动在位） ----
const { prefilter } = await import('../src/modules/speaking.js');
const v = prefilter({ textClean: '', images: [{ url: 'x' }] },
  { speak: { active: { minMessageLength: 1, randomRate: 1 } } }, { random: () => 0 });
console.log('\n粗筛对「纯图片」的判定：' + (v.pass ? '✅ 放行' : '❌ 拦下 → ' + v.reason));

console.log('');
console.log(pid && fresh && web && v.pass ? '✅ 全部通过，修复已生效' : '❌ 有项目没通过，见上');
