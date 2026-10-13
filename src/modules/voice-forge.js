// 造音色：给一段参考录音 + 与它严格对应的文字，生成一个自包含的
// .tools/tts/<名字>/ 目录。目录生成即生效，不需要往库里写任何东西。
//
// 三步（顺序不能换）：
//   1. 复制模板音色的模型文件（encoder / decoder / 声码器 / 词典 / tokens / espeak-ng-data）
//   2. ffmpeg 把参考段切成 16k 单声道 wav
//   3. 写 ref.txt —— 这一步最容易做错：**必须**用带时间戳的人工转录，
//      不能用识别结果（实测识别文字会让合成吐字发糊）
//
// tts.js 只管「给文字拿回 wav」，这里管「造一个音色出来」，两边不互相依赖。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ROOT, TRANSCRIPT_DIR, TOOLS_DIR } from '../paths.js';
import * as log from '../logger.js';
import * as tts from './tts.js';
import * as asr from '../asr.js';
import { findFfmpeg } from './media-learn.js';

/** 参考录音的格式白名单：只放行音频/视频容器，免得把个 txt 喂给 ffmpeg */
export const AUDIO_EXT = ['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma', '.mp4', '.mkv', '.mov', '.webm'];
const MAX_SRC_BYTES = 300 * 1024 * 1024;
export const MIN_REF_SEC = 3;
export const MAX_REF_SEC = 60;
export const DEFAULT_REF_SEC = 14;
/** 参考段采样率：ZipVoice 的声码器是 24 kHz，参考段别先压到 16 k（实测用户听出差别） */
export const REF_RATE = 24000;

// ---------- 纯函数（便于单测） ----------

/**
 * 音色名 = 目录名，必须是纯 ASCII。
 * 中文目录名会让子进程收不到正确路径（实测：合成静默不吐文件），
 * 而且它还会出现在 --reference-text 之外的各处命令行里。
 */
export function safeVoiceName(name) {
  const s = String(name ?? '').trim();
  if (!/^[A-Za-z0-9_-]{2,32}$/.test(s)) {
    return { ok: false, error: '音色名只能用小写字母、数字、下划线、短横线（2~32 位），因为它是目录名，中文会让合成静默失败' };
  }
  if (s.startsWith('-') || s.startsWith('_')) {
    return { ok: false, error: '音色名不要以下划线或短横线开头' };
  }
  return { ok: true, name: s };
}

/** 解析转录 tsv：start \t end \t text，首行是表头。返回 [{start,end,text}] */
export function parseTsv(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const c = line.split('\t');
    if (c.length < 3) continue;
    const start = Number(c[0]);
    const end = Number(c[1]);
    const body = c.slice(2).join('\t').trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || !body) continue;
    out.push({ start, end, text: body });
  }
  return out;
}

/**
 * 把大致窗口对齐到转录的**整行**。用户只报个大概起点（"p10 从 280 秒开始"），
 * 对齐后切出来的音频和参考文字永远一一对应 —— 差半个字都会让合成吐字发糊，
 * 所以这里不让调用方自己拍毫秒。
 * 返回 { start, dur, text, rows }
 */
export function alignWindow(rows, startSec, durSec) {
  const from = Number(startSec) || 0;
  const to = from + (Number(durSec) || 0);
  const picked = [];
  for (const r of rows) {
    if (!picked.length) {
      if (r.end <= from) continue;      // 起点落在这行中间也从这行开头算起
    } else if (r.start >= to) {
      break;
    }
    picked.push(r);
  }
  if (!picked.length) return { start: from, dur: Number(durSec) || 0, text: '', rows: 0 };
  const start = picked[0].start;
  const end = picked[picked.length - 1].end;
  return {
    start,
    dur: Number((end - start + 0.1).toFixed(3)),   // 尾巴留 0.1 秒，别把最后一个字的韵尾切掉
    text: picked.map((r) => r.text).join(''),
    rows: picked.length,
    asked: { start: from, dur: Number(durSec) || 0 },
  };
}

const stem = (p) => path.basename(String(p ?? '')).replace(/\.[^.]+$/, '');

/**
 * 从同名 .tsv 里取参考文字。音频叫 style-samples/audio/p10.m4a 就找 transcript/p10.tsv。
 * 找不到就返回空串，由上层决定是报错还是让用户手填。
 */
export function readTranscriptText(audioPath, startSec, durSec, dir = TRANSCRIPT_DIR) {
  const tsv = path.join(dir, `${stem(audioPath)}.tsv`);
  if (!fs.existsSync(tsv)) return { text: '', file: tsv, found: false };
  const w = alignWindow(parseTsv(fs.readFileSync(tsv, 'utf8')), startSec, durSec);
  return { text: w.text, file: tsv, found: true, start: w.start, dur: w.dur, rows: w.rows, asked: w.asked };
}

