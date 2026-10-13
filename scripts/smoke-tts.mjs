// 冒烟测试：语音合成模块（切句、参数拼装、音色清单）
// 最后会真的合成一句（本地、不花钱）；程序或模型缺失就跳过，不让整轮测试失败。
import fs from 'node:fs';
import * as tts from '../src/modules/tts.js';
import * as wav from '../src/wav.js';
import * as asr from '../src/asr.js';
import * as log from '../src/logger.js';

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', label, extra ?? ''); }
};

console.log('--- splitForSpeech（按句切，别让一条语音太长）---');
check('短的整句返回一条', tts.splitForSpeech('你好呀').length === 1);
check('空文本返回空', tts.splitForSpeech('').length === 0 && tts.splitForSpeech(null).length === 0);
const long = '第一句话在这里。第二句话稍微长一点点。第三句话也不短呀。第四句话又来了呢。';
const cut = tts.splitForSpeech(long, 12);
check('超长会被切开', cut.length > 1, JSON.stringify(cut));
check('每一块都不超上限', cut.every((s) => s.length <= 12), JSON.stringify(cut.map((s) => s.length)));
check('切完不丢字', cut.join('').replace(/\s/g, '') === long.replace(/\s/g, ''));
const hardCut = tts.splitForSpeech('啊'.repeat(120), 50);
check('单句超长硬切也不超限', hardCut.every((s) => s.length <= 50) && hardCut.join('').length === 120);
check('换行也算边界', tts.splitForSpeech('上面一句\n下面一句', 5).length > 1);
// 真实事故：一句话超过上限时被「每 N 个字切一刀」，从词中间劈开
// （「…翻开全是行列式。」→「…翻开全是」+「行列式。」，用户听成"话说一半断了"）
const longOne = '大家看这个，跟课程简介一个道理，写得高大上，翻开全是行列式。';
const chopped = tts.splitForSpeech(longOne, 26);
check('先按逗号切，不从词中间劈', chopped.every((s) => /[，。]$/.test(s)), JSON.stringify(chopped));
check('切开后不丢字', chopped.join('').replace(/\s/g, '') === longOne.replace(/\s/g, ''), chopped.join(''));
check('每块不会长太多（最多上浮到两倍上限）', chopped.every((s) => s.length <= 52), JSON.stringify(chopped.map((s) => s.length)));
const noPunct = '这是一句完全没有标点而且长得离谱的话它就得分块但也没办法只能硬切了';
const hard = tts.splitForSpeech(noPunct, 10);
check('没有任何标点时只能硬切', hard.every((s) => s.length <= 10) && hard.join('') === noPunct, JSON.stringify(hard));

console.log('--- splitClauses（按标点切小句，用来自己补停顿；绝不能丢字）---');
check('一句话就是一块', tts.splitClauses('你好呀').length === 1);
check('空文本返回空', tts.splitClauses('').length === 0 && tts.splitClauses(null).length === 0);
const cl = tts.splitClauses('在呢，说啥啊，我快困死了。别急，我这就看看。');
check('按逗号句号切开', cl.length >= 3, JSON.stringify(cl));
check('切完不丢字', cl.join('') === '在呢，说啥啊，我快困死了。别急，我这就看看。', cl.join(''));
check('单独一个标点并到前一句', tts.splitClauses('你好。，世界').length === 2, JSON.stringify(tts.splitClauses('你好。，世界')));
check('单字短句照切（不能一路合并）', tts.splitClauses('一，二，三').length === 3, JSON.stringify(tts.splitClauses('一，二，三')));
const many = tts.splitClauses('一，二，三，四，五，六，七，八', { maxClauses: 3 });
check('超上限时合并尾部而不是丢掉', many.length === 3, JSON.stringify(many));
check('合并后仍然一个字都不少', many.join('') === '一，二，三，四，五，六，七，八', many.join(''));

