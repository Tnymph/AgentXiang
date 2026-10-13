// 恢复时段设置，并检查整体状态
const base = 'http://127.0.0.1:6188';

const j = async (p, body) => {
  const r = await fetch(base + p, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
};

await new Promise((r) => setTimeout(r, 6000));

const o = await j('/api/overview');
for (const b of o.bots) console.log(`机器人 QQ=${b.qq} 连接=${b.connected} 密钥=${b.apiKeyMasked}`);

// 时段被界面误清空了，恢复成全天
await j('/api/bots/1/schedules', {
  slots: [{ slotNo: 1, name: '全天', ranges: [{ start: 0, end: 1440 }] }],
  activeSlot: 1,
});
const s = await j('/api/bots/1/schedules');
console.log('时段:', s.slots.map((x) => `${x.name}[${x.ranges.map((r) => r.start + '-' + r.end).join(',')}]${x.isActive ? '(生效中)' : ''}`).join(' '));
console.log('接入状态:', s.status.active ? '已接入' : '未接入', '—', s.status.reason);

// 名单与别名
const l = await j('/api/bots/1/lists');
console.log('用户接收:', JSON.stringify(l.user.accept.targets), '模式', l.user.accept.mode);
console.log('群接收:  ', JSON.stringify(l.group.accept.targets));
const st = await j('/api/bots/1/settings');
console.log('别名:    ', JSON.stringify(st.settings.speak.aliases));
console.log('图片档位:', st.settings.api.vision.detail);
console.log('管理员:  ', JSON.stringify((await j('/api/bots/1/admins')).admins));
