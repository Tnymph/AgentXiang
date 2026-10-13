// 冒烟测试：造音色（放一段音频自动生成音色目录）
// 纯函数部分不碰磁盘；最后会真的造一个音色（硬链接模型文件 + ffmpeg 切 14 秒），
// 验完就删掉，不在 .tools/tts 里留东西。
import fs from 'node:fs';
import path from 'node:path';
import * as forge from '../src/modules/voice-forge.js';
import * as tts from '../src/modules/tts.js';
import * as log from '../src/logger.js';

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', label, extra ?? ''); }
};

console.log('--- safeVoiceName（音色名就是目录名，必须纯 ASCII）---');
check('普通名字可以', forge.safeVoiceName('zhang2').ok === true);
check('短横线可以', forge.safeVoiceName('voice-a_b').name === 'voice-a_b');
check('中文不行', forge.safeVoiceName('张小向').ok === false);
check('单字符不行', forge.safeVoiceName('a').ok === false);
check('不以短横线开头', forge.safeVoiceName('-x').ok === false);
check('带路径分隔符不行', forge.safeVoiceName('a/b').ok === false && forge.safeVoiceName('..').ok === false);
check('空的不行', forge.safeVoiceName('  ').ok === false);

console.log('--- parseTsv / alignWindow（参考文字从带时间戳的转录里截，窗口对齐到整行）---');
const tsv = 'start\tend\ttext\n5.95\t9.1\t大家好欢迎学习\n9.918\t16.236\t这是一门什么样的课程呢\n';
const rows = forge.parseTsv(tsv);
check('表头被跳过', rows.length === 2, String(rows.length));
check('三列都解析出来', rows[1].start === 9.918 && rows[1].end === 16.236 && rows[1].text === '这是一门什么样的课程呢');
check('坏行不炸', forge.parseTsv('x\ny\tz\t\n1\t2\t好').length === 1);
const w1 = forge.alignWindow(rows, 5, 12);
check('整段都要', w1.text === '大家好欢迎学习这是一门什么样的课程呢' && w1.rows === 2);
check('起点对齐到行首', w1.start === 5.95, String(w1.start));
check('尾巴多留 0.1 秒', w1.dur === Number((16.236 - 5.95 + 0.1).toFixed(3)), String(w1.dur));
const w2 = forge.alignWindow(rows, 9.5, 1);
check('起点落在行中间就从这行算起', w2.text === '这是一门什么样的课程呢' && w2.start === 9.918);
const w3 = forge.alignWindow(rows, 0, 5);
check('窗外的行不要', w3.text === '大家好欢迎学习' && w3.rows === 1);
check('空窗返回空', forge.alignWindow(rows, 100, 5).text === '');

console.log('--- 实测：转录窗口拼出来 = 转录那几行（机器文字，可能有错字）---');
const tpl = forge.findTemplate();
check('找到模板音色', !!tpl && tpl.kind === 'zipvoice', JSON.stringify(tpl?.id));
if (tpl) {
  // 机器转录（p10.tsv）里就写着「专曲线」，而录音里说的是「双曲线和」——
  // 这就是小向一直发音模糊的根因，见 docs/文件与路径总账.md 第五节的记录。
  const MACHINE = '接下来观察二次曲线的标准方程对应的图形共有三种类型分别是椭圆专曲线抛物线';
  const FIXED = fs.readFileSync(path.join(tpl.dir, 'ref.txt'), 'utf8').trim();
  const got = forge.readTranscriptText('style-samples/audio/p10.m4a', 280.382, 12.206);
  check('同名 tsv 找得到', got.found === true, got.file);
  check('拼出来的文字 = 转录那几行', got.text === MACHINE, JSON.stringify(got.text));
  check('转录与人工核对后的定稿确实不同（当年就错在这）', MACHINE !== FIXED, JSON.stringify({ MACHINE, FIXED }));
  check('定稿写的是「双曲线和」', FIXED.includes('双曲线和'), FIXED);
  const miss = forge.readTranscriptText('style-samples/audio/p99.m4a', 0, 10);
  check('没有对应转录时不硬编', miss.found === false && miss.text === '');
  check('备份文件不会被当成模型文件拷进新音色', !forge.isModelFile('ref.txt.bak') && !forge.isModelFile('ref.wav'));
}

console.log('--- resolveAudio（相对路径按项目根算）---');
const okAudio = forge.resolveAudio('style-samples/audio/p10.m4a');
check('相对路径能解析', okAudio.ok === true, okAudio.error);
check('大小读得到', okAudio.size > 1000, String(okAudio.size));
check('绝对路径也认', forge.resolveAudio(okAudio.path).ok === true);
check('不存在的报错', forge.resolveAudio('style-samples/audio/nope.m4a').ok === false);
check('目录不算音频', forge.resolveAudio('style-samples/audio').ok === false);
check('非音频后缀拒绝', forge.resolveAudio('style-samples/transcript/p10.tsv').ok === false);
check('空的不行', forge.resolveAudio('').ok === false);

console.log('--- buildCutArgs（16k 单声道，-ss 要在 -i 前面）---');
const args = forge.buildCutArgs('src.m4a', 'ref.wav', 280.382, 14);
check('-ss 在 -i 前面（快速定位）', args.indexOf('-ss') < args.indexOf('-i'));
check('起点和时长都对', args[args.indexOf('-ss') + 1] === '280.382' && args[args.indexOf('-t') + 1] === '14');
// 参考段按模型采样率切：ZipVoice 的声码器是 24 kHz，以前压到 16k 再给它反而更糊（用户听出来的）
check('按 24k 单声道 16bit 切', args.includes('-ar') && args[args.indexOf('-ar') + 1] === '24000' && args[args.indexOf('-ac') + 1] === '1');
check('采样率可以换', forge.buildCutArgs('s', 'd', 0, 5, 16000)[forge.buildCutArgs('s', 'd', 0, 5, 16000).indexOf('-ar') + 1] === '16000');
check('丢掉视频轨', args.includes('-vn'));
check('输出在最后', args[args.length - 1] === 'ref.wav');

