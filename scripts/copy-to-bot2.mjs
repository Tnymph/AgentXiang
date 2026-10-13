// 把「客服小向」的时段与名单复制到「猪咪群友」，风格卡保持空白
const base = 'http://127.0.0.1:6188';

const post = async (p, b) => {
  const r = await fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b ?? {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const get = async (p) => (await fetch(base + p)).json();

const before = await get('/api/bots');
const src = before.find((x) => x.id === 1);
const dst = before.find((x) => x.id === 2);
console.log(`源  #${src.id} 「${src.name}」 → 目标 #${dst.id} 「${dst.name}」`);
console.log('');

const PARTS = ['schedule', 'lists'];   // 按你说的：时段 + 名单；风格卡不动
const r = await post(`/api/bots/${dst.id}/copy-from`, { fromBotId: src.id, parts: PARTS });
console.log('复制结果:', r.status, JSON.stringify(r.body));
console.log('（风格卡不在复制范围内，保持空白）');

await post(`/api/bots/${dst.id}/restart`, {});
await new Promise((x) => setTimeout(x, 4000));

console.log('');
console.log('=== 复制后复查 ===');
for (const b of await get('/api/bots')) {
  const l = await get(`/api/bots/${b.id}/lists`);
  const s = await get(`/api/bots/${b.id}/schedules`);
  const p = await get(`/api/bots/${b.id}/persona`);
  console.log(`#${b.id} 「${b.name}」 连接=${b.connected}`);
  console.log(`     时段: ${s.slots.map((x) => x.name + (x.ranges.length ? `(${x.ranges.length}段)` : '(空)')).join(' ')}  → ${s.status.active ? '已接入' : '未接入：' + s.status.reason}`);
  console.log(`     用户接收: ${l.user.accept.mode} [${l.user.accept.targets.join(', ') || '空'}]   群接收: ${l.group.accept.mode} [${l.group.accept.targets.join(', ') || '空'}]`);
  console.log(`     风格卡: ${p.body ? p.body.length + ' 字 + ' + p.examples.length + ' 例句' : '空白'}`);
}