/**
 * ffmpeg 参数：切窗口 + 转单声道 16bit。
 * 采样率按模型走：ZipVoice 的声码器是 24 kHz，参考段也给 24 kHz（别压到 16 k 再让它自己补）。
 */
export function buildCutArgs(src, dest, startSec, durSec, sampleRate = REF_RATE) {
  return [
    '-y',
    // -ss 放在 -i 前面：关键帧快速定位，切 4 小时的讲稿不用先解码一遍
    '-ss', String(Number(startSec) || 0),
    '-i', src,
    '-t', String(Number(durSec) || 0),
    '-vn',                    // 视频轨丢掉（mp4 也能直接当素材）
    '-ac', '1',
    '-ar', String(sampleRate),
    '-c:a', 'pcm_s16le',
    dest,
  ];
}

/**
 * 解析参考录音路径。相对路径按项目根算。
 * 返回 { ok, path } 或 { ok:false, error }
 */
export function resolveAudio(input, root = ROOT) {
  const raw = String(input ?? '').trim().replace(/^"(.*)"$/, '$1');
  if (!raw) return { ok: false, error: '没填参考音频' };
  const p = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw);
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return { ok: false, error: `参考音频不存在：${p}` };
  }
  if (!st.isFile()) return { ok: false, error: `这不是一个文件：${p}` };
  if (st.size === 0) return { ok: false, error: '这个文件是空的' };
  if (st.size > MAX_SRC_BYTES) return { ok: false, error: `这个文件太大（${(st.size / 1048576).toFixed(0)}MB）` };
  const ext = path.extname(p).toLowerCase();
  if (!AUDIO_EXT.includes(ext)) {
    return { ok: false, error: `不认识的音频格式 ${ext || '(没有扩展名)'}，支持 ${AUDIO_EXT.join(' ')}` };
  }
  return { ok: true, path: p, size: st.size };
}

/** 挑模板：优先张小向那份，其次任意一个完整克隆音色 */
export function findTemplate(voices = tts.listVoices()) {
  const zip = voices.filter((v) => v.kind === 'zipvoice');
  return zip.find((v) => v.id === 'zhangxiaoxiang') ?? zip[0] ?? null;
}

/** 模型文件 = 模板目录里除参考录音/文字/说明以外的全部东西（ref.* 包括 ref.txt.bak 都不算） */
export function isModelFile(name) {
  return !/^ref/i.test(name) && !/^README/i.test(name);
}

// ---------- 落盘 ----------

/** 大文件优先硬链接：同盘瞬间完成、也不多占 176MB；跨盘时退回真复制 */
function linkOrCopy(src, dest) {
  try {
    fs.linkSync(src, dest);
    return 'link';
  } catch {
    fs.copyFileSync(src, dest);
    return 'copy';
  }
}

