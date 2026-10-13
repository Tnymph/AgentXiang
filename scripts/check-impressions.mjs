// 检查印象页的数据来源，并实际跑一次提炼
const base = 'http://127.0.0.1:6188';
const get = async (p) => (await fetch(base + p)).json();
const post = async (p, b) => (await fetch(base + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b ?? {}),
})).json();

await new Promise((r) => setTimeout(r, 6000));

const bots = await get('/api/bots');
for (const b of bots) console.log(`机器人 ${b.name} QQ=${b.qq} 连接=${b.connected}`);

console.log('');
console.log('=== 印象页会列出的人 ===');
const rows = await get('/api/bots/1/impressions');
if (!rows.length) {
  console.log('  （空）');
} else {
  for (const r of rows) {
    const has = [r.facts && 'F', r.feelings && 'I', r.manual && 'M'].filter(Boolean).join('') || '无';
    console.log(`  人#${r.personId}  QQ=${r.qqs.join('/')}  说过 ${r.msgCount} 句  有印象:${has}  最近:${(r.lastText || '').slice(0, 24)}`);
  }
}

console.log('');
console.log('=== 实际跑一次提炼 ===');
const ex = await post('/api/bots/1/impressions/extract', {});
console.log(`  完成 ${ex.done}/${ex.total}`);
for (const r of ex.results ?? []) {
  console.log(`  人#${r.personId}: ${r.ok ? 'ok' : '失败 ' + r.error}`);
  if (r.ok) {
    console.log(`     facts: ${r.facts}`);
    console.log(`     feelings: ${r.feelings}`);
  }
}