console.log('--- isModelFile（参考录音/文字不进新目录的模板区）---');
check('模型文件算', forge.isModelFile('encoder.int8.onnx') && forge.isModelFile('vocos_24khz.onnx') && forge.isModelFile('espeak-ng-data'));
check('参考与说明不算', !forge.isModelFile('ref.wav') && !forge.isModelFile('ref.txt') && !forge.isModelFile('README.txt'));

console.log('--- 真的造一个音色（硬链接，不额外占盘）---');
const TEST_ID = 'ztest-forge';
const TEST_DIR = path.join(tts.TTS_DIR, TEST_ID);
fs.rmSync(TEST_DIR, { recursive: true, force: true });
try {
  const before = tts.listVoices().length;
  const r = await forge.createFromAudio({
    name: TEST_ID,
    audioPath: 'style-samples/audio/p10.m4a',
    startSec: 280.382,
    durSec: 12.206,
  });
  check('造成功', r.ok === true, JSON.stringify(r.refText));
  check('参考文字是自动从转录截的', r.refFrom.startsWith('转录文件'), r.refFrom);
  // 转录是机器生成的，这里自动截到的就是那句错文字 —— 所以 refCheck 会给出 warn，
  // 提醒「逐字核一遍」（一个字错就足以让克隆发糊，相似度查不出来）。
  // 识别服务不在线时回读校验做不了，refCheck 会是 skipped —— 那也是合理结果，不算错。
  check('自动截的机器转录会被标成「有小出入」',
    ['warn', 'skipped'].includes(r.refCheck?.level), JSON.stringify(r.refCheck));
  check('参考文字带回给界面看', typeof r.refText === 'string' && r.refText.length > 10, r.refText);
  check('对齐后的窗口一起回报（前端要显示）', r.window?.startSec === 280.382 && r.window.durSec > 12.2, JSON.stringify(r.window));
  check('清单里多了一个', tts.listVoices().length === before + 1);
  const v = tts.listVoices().find((x) => x.id === TEST_ID);
  check('认成克隆音色', v?.kind === 'zipvoice', JSON.stringify(v?.kind));
  check('模型文件都到位', fs.existsSync(path.join(TEST_DIR, 'encoder.int8.onnx'))
    && fs.existsSync(path.join(TEST_DIR, 'decoder.int8.onnx'))
    && fs.existsSync(path.join(TEST_DIR, 'vocos_24khz.onnx'))
    && fs.existsSync(path.join(TEST_DIR, 'espeak-ng-data')));
  const wav = fs.statSync(path.join(TEST_DIR, 'ref.wav')).size;
  check('参考段按 24k 单声道切（每秒 48KB）', Math.abs(wav - 12.306 * 48000) < 12.306 * 48000 * 0.3, String(wav));
  check('README 记下了出处', fs.readFileSync(path.join(TEST_DIR, 'README.txt'), 'utf8').includes('280.382'));

  console.log('--- 造出来的音色真的能合成吗（本地，不花钱）---');
  if (!tts.findBinary()) {
    console.log('  （跳过：没找到合成程序）');
  } else if (!v) {
    check('能合成', false, '音色没造出来');
  } else {
    const s = await tts.synthesize('同学们好，这是造出来的音色。', { voiceId: TEST_ID });
    check('合成成功', s.ok === true, JSON.stringify(s));
    if (s.ok) {
      check('产出的是真 wav', fs.readFileSync(s.path).subarray(0, 4).toString('ascii') === 'RIFF' && s.seconds > 1, String(s.seconds));
      console.log(`    ${TEST_ID}：${s.seconds} 秒语音，耗时 ${s.ms}ms`);
      fs.rmSync(s.path, { force: true });
    }
  }

  console.log('--- 复制已有音色 ---');
  let dup = { ok: false };
  try {
    dup = await forge.createFromVoice({ name: `${TEST_ID}-copy`, fromVoice: tpl.id });
  } catch (e) {
    check('复制成功', false, String(e.message));
  }
  if (dup.ok) {
    check('复制出来的参考文字一样', dup.refText === fs.readFileSync(path.join(tpl.dir, 'ref.txt'), 'utf8').trim());
    check('复制出来也在清单里', tts.listVoices().some((x) => x.id === `${TEST_ID}-copy`));
  }

  console.log('--- 重名要挡住 ---');
  let dupErr = '';
  try {
    await forge.createFromAudio({ name: TEST_ID, audioPath: 'style-samples/audio/p10.m4a', startSec: 0, durSec: 10 });
  } catch (e) { dupErr = String(e.message); }
  check('同名不给造', dupErr.includes('已经有叫'), dupErr);
  let durErr = '';
  try {
    await forge.createFromAudio({ name: 'ztest-bad', audioPath: 'style-samples/audio/p10.m4a', startSec: 0, durSec: 90 });
  } catch (e) { durErr = String(e.message); }
  check('参考段过长被挡', durErr.includes('参考段长度'), durErr);
  check('被挡下时不留半成品', !fs.existsSync(path.join(tts.TTS_DIR, 'ztest-bad')));
} finally {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.rmSync(path.join(tts.TTS_DIR, `${TEST_ID}-copy`), { recursive: true, force: true });
  fs.rmSync(path.join(tts.TTS_DIR, 'ztest-bad'), { recursive: true, force: true });
}
check('测试目录清干净了', !fs.existsSync(TEST_DIR));

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
log.closeLogs();