console.log('--- joinWavs（拼接 + 补静音）---');
const one = await tts.synthesize('第一句。', { voiceId: 'vits-zh-hf-theresa' });
const two = await tts.synthesize('第二句。', { voiceId: 'vits-zh-hf-theresa' });
if (!one.ok || !two.ok) {
  console.log('  （跳过：合不出来）', one.error ?? '', two.error ?? '');
} else {
  const b1 = fs.readFileSync(one.path);
  const b2 = fs.readFileSync(two.path);
  const n0 = wav.joinWavs([b1, b2], { gapMs: 0 });
  const n300 = wav.joinWavs([b1, b2], { gapMs: 300 });
  const d0 = wav.parseWav(n0);
  const d300 = wav.parseWav(n300);
  check('拼出来是合法 wav', d0.format === 'pcm' && d0.sampleRate === wav.parseWav(b1).sampleRate);
  check('两段时长相加', Math.abs(d0.durationSec - (wav.parseWav(b1).durationSec + wav.parseWav(b2).durationSec)) < 0.01,
    `${d0.durationSec} vs ${wav.parseWav(b1).durationSec}+${wav.parseWav(b2).durationSec}`);
  check('补 300 毫秒就长 0.3 秒', Math.abs((d300.durationSec - d0.durationSec) - 0.3) < 0.02, String(d300.durationSec - d0.durationSec));
  check('单段直接透传', wav.parseWav(wav.joinWavs([b1], { gapMs: 500 })).durationSec === wav.parseWav(b1).durationSec);
  check('空数组返回 null', wav.joinWavs([]) === null);
  fs.rmSync(one.path, { force: true });
  fs.rmSync(two.path, { force: true });
}

console.log('--- 真的补停顿（实测：vits 的停顿参数没用，只能自己切+补）---');
if (!tts.findBinary()) {
  console.log('  （跳过：没找到合成程序）');
} else {
  const LINE = '在呢，说啥啊，我快困死了。';
  const plain = await tts.synthesize(LINE, { voiceId: 'vits-zh-hf-theresa', pauseMs: 0 });
  const gapped = await tts.synthesize(LINE, { voiceId: 'vits-zh-hf-theresa', pauseMs: 400 });
  check('不补停顿能合成', plain.ok === true, JSON.stringify(plain));
  check('补停顿也能合成', gapped.ok === true, JSON.stringify(gapped));
  if (plain.ok && gapped.ok) {
    // 时长按文件头里的采样率算（各音色 8k/22.05k/24k 不同，不能按固定字节率硬算）
    const secOf = (f) => wav.parseWav(fs.readFileSync(f)).durationSec;
    const a = secOf(plain.path);
    const b = secOf(gapped.path);
    // 这句切出 3 块 → 2 个间隔 × 400ms。下界放宽是因为 vits 的时长预测带随机性：
    // 同一句话两次合成能差近 1 秒（实测），卡太死会误报
    check('补停顿后更长（2 个间隔 ≥0.8 秒的理论值，允许模型自身抖动）', b - a > 0.4 && b - a < 1.8, `${a.toFixed(2)}→${b.toFixed(2)} 秒`);
    console.log(`    ${LINE}  不补 ${a.toFixed(2)} 秒 / 补 400ms ${b.toFixed(2)} 秒`);
    check('返回里带上了停顿值', gapped.pauseMs === 400);
    check('返回里带上了真实采样率', gapped.sampleRate === 22050, String(gapped.sampleRate));
    fs.rmSync(plain.path, { force: true });
    fs.rmSync(gapped.path, { force: true });
  }
}

