// 语音合成（本地，不花钱）：文本 → wav。
//
// 两种音色，结构都放在 .tools/tts/<音色名>/ 下，自包含、可直接拷贝给别人：
//   vits      ：model.onnx（或 <名字>.onnx）+ lexicon.txt + tokens.txt（+ dict/），要指 --sid
//   zipvoice  ：encoder*.onnx + decoder*.onnx + 声码器 + espeak-ng-data/ + ref.wav + ref.txt
//               零样本克隆：ref.wav 与 ref.txt **必须严格对应**，对不上就会吐字发糊（实测过）
//
// 这一层只管「给文本、拿回一个 wav 文件」，不管发给谁、什么时候发。
// 合成是 CPU 密集的，所以请求在这里串行，不让两个机器人同时合成把 CPU 打满。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { TOOLS_DIR, DATA_DIR } from '../paths.js';
import * as log from '../logger.js';
import * as wav from '../wav.js';
import * as asr from '../asr.js';

const TTS_DIR = path.join(TOOLS_DIR, 'tts');
const OUT_DIR = path.join(DATA_DIR, 'tmp', 'tts');
const DEFAULT_TIMEOUT = 120000;

/** 质量档：默认档是用户听完样本后定的（语速 0.82、停顿 ×1.7），高质量档再加步数 */
export const QUALITY = {
  normal: { label: '默认', zipvoice: ['--speed=0.82', '--tts-silence-scale=1.7'] },
  high: { label: '高质量（更自然，慢 3 倍）', zipvoice: ['--speed=0.82', '--tts-silence-scale=1.7', '--num-steps=16'] },
};

