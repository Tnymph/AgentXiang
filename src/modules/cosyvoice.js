// CosyVoice2 客户端 + 音色注册表。
//
// 这边的「音色」比 ZipVoice 那边简单得多：一个目录 = 一段参考录音 + 与它逐字对应的文字
//   .tools/cosy-voices/<名字>/ref.wav   16kHz 单声道，10~20 秒
//   .tools/cosy-voices/<名字>/ref.txt   必须与录音逐字对应（错一个字就会念糊）
// 合成时由常驻服务（.tools/CosyVoice/zx-server.py，默认 6011 端口）现算，不用复制模型文件。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, TOOLS_DIR, TMP_DIR } from '../paths.js';
import * as log from '../logger.js';
import * as wav from '../wav.js';

export const COSY_VOICE_DIR = path.join(TOOLS_DIR, 'cosy-voices');
export const VOICE_PREFIX = 'cosy:';          // 列表里的 id 前缀：一眼看出用的哪个引擎
export const DEFAULT_PORT = 6011;
const DEFAULT_TIMEOUT = 300000;                // 一句最多等 5 分钟（服务刚起来时会在加载模型）
const MAX_REF_BYTES = 300 * 1024 * 1024;

export const isCosyId = (id) => String(id ?? '').startsWith(VOICE_PREFIX);
export const stripPrefix = (id) => String(id ?? '').slice(VOICE_PREFIX.length);

/** 服务地址：只有本机 */
export function target(settings) {
  const port = Number(settings?.cosy?.port) || DEFAULT_PORT;
  const host = String(settings?.cosy?.host ?? '127.0.0.1');
  return { host, port };
}

/** 音色名（= 目录名）必须纯 ASCII，且不能带路径分隔符 */
export function safeName(name) {
  const s = String(name ?? '').trim();
  if (!/^[A-Za-z0-9_-]{2,32}$/.test(s)) {
    return { ok: false, error: '音色名只能用小写字母、数字、下划线、短横线（2~32 位）' };
  }
  return { ok: true, name: s };
}

/** 目标路径必须落在给定目录里（防路径穿越；名字本身也过了白名单） */
export function insideDir(dir, name) {
  const base = path.resolve(dir);
  const full = path.resolve(base, name);
  if (path.dirname(full) !== base) return null;
  return full;
}

