// 配置第二台机器人：指向它自己的 NapCat（3011），并补上 API 密钥
//
// 密钥必须走程序自己的接口写入，不能直接改文件——程序把密钥缓存在内存里，
// 从外面改文件它看不到。
const base = 'http://127.0.0.1:6188';
const KEY = process.env.DS_KEY;

const post = async (p, b) => {
  const r = await fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b ?? {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const bots = await (await fetch(base + '/api/bots')).json();
const second = bots.find((x) => x.id !== 1);
if (!second) { console.log('没找到第二台机器人'); process.exit(1); }
console.log(`目标： #${second.id} 「${second.name}」 QQ=${second.qq}`);

console.log('');
console.log('=== 1. 指向自己的 NapCat 端口 ===');
const ws = 'ws://127.0.0.1:3011';
const r1 = await post(`/api/bots/${second.id}/settings`, { patch: { napcatWsUrl: ws } });
console.log(`  设置 ${ws} -> ${JSON.stringify(r1.body?.settings?.napcatWsUrl ?? r1.body)}`);

console.log('');
console.log('=== 2. 补 API 密钥 ===');
if (!KEY) {
  console.log('  没有从环境变量拿到密钥，跳过（你可以在「接入与密钥」页填）');
} else {
  const r2 = await post(`/api/bots/${second.id}/key`, { key: KEY });
  console.log(`  ${r2.status} ${JSON.stringify(r2.body)}`);
}

console.log('');
console.log('=== 3. 重连 ===');
await post(`/api/bots/${second.id}/restart`, {});
await new Promise((r) => setTimeout(r, 3000));

const after = await (await fetch(base + '/api/bots')).json();
for (const b of after) {
  console.log(`  #${b.id} 「${b.name}」 QQ=${b.qq} 实际地址=${b.effectiveWsUrl} 连接=${b.connected} 密钥=${b.apiKeyMasked || '(未设)'}`);
}
