// 直连接口测一下固定例句能不能存进去
const base = 'http://127.0.0.1:6188';
const get = async (p) => (await fetch(base + p)).json();
const post = async (p, b) => {
  const r = await fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b ?? {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const before = await get('/api/bots/1/persona');
console.log('修改前例句数:', before.examples.length);
console.log('前 3 条:', before.examples.slice(0, 3));
console.log('');

const NEW = '这是一句新加的固定例句。';
const r = await post('/api/bots/1/persona', {
  body: before.body,
  examples: [...before.examples, NEW],
  params: before.params,
});
console.log('保存返回:', r.status, JSON.stringify(r.body));

const after = await get('/api/bots/1/persona');
console.log('');
console.log('修改后例句数:', after.examples.length);
console.log('新例句在不在:', after.examples.includes(NEW) ? '在 ✓' : '不在 ✗');
console.log('正文长度有没有变:', before.body.length, '->', after.body.length);
console.log('');
console.log('params 是否合法:', (() => { try { JSON.parse(JSON.stringify(after.params)); return '是'; } catch { return '否'; } })());
console.log('params 内容:', JSON.stringify(after.params));
