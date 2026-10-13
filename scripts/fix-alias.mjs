// 修正别名列表并把图片档位改成 auto
// 用 Node 而不是 .ps1：PowerShell 读无 BOM 的 UTF-8 会把中文搞乱
const base = 'http://127.0.0.1:6188';

const j = async (p, body) => {
  const r = await fetch(base + p, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
};

const cur = await (await fetch(base + '/api/bots/1/settings')).json();
const before = cur.settings.speak.aliases ?? [];
console.log('原有别名:', JSON.stringify(before));

// 把之前那次编码事故写进去的乱码剔掉，只留正常的中文词
const clean = before.filter((x) => /^[\u4e00-\u9fa5A-Za-z0-9_]+$/.test(String(x)));
if (clean.length !== before.length) {
  console.log('清掉乱码条目:', JSON.stringify(before.filter((x) => !clean.includes(x))));
}
if (!clean.includes('小向')) clean.push('小向');

const r1 = await j('/api/bots/1/settings', { patch: { speak: { aliases: clean } } });
console.log('别名已设为:', JSON.stringify(r1.settings.speak.aliases));

const r2 = await j('/api/bots/1/settings', { patch: { api: { vision: { detail: 'auto' } } } });
console.log('图片档位:', r2.settings.api.vision.detail);

// 回读确认
const after = await (await fetch(base + '/api/bots/1/settings')).json();
console.log('');
console.log('回读确认:');
console.log('  别名 =', JSON.stringify(after.settings.speak.aliases));
console.log('  图片档位 =', after.settings.api.vision.detail);
console.log('  群发言模式 =', after.settings.speak.defaultGroupMode);
console.log('  单条字数上限 =', after.settings.speak.replyMaxChars);
