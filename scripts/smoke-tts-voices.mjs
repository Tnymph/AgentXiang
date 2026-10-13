// 验证：两种音色都认得出来，ZipVoice 两档参数都能出声。真机跑（本地、不花钱）。
import fs from 'node:fs';
import * as tts from '../src/modules/tts.js';

const voices = tts.listVoices();
console.log('=== 认出来的音色 ===');
for (const v of voices) {
  console.log(`  ${v.id}  kind=${v.kind}  ${v.sizeMB}MB` + (v.kind === 'zipvoice' ? `  参考文字="${v.refText.slice(0, 24)}…"` : ''));
}
const zip = voices.find((v) => v.kind === 'zipvoice');

console.log('\n=== 参数拼装 ===');
if (zip) {
  const a1 = tts.buildArgs(zip, '你好', 'o.wav', { quality: 'normal' });
  const a2 = tts.buildArgs(zip, '你好', 'o.wav', { quality: 'high' });
  console.log('  默认档含 speed/silence：' + (a1.some((x) => x.startsWith('--speed=')) && a1.some((x) => x.startsWith('--tts-silence-scale='))));
  console.log('  高质量档含 num-steps：' + a2.some((x) => x.startsWith('--num-steps=')));
  console.log('  两档都带参考：' + (a1.some((x) => x.startsWith('--reference-audio=')) && a2.some((x) => x.startsWith('--reference-text='))));
  console.log('  声码器参数在：' + a1.some((x) => x.startsWith('--zipvoice-vocoder=')));
}

console.log('\n=== 真机合成（两档各一句）===');
const say = '同学们好，我是张小向，今天我们讲矩阵的秩。';
for (const q of ['normal', 'high']) {
  const r = await tts.synthesize(say, { voiceId: zip?.id ?? '', quality: q });
  console.log(`  ${q}: ` + (r.ok ? `✓ ${r.seconds} 秒，耗时 ${r.ms}ms，音色=${r.voice}(${r.kind})` : '✗ ' + r.error));
  if (r.ok) fs.rmSync(r.path, { force: true });
}
const vits = voices.find((v) => v.kind === 'vits');
if (vits) {
  const r = await tts.synthesize('这是一条通用音色的测试。', { voiceId: vits.id });
  console.log(`  vits(${vits.id}): ` + (r.ok ? `✓ ${r.seconds} 秒，耗时 ${r.ms}ms` : '✗ ' + r.error));
  if (r.ok) fs.rmSync(r.path, { force: true });
}
