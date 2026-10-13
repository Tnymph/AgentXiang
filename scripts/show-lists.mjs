// 看清楚四个名单维度的模式与内容，以及它们合起来意味着什么
const base = 'http://127.0.0.1:6188';
const l = await (await fetch(base + '/api/bots/1/lists')).json();

const NAME = { user: '用户', group: '群' };
const DIR = { accept: '接收', reply: '回复' };
const MODE = { whitelist: '白名单', blacklist: '黑名单' };

console.log('维度         模式      名单内容                 实际含义');
console.log('─'.repeat(78));
for (const scope of ['user', 'group']) {
  for (const dir of ['accept', 'reply']) {
    const d = l[scope][dir];
    const targets = d.targets.length ? d.targets.join(', ') : '(空)';
    let meaning;
    if (d.mode === 'whitelist') {
      meaning = d.targets.length ? `只放行：${targets}` : '谁都不放行';
    } else {
      meaning = d.targets.length ? `放行除了 ${targets} 以外的所有人` : '所有人都放行';
    }
    if (!d.configured) meaning += '（未配置，跟随接收维度）';
    console.log(
      `${NAME[scope]}${DIR[dir]}`.padEnd(12) +
      MODE[d.mode].padEnd(10) +
      targets.padEnd(24) +
      meaning,
    );
  }
}

console.log('');
console.log('当前管理员:', JSON.stringify((await (await fetch(base + '/api/bots/1/admins')).json()).admins));