/** 用来比对两段文字像不像：去掉标点空格后，公共子串长度 / 参考长度 */
export function textSimilarity(a, b) {
  const clean = (s) => String(s ?? '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const x = clean(a);
  const y = clean(b);
  if (!x.length || !y.length) return 0;
  let best = 0;
  for (let i = 0; i < x.length; i++) {
    for (let j = 0; j < y.length; j++) {
      let k = 0;
      while (i + k < x.length && j + k < y.length && x[i + k] === y[j + k]) k++;
      if (k > best) best = k;
    }
  }
  return Number((best / x.length).toFixed(3));
}

/**
 * 核对参考文字与参考录音是否对得上 —— 对不上，克隆出来就是糊的（实测多次）。
 * 用本地识别服务回读一遍，与参考文字比相似度。
 *
 * **这套检查只能挡住「完全对不上」**（切错窗口、拿错文件）：实测一句 36 字里错了 3 个字
 * （「双曲线」写成「专曲线」），相似度仍有 0.833 —— 一个字错就足以让克隆发糊，但整串
 * 相似度看不出来。所以它是粗筛，不能替代人工核对。
 * 返回 { level: 'ok' | 'warn' | 'bad' | 'skipped' }
 */
export async function verifyRefText(refText, wavPath, settings = null) {
  const target = asr.describeTarget(settings);
  let got = null;
  try {
    got = await asr.transcribeWav(fs.readFileSync(wavPath), { ...target, timeoutMs: 60000 });
  } catch (e) {
    return { level: 'skipped', ok: true, skipped: true, why: '识别服务不可用：' + String(e.message).slice(0, 80) };
  }
  if (!got?.ok) return { level: 'skipped', ok: true, skipped: true, why: got?.error ?? '识别没结果' };
  const sim = textSimilarity(refText, got.text);
  const level = sim < 0.6 ? 'bad' : (sim < 0.9 ? 'warn' : 'ok');
  log.info('tts', 'reference text check', { sim, level, heard: got.text.slice(0, 60), text: String(refText).slice(0, 60) });
  return {
    level, ok: level !== 'bad', similarity: sim, heard: got.text,
    why: level === 'bad' ? `参考文字与录音对不上（相似度 ${sim}）`
      : (level === 'warn' ? `参考文字与识别回读有小出入（相似度 ${sim}）—— 逐字核一遍，错一个字就会糊` : '对得上'),
  };
}

export function copyModelFiles(tplDir, destDir) {
  const how = {};
  for (const e of fs.readdirSync(tplDir, { withFileTypes: true })) {
    if (!isModelFile(e.name)) continue;
    const s = path.join(tplDir, e.name);
    const d = path.join(destDir, e.name);
    if (e.isDirectory()) {
      fs.cpSync(s, d, { recursive: true });
      how[e.name] = 'copy';
    } else {
      how[e.name] = linkOrCopy(s, d);
    }
  }
  return how;
}

function cutAudio(ffmpeg, src, dest, startSec, durSec, timeoutMs = 120000) {
  return new Promise((resolve) => {
    execFile(ffmpeg, buildCutArgs(src, dest, startSec, durSec), { windowsHide: true, timeout: timeoutMs, maxBuffer: 1 << 22 },
      (err, stdout, stderr) => resolve({ err, stderr: String(stderr ?? '') }));
  });
}

function readmeText({ name, src, startSec, durSec, refText, refFrom, tplId }) {
  return [
    `${name} 的音色（零样本克隆，ZipVoice）`,
    `参考段：${src} 第 ${startSec}~${(Number(startSec) + Number(durSec)).toFixed(3)} 秒（共 ${durSec} 秒）`,
    `参考文字（${refFrom}）：${refText}`,
    '参考文字必须与参考录音严格对应 —— 改 ref.wav 就要同时改 ref.txt，对不上会吐字发糊。',
    `模型文件来自 ${tplId}；默认参数 --speed=0.82 --tts-silence-scale=1.7；高质量档再加 --num-steps=16。`,
    `建目录时用的参考文字来源：${refFrom}。想换参考段就重造一个音色，别手改 ref.wav。`,
    '',
  ].join('\n');
}

/**
 * 用一段参考录音造音色。
 * { name, audioPath, startSec, durSec, text }
 * text 留空时自动从 style-samples/transcript/<同名>.tsv 里按时间窗截。
 */
export async function createFromAudio({ name, audioPath, startSec = 0, durSec = DEFAULT_REF_SEC, text = '', root = ROOT }) {
  const nm = safeVoiceName(name);
  if (!nm.ok) throw new Error(nm.error);
  const dest = path.join(tts.TTS_DIR, nm.name);
  if (fs.existsSync(dest)) throw new Error(`已经有叫 ${nm.name} 的音色了，换个名字`);

  const src = resolveAudio(audioPath, root);
  if (!src.ok) throw new Error(src.error);

  const sec = Number(startSec) || 0;
  const dur = Number(durSec) || DEFAULT_REF_SEC;
  if (sec < 0) throw new Error('起始秒不能是负数');
  if (dur < MIN_REF_SEC || dur > MAX_REF_SEC) throw new Error(`参考段长度要在 ${MIN_REF_SEC}~${MAX_REF_SEC} 秒之间`);

  const tpl = findTemplate();
  if (!tpl) throw new Error('找不到模板：.tools/tts 下至少要有一个完整的克隆音色（zhangxiaoxiang 那份）');

  let refText = String(text ?? '').trim();
  let refFrom = '手动填写';
  let cutStart = sec;
  let cutDur = dur;
  if (!refText) {
    const t = readTranscriptText(src.path, sec, dur);
    if (t.text) {
      refText = t.text;
      cutStart = t.start;
      cutDur = t.dur;
      // 文字是从转录里截的，窗口也一起对齐到整行 —— 两边不能各切各的
      refFrom = `转录文件 ${path.basename(t.file)}（${t.rows} 行，对齐到 ${t.start} 秒起）`;
    }
  }
  if (!refText) {
    throw new Error('参考文字是空的：手填一句与录音**逐字对应**的话，或把参考音频放进 style-samples/audio/ 用同名 .tsv 转录');
  }
  if (cutDur < MIN_REF_SEC || cutDur > MAX_REF_SEC) {
    throw new Error(`对齐后参考段是 ${cutDur} 秒，超出 ${MIN_REF_SEC}~${MAX_REF_SEC} 秒：换个起点或改窗口长度`);
  }

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('没找到 ffmpeg（.tools/ffmpeg/bin/ffmpeg.exe）');

  const t0 = Date.now();
  let check = { level: 'skipped', why: '还没查' };   // try 外面也要用，所以声明在外面
  fs.mkdirSync(dest, { recursive: true });
  try {
    const how = copyModelFiles(tpl.dir, dest);
    const res = await cutAudio(ffmpeg, src.path, path.join(dest, 'ref.wav'), cutStart, cutDur);
    const wav = path.join(dest, 'ref.wav');
    const expect = cutDur * 2 * REF_RATE;   // 单声道 16bit：每秒 = 采样率 × 2 字节
    if (!fs.existsSync(wav) || fs.statSync(wav).size < expect * 0.3) {
      const msg = String(res.stderr || res.err?.message || '').slice(-300);
      throw new Error('切参考段没成功：' + msg);
    }
    // 最后一道闸：只在「完全对不上」时拦住（切错窗口、拿错文件）。
    // 一个字对不上它查不出来 —— 2026-09-24 的教训：「双曲线」被写成机器转录的
    // 「专曲线」，相似度还有 0.833，照样让克隆一直发糊。参考文字终究要人工核。
    check = await verifyRefText(refText, wav, null);
    if (!check.ok) {
      throw new Error(`${check.why}。识别回读是「${String(check.heard ?? '').slice(0, 40)}」，`
        + '请把参考文字改成与录音逐字对应的版本（别用机器转录，错一个字就会糊）');
    }
    fs.writeFileSync(path.join(dest, 'ref.txt'), refText + '\n', 'utf8');
    fs.writeFileSync(path.join(dest, 'README.txt'),
      readmeText({ name: nm.name, src: src.path, startSec: cutStart, durSec: cutDur, refText, refFrom, tplId: tpl.id }), 'utf8');
    log.info('tts', 'voice created', {
      id: nm.name, from: src.path, startSec: cutStart, durSec: cutDur, askedSec: sec, refFrom,
      chars: refText.length, ms: Date.now() - t0, how, refCheck: check.level,
    });
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true });   // 不留半个音色在盘上
    throw e;
  }

  const voice = tts.listVoices().find((v) => v.id === nm.name) ?? null;
  return {
    ok: true, voice, refText, refFrom, dir: dest, sizeMB: voice?.sizeMB ?? null,
    window: { startSec: cutStart, durSec: cutDur },
    refCheck: check.level === 'skipped' ? { level: 'skipped', why: check.why } : { level: check.level, similarity: check.similarity, heard: check.heard },
  };
}