console.log('--- buildArgs（两个模型的参数不一样，这里最容易踩坑）---');
const fakeAishell = { model: 'M', lexicon: 'L', tokens: 'T', dictDir: 'DIR', multiSpeaker: true };
const a1 = tts.buildArgs(fakeAishell, '你好', 'out.wav', { sid: 3 });
check('模型/输出/文本都在', a1.includes('--vits-model=M') && a1.includes('--output-filename=out.wav') && a1[a1.length - 1] === '你好');
check('多说话人带 sid', a1.includes('--sid=3'));
check('词典目录带上', a1.includes('--vits-dict-dir=DIR'));
const single = tts.buildArgs({ model: 'M', lexicon: null, tokens: null, dictDir: null, multiSpeaker: false }, '嗨', 'o.wav');
check('单说话人不带 sid', !single.some((x) => x.startsWith('--sid=')));
check('没有词典就不带那个参数', !single.some((x) => x.startsWith('--vits-dict-dir=')));
// 语速：用户嫌快就调小；给了就覆盖档位里的默认值（不能出现两个 --speed）
const zp = tts.listVoices().find((v) => v.kind === 'zipvoice');
if (zp) {
  const d1 = tts.buildArgs(zp, '你好', 'o.wav');
  check('克隆音色默认语速 0.82', d1.includes('--speed=0.82'), d1.filter((a) => a.startsWith('--speed')).join());
  const d2 = tts.buildArgs(zp, '你好', 'o.wav', { speed: 0.72 });
  check('语速可覆盖', d2.includes('--speed=0.72') && !d2.includes('--speed=0.82'), d2.filter((a) => a.startsWith('--speed')).join());
  check('只出现一个 --speed', d2.filter((a) => a.startsWith('--speed=')).length === 1);
  check('覆盖语速不影响停顿设置', d2.includes('--tts-silence-scale=1.7'), d2.filter((a) => a.startsWith('--tts-')).join());
  const d3 = tts.buildArgs(zp, '你好', 'o.wav', { quality: 'high', speed: 0.65 });
  check('高质量档也能覆盖语速', d3.includes('--speed=0.65') && d3.includes('--num-steps=16'), d3.filter((a) => /speed|steps/.test(a)).join(' '));
}
check('vits 也支持语速', tts.buildArgs({ model: 'M', lexicon: null, tokens: null, dictDir: null, multiSpeaker: false }, '嗨', 'o.wav', { speed: 0.9 }).includes('--speed=0.9'));
check('语速 0 = 不动（vits 不加参数）', !tts.buildArgs({ model: 'M', lexicon: null, tokens: null, dictDir: null, multiSpeaker: false }, '嗨', 'o.wav', { speed: 0 }).some((x) => x.startsWith('--speed')));

console.log('--- listVoices（权重文件名不固定，按大小挑）---');
const voices = tts.listVoices();
check('至少认出一个音色', voices.length >= 1, String(voices.length));
for (const v of voices) {
  console.log(`    ${v.id}  ${v.sizeMB}MB  多说话人=${v.multiSpeaker}  词典=${v.dictDir ? (v.dictDir.endsWith('dict') ? 'dict/' : '目录本身') : '无'}`);
}
check('每个音色都指得到实际文件', voices.every((v) => (v.kind === 'zipvoice'
  ? fs.existsSync(v.refAudio) && !!v.refText
  : (typeof v.model === 'string' && v.model.endsWith('.onnx') && fs.existsSync(v.model)))));
check('两种类型的权重名都能认出来', voices.every((v) => (v.kind === 'zipvoice'
  ? !!v.refText
  : String(v.model ?? '').includes('.onnx'))));

console.log('--- findSpeechStart（掐开头伪影的判定：宁可留着，也不能掐掉正话）---');
const HEARD = '为 R十一 杀虫服AY 好要意思同学们好今天我们来看二次曲线的标准方程';   // 真实识别结果（带空格、字母）
const TIMES = HEARD.replace(/\s/g, '').split('').map((_, i) => Number((i * 0.12).toFixed(2)));   // 空格不占时间戳
const WANT = '同学们好今天我们来看二次曲线的标准方程';
check('干净的情况不掐（从第一个字就对得上）',
  tts.findSpeechStart(WANT, WANT.split('').map((_, i) => i * 0.2), WANT).cutSec === 0);
