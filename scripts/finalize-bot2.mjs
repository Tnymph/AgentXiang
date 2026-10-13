// 把第二台机器人指向它自己的 NapCat 目录，并复查两台的状态
const base = 'http://127.0.0.1:6188';

await new Promise((r) => setTimeout(r, 6000));

const post = async (p, b) => {
  const r = await fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b ?? {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const bots = await (await fetch(base + '/api/bots')).json();
const second = bots.find((x) => x.id !== 1);
if (!second) { console.log('没找到第二台'); process.exit(1); }

await post(`/api/bots/${second.id}/settings`, { patch: { napcatDir: 'napcat2' } });
await post(`/api/bots/${second.id}/restart`, {});
await new Promise((r) => setTimeout(r, 4000));

console.log('=== 两台机器人 ===');
for (const b of await (await fetch(base + '/api/bots')).json()) {
  console.log(`  #${b.id} 「${b.name}」 QQ=${b.qq}`);
  console.log(`       连接=${b.connected}  ws=${b.effectiveWsUrl}  NapCat目录=${b.napcatDir}  密钥=${b.apiKeyMasked || '(未设)'}`);
  const qr = await (await fetch(`${base}/api/bots/${b.id}/qrcode-info`)).json();
  console.log(`       二维码: ${qr.exists ? `生成于 ${qr.ageSec} 秒前` : '没有（说明这个号还没启动 NapCat，或者已经登录过）'}`);
}

console.log('');
console.log('=== 名单与时段（第二台是全新的，都是用不了的默认值）===');
for (const b of await (await fetch(base + '/api/bots')).json()) {
  const l = await (await fetch(`${base}/api/bots/${b.id}/lists`)).json();
  const s = await (await fetch(`${base}/api/bots/${b.id}/schedules`)).json();
  console.log(`  #${b.id} 「${b.name}」`);
  console.log(`       用户接收: ${l.user.accept.mode} [${l.user.accept.targets.join(', ') || '空'}]   群接收: ${l.group.accept.mode} [${l.group.accept.targets.join(', ') || '空'}]`);
  console.log(`       时段: ${s.slots.map((x) => x.name + (x.ranges.length ? `(${x.ranges.length}段)` : '(空)')).join(' ')} -> ${s.status.active ? '已接入' : '未接入：' + s.status.reason}`);
}
