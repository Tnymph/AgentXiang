// 纯 JS 的 WAV 解析与重采样
//
// 为什么不用 ffmpeg：语音条由 NapCat 直接转成 wav 交给我们，
// 剩下的解析、降混、重采样都是纯数学，用 JS 做掉就不必在运行期调用任何外部程序。
// 这也让同一套代码以后能原样搬到手机上。

/** 读一个小端整数 */
function readInt(buf, off, size, signed = true) {
  if (size === 1) return signed ? buf.readInt8(off) : buf.readUInt8(off);
  if (size === 2) return signed ? buf.readInt16LE(off) : buf.readUInt16LE(off);
  return signed ? buf.readInt32LE(off) : buf.readUInt32LE(off);
}

/** 在 RIFF 里按块遍历找到指定 id */
function findChunk(buf, id, start = 12) {
  let off = start;
  while (off + 8 <= buf.length) {
    const cid = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const dataOff = off + 8;
    if (cid === id) return { offset: dataOff, size: Math.min(size, buf.length - dataOff) };
    off = dataOff + size + (size % 2);     // 块尺寸奇数时补一字节
  }
  return null;
}

/**
 * 只看文件头，拿采样率/声道/位深 —— 不解码样本。
 * 用来快速算一段 wav 的时长（音色之间有 8k / 22.05k / 24k 三种，不能按固定值硬算）。
 */
export function headerInfo(buf) {
  if (!buf || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return { sampleRate: 0, channels: 0, bitsPerSample: 0 };
  const fmt = findChunk(buf, 'fmt ');
  if (!fmt) return { sampleRate: 0, channels: 0, bitsPerSample: 0 };
  return {
    channels: readInt(buf, fmt.offset + 2, 2, false),
    sampleRate: readInt(buf, fmt.offset + 4, 4, false),
    bitsPerSample: readInt(buf, fmt.offset + 14, 2, false),
  };
}

/**
 * 由文件头 + 字节数算时长。
 * 必须看位深：CosyVoice 的输出是 32 位浮点（4 字节/样本），sherpa 的是 16 位，
 * 早先一律按 2 字节硬算，CosyVoice 的时长被算成了一倍长。
 */
export function durationSec(info, byteLength) {
  const bytes = (info?.bitsPerSample || 16) / 8;
  const channels = info?.channels || 1;
  const rate = info?.sampleRate || 0;
  if (!rate || !bytes || !channels || !Number.isFinite(byteLength)) return 0;
  return Number((byteLength / (rate * bytes * channels)).toFixed(2));
}

/** 解析 WAV，返回 { sampleRate, channels, bitsPerSample, format, durationSec, samples }
 * samples 是已降混成单声道的 Float32Array（取值 -1..1），采样率仍是文件原始采样率。
 */
export function parseWav(buf) {
  if (buf.length < 44) throw new Error('文件太小，不是有效 wav');
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 RIFF/WAVE 格式');
  }

  const fmt = findChunk(buf, 'fmt ');
  if (!fmt) throw new Error('缺少 fmt 块');
  const audioFormat = readInt(buf, fmt.offset, 2, false);
  const channels = readInt(buf, fmt.offset + 2, 2, false);
  const sampleRate = readInt(buf, fmt.offset + 4, 4, false);
  const bitsPerSample = readInt(buf, fmt.offset + 14, 2, false);

  if (!channels || !sampleRate) throw new Error('wav 头信息不完整');
  // 3 = IEEE float，1 = PCM，0xFFFE = 扩展格式（按位深推断）
  const isFloat = audioFormat === 3;

  const data = findChunk(buf, 'data');
  if (!data) throw new Error('缺少 data 块');

  const bytesPerSample = bitsPerSample / 8;
  const frameBytes = bytesPerSample * channels;
  const frames = Math.floor(data.size / frameBytes);
  const out = new Float32Array(frames);

  for (let i = 0; i < frames; i++) {
    let sum = 0;
    const base = data.offset + i * frameBytes;
    for (let c = 0; c < channels; c++) {
      const off = base + c * bytesPerSample;
      let v;
      if (isFloat && bitsPerSample === 32) v = buf.readFloatLE(off);
      else if (bitsPerSample === 16) v = buf.readInt16LE(off) / 32768;
      else if (bitsPerSample === 8) v = (buf.readUInt8(off) - 128) / 128;
      else if (bitsPerSample === 24) {
        const b0 = buf.readUInt8(off);
        const b1 = buf.readUInt8(off + 1);
        const b2 = buf.readInt8(off + 2);
        v = ((b2 << 16) | (b1 << 8) | b0) / 8388608;
      } else if (bitsPerSample === 32) v = buf.readInt32LE(off) / 2147483648;
      else v = 0;
      sum += v;
    }
    out[i] = sum / channels;               // 降混成单声道
  }

  return {
    sampleRate, channels, bitsPerSample, format: isFloat ? 'float' : 'pcm',
    durationSec: frames / sampleRate,
    samples: out,
  };
}