const hitTrim = tts.findSpeechStart(HEARD, TIMES, WANT);
check('开头有伪影时掐到正题开始', hitTrim.cutSec > 1.0 && hitTrim.cutSec < 2.1, JSON.stringify(hitTrim));
// 实测识别会把开头听成「同下」，甚至整段读得七零八落（'艾O阿森纳里 S 在那遇想我干嘛'）。
// 阈值放宽到 0.35 之后这类也能定位 —— 因为**掐完有自检兜底**（内容掉太多自动还原），
// 宁可多切几次再还原，也别让怪声留着。
const HEARD2 = '数 E A 三宽 F S M 料意四同下我们来看二次曲线的标准方程';
const TIMES2 = HEARD2.replace(/\s/g, '').split('').map((_, i) => Number((i * 0.12).toFixed(2)));
check('识别错得狠也照样定位（自检兜底）', tts.findSpeechStart(HEARD2, TIMES2, WANT).cutSec > 0.8, JSON.stringify(tts.findSpeechStart(HEARD2, TIMES2, WANT)));
// 线上真实短句：识别读成「艾O阿森纳里 S 在那遇想我干嘛」，正题在尾巴上
const HEARD3 = '艾O阿森纳里 S 在那遇想我干嘛';
const TIMES3 = HEARD3.replace(/\s/g, '').split('').map((_, i) => Number((i * 0.18).toFixed(2)));
const hit3 = tts.findSpeechStart(HEARD3, TIMES3, '在呢，又想我干嘛');
check('短句也能定位（阈值别卡太死）', hit3.cutSec > 0.8 && hit3.cutSec < 2.5, JSON.stringify(hit3));
check('识别全是乱的时候不动手', tts.findSpeechStart('abc def', [0, 0.3, 0.6, 1], WANT).cutSec === 0);
check('时间戳比字少也不动手（超出的字没有时间）', tts.findSpeechStart(HEARD, [0, 1], WANT).cutSec === 0);
check('空输入不炸', tts.findSpeechStart('', [], '').cutSec === 0 && tts.findSpeechStart(null, null, null).cutSec === 0);
check('匹配太短不认（免得把巧合当成正题）', tts.findSpeechStart('啊同好', [0, 1, 2], WANT).cutSec === 0);
check('干净音频绝不会被切（起点 0 必须参与比较）',
  tts.findSpeechStart('同学们好今天我们来看二次曲线的标准方程', WANT.split('').map((_, i) => i * 0.2), WANT).cutSec === 0);