/** 找合成程序：和识别服务在同一个 bin 目录里 */
export function findBinary() {
  const sherpaDir = path.join(TOOLS_DIR, 'sherpa');
  if (!fs.existsSync(sherpaDir)) return null;
  const names = process.platform === 'win32'
    ? ['sherpa-onnx-offline-tts.exe']
    : ['sherpa-onnx-offline-tts'];
  for (const d of fs.readdirSync(sherpaDir)) {
    for (const n of names) {
      const p = path.join(sherpaDir, d, 'bin', n);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/** 在 .tools/tts 下找声码器（它在另一个包里，不在音色目录里） */
function findVocoder(dir) {
  const local = fs.readdirSync(dir).find((f) => /vocos|vocoder/i.test(f) && f.endsWith('.onnx'));
  if (local) return path.join(dir, local);
  if (!fs.existsSync(TTS_DIR)) return null;
  for (const e of fs.readdirSync(TTS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const hit = fs.readdirSync(path.join(TTS_DIR, e.name)).find((f) => /vocos|vocoder/i.test(f) && f.endsWith('.onnx'));
    if (hit) return path.join(TTS_DIR, e.name, hit);
  }
  return null;
}

const biggest = (dir, re) => fs.readdirSync(dir)
  .filter((f) => re.test(f) && f.endsWith('.onnx'))
  .map((f) => ({ f, size: fs.statSync(path.join(dir, f)).size }))
  .sort((a, b) => b.size - a.size)[0]?.f ?? null;

/** 列出手上有的音色。两种结构都认。 */
export function listVoices(dir = TTS_DIR) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const d = path.join(dir, e.name);
    const files = fs.readdirSync(d);
    const refWav = path.join(d, 'ref.wav');
    const refTxt = path.join(d, 'ref.txt');
    // zipvoice 包的标志：完整包里是 fm_decoder / text_encoder，蒸馏包里是 encoder / decoder
    const isZip = files.some((f) => /^(encoder|decoder|fm_decoder|text_encoder).*\.onnx$/i.test(f));
    if (isZip) {
      // zipvoice 包必须带参考录音和参考文字才算一个完整音色；缺了就跳过 ——
      // 否则它会被下面的 vits 分支当成音色，回退时选到它只会报 n_speakers 不存在
      if (!fs.existsSync(refWav) || !fs.existsSync(refTxt)) continue;
      if (!findVocoder(d)) continue;
      const dec = biggest(d, /^decoder.*\.onnx$/);
      out.push({
        id: e.name, kind: 'zipvoice', dir: d,
        refAudio: refWav,
        refText: fs.readFileSync(refTxt, 'utf8').trim(),
        sizeMB: dec ? Number((fs.statSync(path.join(d, dec)).size / 1024 / 1024).toFixed(1)) : 0,
      });
      continue;
    }
    const model = biggest(d, /\.onnx$/);
    if (!model) continue;
    out.push({
      id: e.name, kind: 'vits', dir: d,
      model: path.join(d, model),
      lexicon: files.includes('lexicon.txt') ? path.join(d, 'lexicon.txt') : null,
      tokens: files.includes('tokens.txt') ? path.join(d, 'tokens.txt') : null,
      // 词典目录：有 dict/ 就用 dict/，否则用目录本身 —— 两个模型的正确值不一样，
      // 指错不报错，但多音字和数字会念错（实测「矩阵」变成「举证」）
      dictDir: fs.existsSync(path.join(d, 'dict', 'jieba.dict.utf8')) ? path.join(d, 'dict')
        : (files.includes('number.fst') ? d : null),
      multiSpeaker: files.includes('speakers.txt'),
      sizeMB: Number((fs.statSync(path.join(d, model)).size / 1024 / 1024).toFixed(1)),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** 拼出命令行参数（纯函数，便于单测）。quality 只影响 zipvoice；speed 给了就覆盖档位里的语速 */
export function buildArgs(voice, text, outPath, { sid = 0, quality = 'normal', speed = 0 } = {}) {
  const sp = Number(speed) > 0 ? [`--speed=${speed}`] : [];
  if (voice.kind === 'zipvoice') {
    const voc = findVocoder(voice.dir);
    const tier = (QUALITY[quality] ?? QUALITY.normal).zipvoice.filter((a) => !(sp.length && a.startsWith('--speed=')));
    const args = [
      `--zipvoice-encoder=${path.join(voice.dir, fs.readdirSync(voice.dir).find((f) => /^encoder.*\.onnx$/.test(f)))}`,
      `--zipvoice-decoder=${path.join(voice.dir, fs.readdirSync(voice.dir).find((f) => /^decoder.*\.onnx$/.test(f)))}`,
      ...(voc ? [`--zipvoice-vocoder=${voc}`] : []),
      `--zipvoice-data-dir=${path.join(voice.dir, 'espeak-ng-data')}`,
      `--zipvoice-lexicon=${path.join(voice.dir, 'lexicon.txt')}`,
      `--zipvoice-tokens=${path.join(voice.dir, 'tokens.txt')}`,
      `--reference-audio=${voice.refAudio}`,
      `--reference-text=${voice.refText}`,
      ...sp,
      ...tier,
      `--output-filename=${outPath}`,
      text,
    ];
    return args;
  }
  const args = [`--vits-model=${voice.model}`, `--output-filename=${outPath}`];
  if (voice.lexicon) args.push(`--vits-lexicon=${voice.lexicon}`);
  if (voice.tokens) args.push(`--vits-tokens=${voice.tokens}`);
  if (voice.dictDir) args.push(`--vits-dict-dir=${voice.dictDir}`);
  if (voice.multiSpeaker) args.push(`--sid=${sid}`);
  args.push(...sp);
  args.push(text);
  return args;
}

/**
 * 长文本切句：合成慢、语音条也不该太长，所以按标点切成小块。纯函数，便于单测。
 *
 * 切分顺序（重要）：句末标点 → 读点（逗号顿号）→ 实在没有标点才硬数字。
 * 以前是直接「每 maxChars 个字切一刀」，结果把一句话从词中间劈开：
 * 「…翻开全是行列式。」变成「…翻开全是」+「行列式。」，听起来就是「话说一半断了」（用户报过）。
 * 宁可贵一点（一条长几个字），也不能切在词中间。
 */
export function splitForSpeech(text, maxChars = 50) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  // 把若干片段合并到不超过上限：能合就合，合不了就单独成条
  const merge = (parts) => {
    const out = [];
    let buf = '';
    for (const p of parts) {
      if (!buf) { buf = p; continue; }
      if ((buf + p).length <= maxChars) { buf += p; continue; }
      out.push(buf);
      buf = p;
    }
    if (buf) out.push(buf);
    return out;
  };

  const sentences = clean.split(/(?<=[。！？!?；;…\n])/).map((s) => s.trim()).filter(Boolean);
  const first = merge(sentences);
  // 还是超长的（一句话又长又没句号）：按逗号顿号再切一次
  const second = first.flatMap((s) => (s.length <= maxChars
    ? [s]
    : merge(s.split(/(?<=[，,、])/).map((x) => x.trim()).filter(Boolean))));
  // 连逗号都没有的超长块（一长串数字之类）：只能硬切，这是最后手段
  return second.flatMap((s) => (s.length <= maxChars ? [s] : (s.match(new RegExp(`.{1,${maxChars}}`, 'g')) ?? [s])));
}

/**
 * 按标点切成「一口气能说完的小句」，用来逐句合成、自己补停顿。
 * maxClauses 是上限：超出时把后面的并进最后一句 —— **绝不能丢字**。
 * 纯函数，便于单测。
 */
export function splitClauses(text, { maxClauses = 4 } = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) return [];
  const raw = clean.split(/(?<=[。！？!?；;，,、…\n])/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p of raw) {
    // 只把「纯标点」碎片并到前一句（比如单独一个「，」）；真有一个字的短句照切，
    // 否则一句话里的单字分句会被一路合并，切了等于没切
    const bare = p.replace(/[\p{P}\p{S}\s]/gu, '');
    if (out.length && bare.length === 0) out[out.length - 1] += p;
    else out.push(p);
  }
  if (out.length > maxClauses) {
    const keep = out.slice(0, maxClauses - 1);
    keep.push(out.slice(maxClauses - 1).join(''));
    return keep;
  }
  return out;
}

/**
 * 在「识别结果 + 逐字时间戳」里找出正题从第几个字开始 —— 用来掐掉开头的伪影。
 *
 * 为什么要它：ZipVoice 这类「参考音频提示」的模型会在开头吐 0.5~1.5 秒不稳定音频
 * （实测：26 字的消息里它占三分之一，听感就是「糊」）。试过加静音垫、调引导强度、
 * 调步数、换全精度模型，都消不掉，只能事后掐。
 *
 * 做法：把「想要的文字」和识别结果做一次**整体对齐**（允许识别错字 —— 实测识别会把
 * 开头的「同学们好」听成「同下」，严格逐字匹配就永远找不到起点），取对齐得分最高的
 * 那个起点当正题开始；得分太低或位置离谱就不掐（宁可留着伪影，也不能把正话掐掉）。
 *
 * 另一个坑：**识别文字里的空白不占时间戳**（实测 35 字配 34 个时间戳），
 * 所以先按非空白字符把两者配对，直接比长度会永远对不上。
 * 纯函数，便于单测。返回 { index, cutSec, matched }
 */
export function findSpeechStart(heard, times, want, { minMatch = 3, maxCutSec = 3, minScore = 0.35 } = {}) {
  const clean = (s) => String(s ?? '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const W = clean(want);
  const raw = String(heard ?? '');
  const T = Array.isArray(times) ? times : [];
  if (!W || !raw || !T.length) return { index: 0, cutSec: 0, matched: 0 };

  // 字与时间配对：跳过空白，逐个取时间戳
  const chars = [];
  let ti = 0;
  for (const ch of raw) {
    if (/\s/.test(ch)) continue;
    if (ti >= T.length) break;
    chars.push({ ch, t: Number(T[ti++]) || 0 });
  }
  if (!chars.length) return { index: 0, cutSec: 0, matched: 0 };

  // 对齐打分：以 chars[from] 为起点，把 W 与 chars[from..] 逐字比
  // 匹配 +1、错字 -1、多字/漏字 -1（线性空位，够用了）
  const scoreFrom = (from) => {
    const A = chars.length - from;
    let prev = new Array(W.length + 1);
    for (let j = 0; j <= W.length; j++) prev[j] = -j;
    for (let i = 1; i <= A; i++) {
      const cur = new Array(W.length + 1);
      cur[0] = -i;
      for (let j = 1; j <= W.length; j++) {
        const m = prev[j - 1] + (chars[from + i - 1].ch === W[j - 1] ? 1 : -1);
        cur[j] = Math.max(m, prev[j] - 1, cur[j - 1] - 1);
      }
      prev = cur;
    }
    return prev[W.length];
  };

  let best = { index: 0, score: scoreFrom(0) };     // p=0（不掐）必须参与比较，否则干净音频也会被切
  for (let p = 1; p < chars.length; p++) {
    if (!(chars[p].t > 0) || chars[p].t > maxCutSec) continue;   // 只考虑「掐得动」的起点
    const s = scoreFrom(p);
    if (s > best.score) best = { index: p, score: s };
  }
  const norm = best.score / W.length;
  if (best.index === 0 || norm < minScore) return { index: best.index, cutSec: 0, matched: Math.max(0, Math.round(norm * W.length)) };
  return { index: best.index, cutSec: Number(chars[best.index].t.toFixed(3)), matched: Math.max(0, Math.round(norm * W.length)), score: Number(norm.toFixed(3)) };
}

/** 想要说的话里，有几个字能在回读里找到（允许识别自己错几个） */
export function coverage(want, heard) {
  const clean = (s) => String(s ?? '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const chars = [...new Set(clean(want))];
  const got = clean(heard);
  if (!chars.length) return 1;
  return Number((chars.filter((c) => got.includes(c)).length / chars.length).toFixed(3));
}

/**
 * 掐掉开头伪影：拿识别回读对一遍，只在实际有伪影时掐。
 *
 * 两处保护，因为「多切一点」和「别切掉正话」是互相牵扯的：
 *   1. `extraMs` 在定位到的起点之后**再多切**这么多毫秒（识别的时间戳常比真实起音早一点）；
 *   2. 掐完**再回读一次自检**，内容覆盖掉太多就原样还原 —— 实测多切 450/650 毫秒会把
 *      第一个词切掉（「作业记得写完」只剩「别熬太晚」），有自检才敢切得狠一点。
 * 定位不到时（识别读得差）不硬切，除非给了 `fallbackMs`。
 * 默认开（`speak.voice.trimOnset`）。识别服务不在就原样发，不影响发送。
 */
export async function trimOnset(filePath, want, { settings = null, minMatch = 3, minScore = 0.35, extraMs = 250, fallbackMs = 0 } = {}) {
  try {
    const original = fs.readFileSync(filePath);
    const parsed = wav.parseWav(original);
    const target = { ...asr.describeTarget(settings), timeoutMs: 60000 };
    const got = await asr.recognizeFull(parsed.samples, parsed.sampleRate, target);
    const usable = !!(got?.ok && got.text);
    const before = usable ? coverage(want, got.text) : 0;

    // 识别读不出来（服务抽风、整段质量差）时不要放弃：照样走保守切，让自检兜着
    const hit = usable
      ? findSpeechStart(got.text, got.timestamps, want, { minMatch, minScore })
      : { index: 0, cutSec: 0, matched: 0 };
    let cutAt = 0;
    let how = usable ? 'detected' : 'no-asr';
    if (hit.cutSec) {
      cutAt = Math.max(0, hit.cutSec - 0.05 + Math.max(0, Number(extraMs) || 0) / 1000);
    } else if (Number(fallbackMs) > 0) {
      cutAt = Math.min(Number(fallbackMs) / 1000, parsed.durationSec * 0.15);
      how = usable ? 'fallback' : 'fallback-no-asr';
    }
    if (!(cutAt > 0)) return { ok: true, trimmed: false, heard: got?.text ?? '', matched: hit.matched, coverage: before };
    if (!usable) log.warn('tts', 'onset trim without asr', { durationSec: Number(parsed.durationSec.toFixed(2)), cutAt: Number(cutAt.toFixed(2)) });

    const keep = Math.round(cutAt * parsed.sampleRate);
    const tail = parsed.samples.subarray(keep);
    if (tail.length < parsed.sampleRate * 0.3 || tail.length < parsed.samples.length * 0.4) {
      return { ok: true, trimmed: false, why: '掐完剩得太少', detected: hit.cutSec };
    }
    fs.writeFileSync(filePath, wav.encodeWav(tail, parsed.sampleRate));

    // 自检：掐完再回读一次，内容掉太多就还原。
    // 阈值要**相对自己比**：有的句子识别本来就只读出一半字（实测覆盖 0.40），
    // 用固定的 0.6 当门槛会把它们永远挡在门外，白掐一次。
    const again = await asr.recognizeFull(tail, parsed.sampleRate, target);
    const afterRead = !!(again?.ok && again.text);
    const after = afterRead ? coverage(want, again.text) : 0;
    // 两次都读不出来就没法判断，按「不还原」处理（保守切一般有益无害）；
    // 掐之前读得出来、掐完读不出来了，那是切坏了 → 还原
    const judged = usable && afterRead;
    const bad = judged ? after < Math.max(0.4, before - 0.15) : (usable && before >= 0.5 && !afterRead);
    if (bad) {
      fs.writeFileSync(filePath, original);
      log.warn('tts', 'onset trim reverted', { how, cutSec: Number(cutAt.toFixed(2)), before, after, heard: String(again?.text ?? '').slice(0, 40) });
      return { ok: true, trimmed: false, reverted: true, detected: hit.cutSec, coverage: before, why: `掐完内容掉了（${(before * 100) | 0}%→${(after * 100) | 0}%），已还原` };
    }
    log.info('tts', 'onset trimmed', {
      how, cutSec: Number(cutAt.toFixed(2)), detected: hit.cutSec, extraMs, matched: hit.matched,
      before, after, heard: String(got?.text ?? '').slice(0, 40),
    });
    return {
      ok: true, trimmed: true, how, cutSec: Number(cutAt.toFixed(2)), detected: hit.cutSec,
      matched: hit.matched, heard: got.text, coverage: after,
    };
  } catch (e) {
    return { ok: true, trimmed: false, why: String(e.message).slice(0, 80) };
  }
}

// 合成串行化：同时两个机器人合成会把 CPU 打满，反而更慢
let chain = Promise.resolve();

/** 跑一次合成程序，产出 target 文件。返回 { err, stderr } */
function runTts(bin, args, target, timeoutMs) {
  return new Promise((resolve) => {
    execFile(bin, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 1 << 22 },
      (err, stdout, stderr) => resolve({ err, stderr: String(stderr ?? '') }));
  });
}

/**
 * 合成一段文字，返回 { ok, path, ms } 或 { ok:false, error }。
 * voiceId 省略时用第一个可用的音色。文件名只用 ASCII —— 带中文会让子进程收不到正确路径。
 *
 * pauseMs：逐句合成、句间补这么多毫秒静音（0 = 直接整段合成）。
 * 需要它是因为 vits 类音色的停顿烧在模型里，`--tts-silence-scale` 基本不起作用（实测过）。
 * 代价是每个分句都要起一次程序，克隆音色一句 11 秒，所以只建议给 vits 音色开。
 */
export function synthesize(text, { voiceId = '', sid = 0, quality = 'normal', speed = 0, pauseMs = 0, timeoutMs = DEFAULT_TIMEOUT, outPath = '' } = {}) {
  const run = async () => {
    const clean = String(text ?? '').trim();
    if (!clean) return { ok: false, error: '没有要合成的文字' };
    const bin = findBinary();
    if (!bin) return { ok: false, error: '没找到合成程序（.tools/sherpa/*/bin/sherpa-onnx-offline-tts）' };
    const voices = listVoices();
    if (!voices.length) return { ok: false, error: '一个音色都没有（.tools/tts 下没有可用模型）' };
    const voice = voices.find((v) => v.id === voiceId) ?? voices.find((v) => v.kind === 'vits') ?? voices[0];

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const target = outPath || path.join(OUT_DIR, `tts-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`);
    const t0 = Date.now();

    // 逐句合成 + 自己补停顿：只有真的要补、且确实切出了多句时才走这条路
    const clauses = Number(pauseMs) > 0 ? splitClauses(clean, { maxClauses: 4 }) : [clean];
    if (clauses.length > 1) {
      const tmps = [];
      try {
        for (const [i, c] of clauses.entries()) {
          const tmp = path.join(OUT_DIR, `clause-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}.wav`);
          tmps.push(tmp);
          const r = await runTts(bin, buildArgs(voice, c, tmp, { sid, quality, speed }), tmp, timeoutMs);
          if (!fs.existsSync(tmp)) {
            const msg = String(r.stderr || r.err?.message || '').slice(-300);
            throw new Error(`分句合成没出文件（第 ${i + 1} 句）：${msg}`);
          }
        }
        const joined = wav.joinWavs(tmps.map((f) => fs.readFileSync(f)), { gapMs: pauseMs });
        if (!joined) throw new Error('拼接失败');
        fs.writeFileSync(target, joined);
      } catch (e) {
        log.warn('tts', '分句合成失败', { voice: voice.id, clauses: clauses.length, pauseMs, err: String(e.message) });
        return { ok: false, error: String(e.message) };
      } finally {
        for (const f of tmps) { try { fs.rmSync(f, { force: true }); } catch { /* 清不掉就算了 */ } }
      }
    } else {
      const res = await runTts(bin, buildArgs(voice, clean, target, { sid, quality, speed }), target, timeoutMs);
      if (!fs.existsSync(target)) {
        const msg = String(res.stderr || res.err?.message || '').slice(-300);
        log.warn('tts', 'synthesis failed', { voice: voice.id, kind: voice.kind, chars: clean.length, err: msg });
        return { ok: false, error: '合成没出文件：' + msg };
      }
    }

    const ms = Date.now() - t0;
    const size = fs.statSync(target).size;
    if (size < 1024) return { ok: false, error: '合成出来的文件太小，多半没成功' };
    // 时长按**文件头里的采样率和位深**算：音色有 8k / 22.05k / 24k，
    // 早先按 16k（32KB/秒）硬算，三个全错（theresa 真实 2.94 秒写成 4 秒）
    const info = wav.headerInfo(fs.readFileSync(target, { encoding: null }).subarray(0, 64));
    const seconds = wav.durationSec(info, size);
    log.info('tts', 'ok', {
      voice: voice.id, kind: voice.kind, quality, speed: Number(speed) || 0, clauses: clauses.length, pauseMs,
      chars: clean.length, ms, size, rate: info.sampleRate, seconds,
    });
    return {
      ok: true, path: target, size, ms, voice: voice.id, kind: voice.kind, quality, pauseMs,
      sampleRate: info.sampleRate, seconds,
    };
  };
  const p = chain.then(run, run);
  chain = p.catch(() => { /* 别让一次失败卡住后面的 */ });
  return p;
}

/**
 * 清理合成出来的旧文件。data/tmp/tts 会随每条语音长大（一条 20~60KB），
 * 且发送时 NapCat 还要读它，所以不能边发边删 —— 只在启动时清几天前的。
 */
export function pruneOutputs(days = 3, dir = OUT_DIR) {
  if (!fs.existsSync(dir)) return 0;
  const cutoff = Date.now() - Math.max(1, days) * 86400_000;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) { fs.rmSync(p, { force: true }); n++; }
    } catch { /* 单个文件删不掉不影响启动 */ }
  }
  if (n) log.info('tts', 'pruned old outputs', { n, days, dir });
  return n;
}

export { TTS_DIR, OUT_DIR };