/** 复制一个已有音色（含它的参考段），换个名字。用来在现成参考段上做微调。 */
export async function createFromVoice({ name, fromVoice }) {
  const nm = safeVoiceName(name);
  if (!nm.ok) throw new Error(nm.error);
  const src = tts.listVoices().find((v) => v.id === String(fromVoice ?? '').trim());
  if (!src) throw new Error(`没有叫 ${fromVoice} 的音色`);
  if (src.kind !== 'zipvoice') throw new Error(`${src.id} 是普通音色（不是克隆音色），不用复制：选它当音色就行`);
  const dest = path.join(tts.TTS_DIR, nm.name);
  if (fs.existsSync(dest)) throw new Error(`已经有叫 ${nm.name} 的音色了，换个名字`);

  fs.mkdirSync(dest, { recursive: true });
  try {
    const how = copyModelFiles(src.dir, dest);
    fs.copyFileSync(path.join(src.dir, 'ref.wav'), path.join(dest, 'ref.wav'));
    fs.copyFileSync(path.join(src.dir, 'ref.txt'), path.join(dest, 'ref.txt'));
    fs.writeFileSync(path.join(dest, 'README.txt'),
      `${nm.name} 的音色（复制自 ${src.id}）\n参考文字：${src.refText}\n参考文字必须与参考录音严格对应 —— 改 ref.wav 就要同时改 ref.txt。\n`, 'utf8');
    log.info('tts', 'voice duplicated', { id: nm.name, from: src.id, how });
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw e;
  }
  const voice = tts.listVoices().find((v) => v.id === nm.name) ?? null;
  return { ok: true, voice, refText: src.refText, refFrom: `复制自 ${src.id}`, dir: dest, sizeMB: voice?.sizeMB ?? null };
}

export { TOOLS_DIR };