console.log('--- 真的掐一次开头伪影（ZipVoice 的老毛病，实测复现）---');
if (!tts.findBinary() || !voices.some((v) => v.kind === 'zipvoice')) {
  console.log('  （跳过：没有克隆音色或缺合成程序）');
} else {
  const clone = voices.find((v) => v.kind === 'zipvoice');
  const LINE2 = '同学们好，今天我们来看二次曲线的标准方程。';
  const s = await tts.synthesize(LINE2, { voiceId: clone.id });
  check('克隆音色能合成', s.ok === true, JSON.stringify(s));
  if (s.ok) {
    const before = wav.parseWav(fs.readFileSync(s.path)).durationSec;
    const t = await tts.trimOnset(s.path, LINE2, { extraMs: 250, fallbackMs: 400 });
    const after = wav.parseWav(fs.readFileSync(s.path)).durationSec;
    console.log(`   ${clone.id}: ${before.toFixed(2)} → ${after.toFixed(2)} 秒（${t.trimmed ? `掐 ${t.cutSec}（${t.how}）` : (t.reverted ? '掐了又还原' : '没动')}）`);
    console.log(`   定位 ${t.detected ?? '-'} 秒 / 覆盖 ${t.coverage ?? '-'} / 回读开头: ${String(t.heard ?? '').slice(0, 24)}`);
    check('返回值带定位与覆盖信息（排查用）', t.trimmed ? (typeof t.coverage === 'number' && !!t.how) : true);
    check('还原时一定没改文件', t.reverted ? Math.abs(after - before) < 0.01 : true, `${before}→${after}`);
    if (t.trimmed) {
      check('掐完更短', after < before - 0.2, `${before}→${after}`);
      check('掐完还剩下大半（没把正话掐没）', after > before * 0.4, `${before}→${after}`);
      const again = await asr.transcribeWav(fs.readFileSync(s.path), { host: '127.0.0.1', port: 6007, timeoutMs: 60000 });
      if (!again.ok) {
        // 识别服务不在线时回读不了，覆盖没法算 —— 跳过而不是判红（同其它套件的做法）
        console.log('  ⚠ 识别服务不在线，跳过「掐完内容覆盖」检查');
        check('掐完内容覆盖（识别服务不在线则跳过）', true);
      } else {
        // 内容覆盖：原句里有几个字能在回读里找到。不能用「一个字都不许少」——
        // 识别自己就会把「同学」听成「同意」，那是识别的错，不是掐丢了内容（实测踩过）
        const got = (again.ok ? again.text : '').replace(/[^一-龥A-Za-z0-9]/g, '');
        const wantChars = [...new Set(LINE2.replace(/[^一-龥A-Za-z0-9]/g, ''))];
        const cover = wantChars.filter((c) => got.includes(c)).length / wantChars.length;
        check('掐完内容覆盖 ≥70%', cover >= 0.7, `覆盖 ${(cover * 100).toFixed(0)}% / 回读 ${again.text}`);
        console.log(`   掐完再回读: ${again.text}（覆盖 ${(cover * 100).toFixed(0)}%）`);
      }
    } else {
      console.log(`  （这次没测出伪影：${t.why ?? '识别回读与正题从第一个字就对得上'}）`);
      check('没伪影时不动文件', Math.abs(after - before) < 0.01);
    }
    fs.rmSync(s.path, { force: true });
  }
}

console.log('--- coverage（掐完自检用：想说的字还剩几个，按**唯一字**算）---');
check('完全对得上 = 100%', tts.coverage('同学们好', '同学们好') === 1);
check('识别错一个字就掉一点', tts.coverage('同学们好今天', '同学门好今天') === Number((5 / 6).toFixed(3)), String(tts.coverage('同学们好今天', '同学门好今天')));
check('丢一个字就掉', tts.coverage('同学们好', '同学们') === 0.75, String(tts.coverage('同学们好', '同学们')));
check('重复的字只算一次', tts.coverage('好好好', '好') === 1);
check('全丢 = 0', tts.coverage('同学们好', '无关内容') === 0);
check('空输入不炸', tts.coverage('', '') === 1 && tts.coverage(null, null) === 1);
check('标点不算字', tts.coverage('你好，世界', '你好世界') === 1);

console.log('--- 真的合成一句（本地，不花钱）---');
const bin = tts.findBinary();
if (!bin) {
  console.log('  （跳过：没找到合成程序）');
} else if (!voices.length) {
  console.log('  （跳过：没有音色模型）');
} else {
  const r = await tts.synthesize('同学们好，这是语音测试。', { voiceId: voices[0].id });
  check('合成成功', r.ok === true, JSON.stringify(r));
  if (r.ok) {
    check('产出的是真文件', fs.existsSync(r.path) && r.size > 5000, String(r.size));
    check('耗时在合理范围', r.ms > 0 && r.ms < 60000, String(r.ms));
    console.log(`    ${r.voice}：${r.size} 字节 ≈ ${r.seconds} 秒，耗时 ${r.ms}ms`);
    check('是 wav（RIFF 头）', fs.readFileSync(r.path).subarray(0, 4).toString('ascii') === 'RIFF');
    fs.rmSync(r.path, { force: true });
  }
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
log.closeLogs();