/** 线性插值重采样；语音识别场景足够，不需要更贵的滤波器 */
export function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = srcPos - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

/** 转成 sherpa 需要的 16kHz 单声道 float32 */
export function toAsrSamples(buf, targetRate = 16000) {
  const w = parseWav(buf);
  return { samples: resample(w.samples, w.sampleRate, targetRate), sampleRate: targetRate, durationSec: w.durationSec, channels: w.channels };
}

/** 音频里是否含有人声（按 30ms 窗口看是否有超过阈值的能量） */
export function hasSpeech(samples, sampleRate, { threshold = 0.008, minWindows = 3 } = {}) {
  const win = Math.max(1, Math.floor(sampleRate * 0.03));
  let loud = 0;
  for (let pos = 0; pos + win <= samples.length; pos += win) {
    let energy = 0;
    for (let i = pos; i < pos + win; i++) energy += samples[i] * samples[i];
    if (Math.sqrt(energy / win) >= threshold) {
      loud++;
      if (loud >= minWindows) return true;
    }
  }
  return false;
}

/**
 * 按静音把一个长音频切成若干段。
 * QQ 语音条通常很短，但长录音直接整段喂给模型会掉质量，所以留一个切分口子。
 * 纯 JS 实现：按 30ms 窗口算能量，能量低于阈值且持续够久就切一刀。
 */
export function splitOnSilence(samples, sampleRate, { maxSec = 25, minSilenceMs = 300, threshold = 0.012 } = {}) {
  const win = Math.max(1, Math.floor(sampleRate * 0.03));
  const maxLen = Math.floor(sampleRate * maxSec);
  const minSilWin = Math.max(1, Math.floor(minSilenceMs / 30));
  const segs = [];
  let start = 0;
  let silentRun = 0;
  let speechSeen = false;

  for (let pos = 0; pos + win <= samples.length; pos += win) {
    let energy = 0;
    for (let i = pos; i < pos + win; i++) energy += samples[i] * samples[i];
    energy = Math.sqrt(energy / win);

    if (energy < threshold) silentRun++;
    else { silentRun = 0; speechSeen = true; }

    // 切一刀之后必须重新见到人声，否则剩下的静音会连着再切一次
    const silenceCut = speechSeen && silentRun >= minSilWin && (pos + win - start) > sampleRate;
    const tooLong = pos + win - start >= maxLen;

    if (silenceCut || tooLong) {
      segs.push(samples.subarray(start, pos + win));
      start = pos + win;
      silentRun = 0;
      speechSeen = false;
    }
  }
  if (start < samples.length) segs.push(samples.subarray(start));
  return segs.length ? segs : [samples];
}

/** 把 float32 单声道打包成服务端要的格式：8 字节头 + float32 样本 */
export function packForServer(samples, sampleRate) {
  const header = Buffer.allocUnsafe(8);
  header.writeInt32LE(sampleRate, 0);
  header.writeInt32LE(samples.length * 4, 4);
  const body = Buffer.allocUnsafe(samples.length * 4);
  for (let i = 0; i < samples.length; i++) body.writeFloatLE(samples[i], i * 4);
  return Buffer.concat([header, body]);
}

/** 打包成 16bit 单声道 PCM 的 wav 字节（QQ 那边最终要的就是这个） */
export function encodeWav(samples, sampleRate = 16000) {
  const n = samples.length;
  const buf = Buffer.allocUnsafe(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);          // fmt 块长度
  buf.writeUInt16LE(1, 20);           // PCM
  buf.writeUInt16LE(1, 22);           // 单声道
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);   // 字节率
  buf.writeUInt16LE(2, 32);           // 块对齐
  buf.writeUInt16LE(16, 34);          // 位深
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

/**
 * 把几段 wav 拼成一段，中间补 gapMs 毫秒静音。
 *
 * 为什么需要它：vits 类音色的停顿是烧在模型时长预测里的，
 * `--tts-silence-scale` 对它们几乎不起作用（实测 0.2→6 只差 ±0.16 秒，还是噪声）。
 * 想让停顿变长，只能按标点切开、逐句合成、中间自己补静音。
 * 采样率不一致时按第一段的采样率重采样。
 */
export function joinWavs(buffers, { gapMs = 0 } = {}) {
  const parts = buffers.filter(Boolean).map((b) => parseWav(b));
  if (!parts.length) return null;
  if (parts.length === 1) return encodeWav(parts[0].samples, parts[0].sampleRate);

  const rate = parts[0].sampleRate;
  const aligned = parts.map((p) => (p.sampleRate === rate ? p.samples : resample(p.samples, p.sampleRate, rate)));
  const gap = Math.max(0, Math.round((Number(gapMs) || 0) / 1000 * rate));

  let total = 0;
  for (const s of aligned) total += s.length;
  total += gap * (aligned.length - 1);

  const out = new Float32Array(total);   // 默认全 0，正好当静音
  let off = 0;
  for (const [i, s] of aligned.entries()) {
    if (i > 0) off += gap;
    out.set(s, off);
    off += s.length;
  }
  return encodeWav(out, rate);
}
