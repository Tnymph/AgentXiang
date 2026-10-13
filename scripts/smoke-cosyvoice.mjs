// 冒烟测试：CosyVoice2 客户端与音色注册表（服务不在线就跳过真合成那一段）
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, DATA_DIR, ROOT } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as cosy from '../src/modules/cosyvoice.js';
import * as voices from '../src/modules/voices.js';

ensureDirs();
let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', label, extra ?? ''); }
};

console.log('--- safeName / insideDir（音色名 = 目录名，必须干净）---');
check('普通名字可以', cosy.safeName('tomori').ok === true);
check('带前缀的名字要剥掉前缀再校验', cosy.isCosyId('cosy:tomori') === true && cosy.stripPrefix('cosy:tomori') === 'tomori');
check('中文不行', cosy.safeName('高松灯').ok === false);
check('带斜杠不行', cosy.safeName('a/b').ok === false && cosy.safeName('..').ok === false);
check('太短不行', cosy.safeName('a').ok === false);
const base = path.resolve('data', 'tmp', 'cosy-test-voices');
check('正常名拼出的路径在目录里', cosy.insideDir(base, 'tomori') === path.join(base, 'tomori'));
check('穿越名拼出的路径被拒', cosy.insideDir(base, '../evil') === null && cosy.insideDir(base, 'a/b') === null);

console.log('--- listVoices（目录 + ref.wav + ref.txt 齐了才算）---');
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(path.join(base, 'ok'), { recursive: true });
fs.copyFileSync(path.resolve('data/voice-ref/zhangxiaoxiang-16k.wav'), path.join(base, 'ok', 'ref.wav'));
fs.writeFileSync(path.join(base, 'ok', 'ref.txt'), '测试文字\n', 'utf8');
fs.mkdirSync(path.join(base, 'incomplete'), { recursive: true });
fs.writeFileSync(path.join(base, 'incomplete', 'ref.txt'), '只有文字\n', 'utf8');
fs.mkdirSync(path.join(base, '中文名'), { recursive: true });
fs.writeFileSync(path.join(base, '中文名', 'ref.txt'), 'x\n', 'utf8');
const listed = cosy.listVoices(base);
check('只列出完整的那个', listed.length === 1 && listed[0].name === 'ok', JSON.stringify(listed.map((v) => v.id)));
check('id 带引擎前缀', listed[0].id === 'cosy:ok', listed[0].id);
check('时长按 16k 算出来', listed[0].seconds > 10 && listed[0].seconds < 14, String(listed[0].seconds));
check('参考文字读得到', listed[0].refText === '测试文字', listed[0].refText);

console.log('--- addVoice 的各种拒绝（before 写盘就挡住）---');
const rejected = async (args) => {
  try { return await cosy.addVoice({ dir: base, ...args }); } catch (e) { return { ok: false, error: String(e.message) }; }
};
const r1 = await rejected({ name: '../evil', refAudioPath: 'style-samples/audio/p10.m4a', text: 'x' });
check('穿越的名字被拒', r1.ok === false, JSON.stringify(r1));
const r2 = await rejected({ name: 'tomori2', refAudioPath: '../../outside.wav', text: 'x' });
check('项目外的音频路径被拒', r2.ok === false && r2.error.includes('项目目录'), JSON.stringify(r2));
const r3 = await rejected({ name: 'tomori3', refAudioPath: 'style-samples/audio/p10.m4a', text: '   ' });
check('没有参考文字被拒', r3.ok === false && r3.error.includes('参考文字'), JSON.stringify(r3));
const r4 = await rejected({ name: 'tomori4', refAudioPath: 'style-samples/audio/nope.m4a', text: 'x' });
check('音频不存在被拒', r4.ok === false, JSON.stringify(r4));
check('被拒时不留目录', !fs.existsSync(path.join(base, 'tomori2')) && !fs.existsSync(path.join(base, 'tomori3')));

console.log('--- addVoice 正常登记（截 6 秒 + 写文字）---');
const okAdd = await cosy.addVoice({
  name: 'shortclip',
  refAudioPath: 'style-samples/audio/p10.m4a',
  startSec: 280.382,
  durSec: 6,
  text: '接下来观察二次曲线的标准方程',
  dir: base,
});
check('登记成功', okAdd.ok === true, JSON.stringify(okAdd.error ?? okAdd.voice?.id));
if (okAdd.ok) {
  const v = cosy.listVoices(base).find((x) => x.name === 'shortclip');
  check('登记出来的时长约 6 秒', v && Math.abs(v.seconds - 6) < 0.6, String(v?.seconds));
  check('是 16k 单声道（服务的硬要求）', v?.sampleRate === 16000, String(v?.sampleRate));
}
const dup = await rejected({ name: 'shortclip', refAudioPath: 'style-samples/audio/p10.m4a', startSec: 0, durSec: 6, text: 'x' });
check('同名被拒', dup.ok === false && dup.error.includes('已经有'), JSON.stringify(dup));
fs.rmSync(base, { recursive: true, force: true });

console.log('--- 统一清单与引擎判定 ---');
const all = voices.listAll();
check('统一清单里有新引擎的音色', all.some((v) => v.engine === 'cosyvoice'), JSON.stringify(all.map((v) => v.id)));
check('也有老引擎的音色', all.some((v) => v.engine === 'zipvoice') || all.some((v) => v.engine === 'vits'), JSON.stringify(all.map((v) => v.engine)));
check('cosy: 前缀 → 新引擎', voices.engineOf('cosy:anything') === 'cosyvoice');
check('空 voiceId → 老引擎（保持老行为）', voices.engineOf('') === 'zipvoice');
check('找不到的音色 → 老引擎', voices.engineOf('nope-nope') === 'zipvoice');
check('find 能找到真音色', !!voices.find('cosy:zhangxiaoxiang'), JSON.stringify(voices.find('cosy:zhangxiaoxiang')?.id));

console.log('--- 服务在线吗（不在线就跳过真合成）---');
const st = await cosy.probe(null);
check('探测有明确结论（ok 或带 error）', typeof st.ok === 'boolean');
if (!st.ok) {
  console.log(`  （服务没在跑：${st.host}:${st.port} ${st.error ?? ''} —— 跳过真合成）`);
} else {
  console.log(`  服务在线：${st.host}:${st.port} 模型已加载=${st.loaded} 采样率=${st.sampleRate}`);
  const r = await cosy.synthesize('同学们好，这是新引擎的测试。', { voiceId: 'cosy:zhangxiaoxiang', speed: 1.0 });
  check('新引擎能合成', r.ok === true, JSON.stringify(r.error));
  if (r.ok) {
    check('产出真文件且是 wav', fs.existsSync(r.path) && fs.readFileSync(r.path).subarray(0, 4).toString('ascii') === 'RIFF', r.path);
    check('采样率 24k', r.sampleRate === 24000, String(r.sampleRate));
    check('引擎标记正确', r.engine === 'cosyvoice' && r.kind === 'cosyvoice', JSON.stringify({ e: r.engine, k: r.kind }));
    console.log(`   合成 ${r.seconds} 秒音频，耗时 ${(r.ms / 1000).toFixed(1)} 秒`);
    fs.rmSync(r.path, { force: true });
  }
  const bad = await cosy.synthesize('测试', { voiceId: 'cosy:不存在的音色' });
  check('坏音色名给出明确错误', bad.ok === false && !!bad.error, JSON.stringify(bad.error));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
log.closeLogs();
