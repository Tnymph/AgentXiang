// 理清 QQ 进程树：哪个实例持有 3001（在服役），哪个是多余的
import { execSync } from 'node:child_process';

const ps = execSync(
  'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'QQ.exe\'\\" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Depth 3"',
  { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
);
const procs = JSON.parse(ps);
const byPid = new Map(procs.map((p) => [p.ProcessId, p]));

// 找每个进程的根（沿父链往上走到不在 QQ 里的那一层）
function rootOf(pid) {
  let cur = byPid.get(pid);
  let guard = 0;
  while (cur && byPid.has(cur.ParentProcessId) && guard++ < 20) cur = byPid.get(cur.ParentProcessId);
  return cur;
}

// 端口 -> 持有进程 -> 根
const ports = {};
for (const p of [3001, 6099, 6100]) {
  try {
    const out = execSync(`powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)"`,
      { encoding: 'utf8', windowsHide: true }).trim();
    if (out) ports[p] = Number(out);
  } catch { /* 忽略 */ }
}

console.log('=== 端口归属 ===');
const rootsInUse = new Set();
for (const [port, pid] of Object.entries(ports)) {
  const r = rootOf(pid);
  if (r) rootsInUse.add(r.ProcessId);
  const cmd = String(byPid.get(pid)?.CommandLine ?? '');
  const isMain = !cmd.includes('--type=');
  console.log(`  ${port} → PID ${pid}（${isMain ? '主进程' : '子进程'}）→ 根 PID ${r?.ProcessId}`);
}

console.log('');
console.log('=== 所有 QQ 根进程 ===');
const roots = [...new Set(procs.map((p) => rootOf(p.ProcessId)?.ProcessId))].filter(Boolean);
for (const pid of roots) {
  const r = byPid.get(pid);
  const cmd = String(r.CommandLine ?? '');
  const dir = cmd.match(/user-data-dir=["']?([^\s"']+)/)?.[1] ?? '(默认 AppData\\Roaming\\QQ — 你自己的QQ)';
  const serving = rootsInUse.has(pid) ? ' ← 有端口在服役' : '';
  const children = procs.filter((p) => p.ProcessId !== pid).length;
  console.log(`  PID ${pid}  ${dir}${serving}`);
}
console.log(`（QQ 进程总数 ${procs.length}）`);
