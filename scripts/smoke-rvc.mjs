// 变声（RVC）模块冒烟：注册表、引擎判定、路径与错误分支。
// 不依赖常驻服务：服务端口指向一个没人听的号，验证「服务没起来」时的表现。
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import * as rvc from '../src/modules/rvc.js';
import * as voices from '../src/modules/voices.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')); }
}

const ROOT = path.resolve('.');
console.log('--- 注册表 ---');
const list = rvc.listVoices();
check('列出了 tomori', list.some((v) => v.name === 'tomori'), JSON.stringify(list.map((v) => v.name)));
const tomori = rvc.find('rvc:tomori');
check('find 认前缀', !!tomori);
check('find 也认裸名字', rvc.find('tomori')?.name === 'tomori');
check('find 不存在的返回 null', rvc.find('nope-nope') === null);
check('标签是中文名', tomori?.label === '高松灯', String(tomori?.label));
check('模型与索引都在', !!tomori?.model && !!tomori?.index, JSON.stringify({ m: tomori?.model, i: tomori?.index }));
check('声源默认 biaozhun', tomori?.sourceVoice === 'cosy:biaozhun', String(tomori?.sourceVoice));
check('pitch 是数字', typeof tomori?.pitch === 'number', String(tomori?.pitch));
check('indexRate 在 0~1', tomori?.indexRate >= 0 && tomori.indexRate <= 1, String(tomori?.indexRate));
check('safeName 拦路径', rvc.find('rvc:../etc') === null);
check('空 id 不炸', rvc.find('') === null && rvc.find(null) === null);

console.log('--- 引擎判定 ---');
check('rvc: 前缀 → rvc', voices.engineOf('rvc:tomori') === 'rvc');
check('cosy: 前缀 → cosyvoice', voices.engineOf('cosy:xiaoxiang') === 'cosyvoice');
check('未知 id 落到老引擎', voices.engineOf('') === 'zipvoice', voices.engineOf(''));
check('变声音色的声源拿得到', voices.sourceOf('rvc:tomori') === 'cosy:biaozhun', voices.sourceOf('rvc:tomori'));
check('listAll 里 rvc 排最前', voices.listAll()[0]?.engine === 'rvc', voices.listAll()[0]?.engine);
check('listAll 里能找到高松灯', voices.listAll().some((v) => v.id === 'rvc:tomori'));
check('listAll 里 cosy 音色还在', voices.listAll().some((v) => v.engine === 'cosyvoice'));

console.log('--- 错误分支（服务没起来）---');
// 不能随手挑一个号当「没人听」：本机 QQ 就占着 6099 并会回 200。先真的占一个再放掉。
const net = await import('node:net');
const freePort = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const noService = { rvc: { host: '127.0.0.1', port: freePort } };
const p = await rvc.convert(path.join(ROOT, 'data/tmp/sft/s1.wav'), { voiceId: 'rvc:tomori', settings: noService, timeoutMs: 3000 });
check('服务没起来时给的是错误而不是抛异常', p.ok === false, JSON.stringify(p));
check('错误里点明了服务', String(p.error).includes(String(freePort)) || String(p.error).includes('没响应'), String(p.error));

const outside = await rvc.convert('C:/Windows/win.ini', { voiceId: 'rvc:tomori', settings: noService, timeoutMs: 3000 });
check('项目目录外的音频不接', outside.ok === false && String(outside.error).includes('项目目录'), String(outside.error));

const ghost = await rvc.convert(path.join(ROOT, 'data/tmp/sft/s1.wav'), { voiceId: 'rvc:ghost', settings: noService, timeoutMs: 3000 });
check('音色不存在时先报音色', ghost.ok === false && String(ghost.error).includes('找不到'), String(ghost.error));

console.log('--- 探测 ---');
const down = await rvc.probe(noService);
check('探测给出 ok:false', down.ok === false, JSON.stringify(down));
check('探测带上音色数量', down.voices === list.length, String(down.voices));
check('别人的端口不会被认成变声服务', String(down.error ?? '').length > 0, String(down.error));
const up = await rvc.probe({});
console.log('  （端口 6012 现在 ' + (up.ok ? '在跑' : '没跑') + '，公共模型 ' + (up.models ? '齐了' : '缺 ' + up.missing.join(',')) + '）');
check('探测永远返回对象', typeof up === 'object' && typeof up.ok === 'boolean');

console.log('--- 缺文件的情况 ---');
const emptyDir = path.join(ROOT, 'data/tmp/rvc-empty');
fs.rmSync(emptyDir, { recursive: true, force: true });
fs.mkdirSync(emptyDir, { recursive: true });
fs.mkdirSync(path.join(emptyDir, 'nofile'), { recursive: true });
check('目录里没有 model.pth 就不算音色', rvc.listVoices(emptyDir).length === 0);
fs.writeFileSync(path.join(emptyDir, 'ok'), '');
fs.mkdirSync(path.join(emptyDir, 'okdir'), { recursive: true });
fs.writeFileSync(path.join(emptyDir, 'okdir', 'model.pth'), 'x');
check('只有 model.pth 也算音色（索引可选）', rvc.listVoices(emptyDir).length === 1);
fs.writeFileSync(path.join(emptyDir, 'okdir', 'voice.json'), '{ 坏 json');
check('voice.json 坏了不炸，走默认', rvc.listVoices(emptyDir)[0]?.f0Method === 'rmvpe');
fs.rmSync(emptyDir, { recursive: true, force: true });

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
