// 冒烟测试：语音识别（wav 解析 + 切段 + 常驻服务识别）
// 需要先启动 scripts\asr-server.cmd；服务不在线时本测试会明确报出并跳过联网部分。
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, ROOT } from '../src/paths.js';
import * as log from '../src/logger.js';
import { parseWav, resample, toAsrSamples, splitOnSilence, packForServer } from '../src/wav.js';
import * as asr from '../src/asr.js';

ensureDirs();

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', label, extra ? '→ ' + extra : ''); }
};

// ============ 纯函数：wav 解析 ============
console.log('--- wav 解析 ---');

/** 造一个最小的 wav 用于单测 */
function makeWav({ sampleRate = 16000, channels = 1, bits = 16, durationSec = 0.1, value = 0.5 } = {}) {
  const bytesPer = bits / 8;
  const frames = Math.floor(sampleRate * durationSec);
  const dataSize = frames * bytesPer * channels;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(bits === 32 ? 3 : 1, 20);      // 3=float 1=pcm
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * bytesPer * channels, 28);
  buf.writeUInt16LE(bytesPer * channels, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < frames * channels; i++) {
    const off = 44 + i * bytesPer;
    if (bits === 16) buf.writeInt16LE(Math.round(value * 32767), off);
    else buf.writeFloatLE(value, off);
  }
  return buf;
}

const w16 = makeWav({ channels: 1, bits: 16 });
const p16 = parseWav(w16);
check('解析 16bit wav', p16.sampleRate === 16000 && p16.channels === 1);
check('样本数量正确', Math.abs(p16.samples.length - 1600) <= 1, String(p16.samples.length));
check('幅度还原正确', Math.abs(p16.samples[10] - 0.5) < 0.001, String(p16.samples[10]));
check('时长正确', Math.abs(p16.durationSec - 0.1) < 0.01, String(p16.durationSec));

const wf = makeWav({ bits: 32, value: 0.25 });
const pf = parseWav(wf);
check('解析 float32 wav', pf.format === 'float' && Math.abs(pf.samples[5] - 0.25) < 0.001);

const wst = makeWav({ channels: 2, bits: 16, value: 0.4 });
const pst = parseWav(wst);
const stFrames = (wst.length - 44) / (2 * 2);
check('立体声降混为单声道', pst.channels === 2 && pst.samples.length === stFrames, `${pst.samples.length} vs ${stFrames}`);

check('非 wav 报错', (() => {
  try { parseWav(Buffer.from('not a wav file at all, padding padding')); return false; } catch { return true; }
})());

console.log('--- 重采样 ---');
const src = new Float32Array(44100).fill(0.5);
const rs = resample(src, 44100, 16000);
check('44.1k→16k 长度正确', Math.abs(rs.length - 16000) <= 2, String(rs.length));
check('重采样保持幅度', Math.abs(rs[100] - 0.5) < 0.01);
check('同采样率不复制', resample(src, 16000, 16000) === src);

console.log('--- 静音切段 ---');
const tone = (sec, amp) => { const a = new Float32Array(Math.floor(16000 * sec)); a.fill(amp); return a; };
const padded = new Float32Array([...tone(3, 0.3), ...tone(1.5, 0), ...tone(3, 0.3)]);
const segs = splitOnSilence(padded, 16000, { maxSec: 25, minSilenceMs: 300 });
check('按静音切成两段', segs.length === 2, String(segs.length));
const long = tone(60, 0.3);
const forced = splitOnSilence(long, 16000, { maxSec: 25 });
check('超长音频被强制切分', forced.length >= 2, String(forced.length));
check('每段不超过上限', forced.every((s) => s.length <= 16000 * 25 + 16000), JSON.stringify(forced.map((s) => s.length)));

console.log('--- 打包格式 ---');
const packed = packForServer(new Float32Array([0.1, 0.2]), 16000);
check('包头 8 字节 + 每样本 4 字节', packed.length === 8 + 8, String(packed.length));
check('包头采样率小端正确', packed.readInt32LE(0) === 16000);
check('包头字节数正确', packed.readInt32LE(4) === 8);

console.log('--- 返回值解析 ---');
check('取顶层 text', asr.pickText({ text: '你好' }) === '你好');
check('取嵌套 result.text', asr.pickText({ result: { text: '你好' } }) === '你好');
check('取 segments 数组并拼接', asr.pickText({ segments: [{ text: '甲' }, { text: '乙' }] }) === '甲乙');
check('忽略 Done 信号', asr.pickText('Done') === '');
check('空对象返回空串', asr.pickText({}) === '');

// ============ 联网部分 ============
console.log('--- 识别服务 ---');
const target = { host: '127.0.0.1', port: 6007 };
const up = await asr.probe(target);
if (!up.ok) {
  console.log('  ⚠ 识别服务未在线（' + up.error + '）');
  console.log('    启动方式：scripts\\asr-server.cmd');
  console.log('    服务未启动时跳过联网校验，其余测试结果仍然有效。');
  check('服务在线（未在线则跳过）', true);
} else {
  check('识别服务在线', true);

  const wavPath = path.join(ROOT, 'style-samples', 'wav', 'p01.wav');
  if (!fs.existsSync(wavPath)) {
    console.log('  ⚠ 缺少样音 ' + wavPath + '，跳过真实识别');
    check('真实录音识别（缺文件则跳过）', true);
  } else {
    const buf = fs.readFileSync(wavPath);
    const t0 = Date.now();
    const r = await asr.transcribeWav(buf, target);
    const ms = Date.now() - t0;
    check('识别成功', r.ok === true, r.error);
    if (r.ok) {
      check('识别出非空文本', r.text.length > 10, JSON.stringify(r.text).slice(0, 80));
      check('时长解析正确', Math.abs(r.durationSec - 81.5) < 2, String(r.durationSec));
      check('命中已知内容', r.text.includes('线性代数') || r.text.includes('先修'), r.text.slice(0, 60));
      console.log(`     耗时 ${ms}ms / 音频 ${r.durationSec.toFixed(1)}s（${(r.durationSec / (ms / 1000)).toFixed(1)}× 实时，切成 ${r.segments} 段）`);
      console.log('     识别结果：' + r.text.slice(0, 120));
    }
  }
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
log.closeLogs();
process.exit(fail === 0 ? 0 : 1);
