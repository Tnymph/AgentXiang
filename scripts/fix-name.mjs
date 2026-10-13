// 修掉机器人名字里的编码乱码（之前用 PowerShell 写中文导致）
const base = 'http://127.0.0.1:6188';

const list = async () => (await (await fetch(base + '/api/bots')).json());

for (const b of await list()) {
  console.log(`修复前: id=${b.id} name=${JSON.stringify(b.name)} qq=${b.qq}`);
}

const r = await fetch(base + '/api/bots/1', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '客服小向' }),
});
console.log('更新:', JSON.stringify(await r.json()));

for (const b of await list()) {
  const bad = /[?？\uFFFD]/.test(String(b.name ?? ''));
  console.log(`修复后: id=${b.id} name=${JSON.stringify(b.name)} ${bad ? '← 仍有乱码' : '✓'}`);
}

// 顺便检查别处有没有同样的乱码
const persona = await (await fetch(base + '/api/bots/1/persona')).json();
console.log('');
console.log('风格卡名字:', JSON.stringify(persona.name));
console.log('风格卡小节数:', persona.examples.length, '条例句');
const fb = await (await fetch(base + '/api/bots/1/fallback')).json();
const garbled = [];
for (const [scene, s] of Object.entries(fb.scenes)) {
  for (const it of s.items) if (/[?？\uFFFD]{2,}/.test(String(it.text))) garbled.push(`${scene}: ${it.text}`);
}
console.log('默认回复里的乱码:', garbled.length ? garbled : '无');