/** 列出本机所有 CosyVoice 音色（目录 + 参考文件齐了才算） */
export function listVoices(dir = COSY_VOICE_DIR) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (!safeName(e.name).ok) continue;
    const d = path.join(dir, e.name);
    const refAudio = path.join(d, 'ref.wav');
    const refTxt = path.join(d, 'ref.txt');
    if (!fs.existsSync(refAudio) || !fs.existsSync(refTxt)) continue;
    const info = wav.headerInfo(fs.readFileSync(refAudio).subarray(0, 64));
    out.push({
      id: `${VOICE_PREFIX}${e.name}`,
      engine: 'cosyvoice',
      kind: 'cosyvoice',
      name: e.name,
      dir: d,
      refAudio,
      refText: fs.readFileSync(refTxt, 'utf8').trim(),
      sampleRate: info.sampleRate,
      seconds: wav.durationSec(info, fs.statSync(refAudio).size),
      sizeMB: Number((fs.statSync(refAudio).size / 1024 / 1024).toFixed(1)),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** 服务在不在 */
export async function probe(settings) {
  const { host, port } = target(settings);
  try {
    const r = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    return {
      ok: r.ok && j.ok !== false, host, port,
      loaded: !!j.loaded, sampleRate: j.sampleRate ?? null, loadSec: j.loadSec ?? null, voiceDir: j.voiceDir ?? null,
    };
  } catch (e) {
    return { ok: false, host, port, error: String(e.message).slice(0, 80) };
  }
}

/**
 * 合一句。返回 { ok, path, seconds, ms, voice } 或 { ok:false, error }
 * 与 tts.synthesize 的返回形状保持一致，上层就能一视同仁。
 */
export async function synthesize(text, { voiceId = '', speed = 1, settings = null, timeoutMs = DEFAULT_TIMEOUT, outPath = '' } = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) return { ok: false, error: '没有要合成的文字' };
  const raw = isCosyId(voiceId) ? stripPrefix(voiceId) : String(voiceId ?? '');
  const nm = safeName(raw);
  if (!nm.ok) return { ok: false, error: nm.error };
  const { host, port } = target(settings);

  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`http://${host}:${port}/synth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean, voice: nm.name, speed: Number(speed) > 0 ? Number(speed) : 1 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    log.warn('cosy', '服务调用失败', { err: String(e.message).slice(0, 120), host, port });
    return { ok: false, error: `语音合成服务没响应（${host}:${port}）` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, error: `合成服务报错 HTTP ${res.status}：${body.slice(0, 160)}` };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) return { ok: false, error: '合成出来的文件太小' };
  const ms = Date.now() - t0;

  const dest = outPath || path.join(TMP_DIR, 'tts', `cosy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  const info = wav.headerInfo(buf.subarray(0, 64));
  const seconds = wav.durationSec(info, buf.length);
  log.info('cosy', 'ok', { voice: nm.name, chars: clean.length, ms, size: buf.length, rate: info.sampleRate, seconds });
  return {
    ok: true, path: dest, size: buf.length, ms,
    voice: `${VOICE_PREFIX}${nm.name}`, engine: 'cosyvoice', kind: 'cosyvoice',
    sampleRate: info.sampleRate, seconds,
  };
}

/**
 * 造/登记一个 CosyVoice 音色：一段参考音频（自动转 16k 单声道）+ 与它逐字对应的文字。
 * 参考音频**只允许放在项目目录里**（相对路径按项目根算）：这是个本地服务，但也别让它
 * 变成「读任意文件」的口子。
 */
export async function addVoice({ name, refAudioPath, text, startSec = 0, durSec = 0, dir = COSY_VOICE_DIR, root = ROOT }) {
  const nm = safeName(name);
  if (!nm.ok) return { ok: false, error: nm.error };
  const dest = insideDir(dir, nm.name);
  if (!dest) return { ok: false, error: '音色路径不合法' };
  if (fs.existsSync(dest)) return { ok: false, error: `已经有叫 ${nm.name} 的音色了，换个名字` };
  const refText = String(text ?? '').trim();
  if (!refText) return { ok: false, error: '参考文字是必填的（必须与录音逐字对应，错一个字就会念糊）' };

  const rootAbs = path.resolve(root);
  const src = path.resolve(rootAbs, String(refAudioPath ?? ''));
  if (!(src === rootAbs || src.startsWith(rootAbs + path.sep))) {
    return { ok: false, error: '参考音频要放在项目目录里（写相对路径，比如 style-samples/audio/p10.m4a）' };
  }
  if (!fs.existsSync(src)) return { ok: false, error: `参考音频不存在：${src}` };
  const st = fs.statSync(src);
  if (!st.isFile()) return { ok: false, error: '参考音频不是一个文件' };
  if (st.size > MAX_REF_BYTES) return { ok: false, error: '参考音频太大了（>300MB）' };

  fs.mkdirSync(dest, { recursive: true });
  const refWav = path.join(dest, 'ref.wav');
  const info = wav.headerInfo(fs.readFileSync(src).subarray(0, 64));
  const start = Number(startSec) || 0;
  const dur = Number(durSec) || 0;
  let converted = false;
  if (start === 0 && dur === 0 && info.sampleRate === 16000 && info.channels === 1) {
    fs.copyFileSync(src, refWav);               // 已经是 16k 单声道整段，直接用
    converted = true;
  } else {
    const { findFfmpeg } = await import('./media-learn.js');
    const ffmpeg = findFfmpeg();
    if (ffmpeg) {
      const { execFile } = await import('node:child_process');
      const args = ['-y'];
      if (start > 0) args.push('-ss', String(start));
      args.push('-i', src);
      if (dur > 0) args.push('-t', String(dur));
      args.push('-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', refWav);
      await new Promise((resolve) => {
        execFile(ffmpeg, args, { windowsHide: true, timeout: 180000 }, () => resolve());
      });
      converted = fs.existsSync(refWav) && fs.statSync(refWav).size > 1024;
    }
  }
  if (!converted) {
    fs.rmSync(dest, { recursive: true, force: true });
    return { ok: false, error: '参考音频转 16k 单声道没成功（需要 ffmpeg）' };
  }
  fs.writeFileSync(path.join(dest, 'ref.txt'), refText + '\n', 'utf8');
  log.info('cosy', 'voice added', { id: nm.name, from: src, startSec: start, durSec: dur, chars: refText.length });
  return { ok: true, voice: listVoices(dir).find((v) => v.name === nm.name) ?? null };
}
