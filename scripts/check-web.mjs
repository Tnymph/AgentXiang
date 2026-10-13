// 真的请求一次，确认 Web 界面可用（不看日志，看响应）
const base = 'http://127.0.0.1:6188';

async function get(path) {
  const res = await fetch(base + path, { signal: AbortSignal.timeout(8000) });
  return { res, text: await res.text() };
}

let ok = true;

// 1) 首页
let html = '';
try {
  const { res, text } = await get('/');
  html = text;
  const title = (text.match(/<title>(.*?)<\/title>/) ?? [])[1] ?? '?';
  console.log(`✅ 首页  HTTP ${res.status}  ${res.headers.get('content-type')}  标题=${title}  长度=${text.length}`);
  if (res.status !== 200) ok = false;
} catch (e) {
  console.log(`❌ 首页  失败：${e.message}`);
  ok = false;
}

// 2) 首页里真正引用的每个静态资源，逐个请求——不猜文件名
const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
if (!assets.length) {
  console.log('⚠️  首页里没找到任何 / 开头的静态资源引用（是不是被改 inline 了）');
} else {
  for (const a of assets) {
    try {
      const { res, text } = await get(a);
      const good = res.status === 200 && text.length > 0;
      console.log(`${good ? '✅' : '❌'} 资源 ${a}  HTTP ${res.status}  ${text.length} 字节`);
      if (!good) ok = false;
    } catch (e) {
      console.log(`❌ 资源 ${a}  失败：${e.message}`);
      ok = false;
    }
  }
}

// 3) 接口
try {
  const { res, text } = await get('/api/overview');
  const j = JSON.parse(text);
  const bots = (j.bots ?? []).map((b) => `#${b.id} ${b.name}${b.connected ? '(已连接)' : '(未连接)'}`).join(' / ');
  const allUp = (j.bots ?? []).every((b) => b.connected);
  console.log(`${allUp ? '✅' : '⚠️ '} 概览接口  HTTP ${res.status}  机器人=${bots}`);
  if (!allUp) ok = false;
} catch (e) {
  console.log(`❌ 概览接口  失败：${e.message}`);
  ok = false;
}

console.log('');
console.log(ok ? 'Web 界面可用：' + base : '还有问题，见上面的 ❌');
