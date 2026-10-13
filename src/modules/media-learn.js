// 语音/视频语料：把文件放进 data/learn-media/，「扫描并收录」就会
//   用 ffmpeg 抽出音轨 → 本地识别（不花模型钱）→ 得到文字 + 情绪 + 事件 + 逐字时间戳
//   → 算出停顿节奏 → 合成一条素材进到学习里
//
// 停顿和语调在这里落地的方式：它们没法在文字回复里复现，但可以变成**风格描述**，
// 比如「吐槽前先笑一声」「短句连发、几乎不停顿」——这正是学习该提炼的东西。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DATA_DIR, TOOLS_DIR } from '../paths.js';
import * as asr from '../asr.js';
import * as wav from '../wav.js';
import * as learning from './learning.js';
import * as log from '../logger.js';

export const MEDIA_DIR = path.join(DATA_DIR, 'learn-media');
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.avi', '.flv', '.wmv', '.webm', '.m4v']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus', '.amr', '.silk']);
const MAX_BYTES = 200 * 1024 * 1024;

/** 收集目录里的音视频文件（不递归） */
export function listMedia(dir = MEDIA_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const p = path.join(dir, e.name);
      const st = fs.statSync(p);
      const ext = path.extname(e.name).toLowerCase();
      return {
        name: e.name,
        path: p,
        size: st.size,
        mtime: st.mtimeMs,
        kind: VIDEO_EXT.has(ext) ? 'video' : (AUDIO_EXT.has(ext) ? 'audio' : 'other'),
      };
    })
    .filter((f) => f.kind !== 'other' && f.size > 0 && f.size <= MAX_BYTES)
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * 从逐字时间戳算停顿节奏。纯函数，便于单测。
 * 相邻两个字的间隔里，超过 0.35 秒的算「停顿」；其余算正常连读。
 */
export function pauseStats(timestamps, { pauseSec = 0.35 } = {}) {
  const ts = (timestamps ?? []).filter((n) => Number.isFinite(n));
  if (ts.length < 3) return { ok: false, reason: '时间戳太少' };
  const gaps = [];
  for (let i = 1; i < ts.length; i++) {
    const g = ts[i] - ts[i - 1];
    if (g > 0) gaps.push(g);
  }
  if (!gaps.length) return { ok: false, reason: '没有有效间隔' };
  const pauses = gaps.filter((g) => g >= pauseSec);
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const duration = ts[ts.length - 1] - ts[0];
  return {
    ok: true,
    avgGap: Number(avg.toFixed(2)),
    maxPause: Number((pauses.length ? Math.max(...pauses) : 0).toFixed(2)),
    pauseCount: pauses.length,
    duration: Number(duration.toFixed(1)),
    chars: ts.length,
    // 平均字间隔小 = 语速快；停顿多 = 一顿一顿
    pace: avg < 0.16 ? '偏快' : (avg > 0.30 ? '偏慢' : '中等'),
  };
}

// SenseVoice 给的标签是英文，素材是中文的，翻译一下；认不出的原样留着
const EMOTION_ZH = {
  HAPPY: '开心', SAD: '低落', ANGRY: '生气', NEUTRAL: '平常',
  FEARFUL: '紧张', DISGUSTED: '嫌弃', SURPRISED: '惊讶', EMOJI: '带表情',
};
const EVENT_ZH = {
  Speech: '说话', Laughter: '笑声', Applause: '掌声', BGM: '背景音乐',
  Cough: '咳嗽', Sneeze: '打喷嚏', Crying: '哭声', Breathing: '呼吸声', Noise: '杂音',
};

/** 把一次识别的结果拼成给模型看的素材文本 */
export function buildMaterialText({ text, emotion, event, lang, stats, fileName }) {
  const bits = [];
  const clean = String(text ?? '').trim();
  if (!clean) return '';
  const meta = [];
  const emo = EMOTION_ZH[emotion] ?? (emotion && emotion !== 'NEUTRAL' ? emotion : '');
  const ev = EVENT_ZH[event] ?? (event && event !== 'Speech' ? event : '');
  if (emo && emo !== '平常') meta.push(`语气${emo}`);
  if (ev && ev !== '说话') meta.push(`伴随${ev}`);
  if (stats?.ok) {
    meta.push(`语速${stats.pace}（平均字间隔 ${stats.avgGap} 秒）`);
    if (stats.pauseCount > 0) meta.push(`有 ${stats.pauseCount} 处明显停顿，最长 ${stats.maxPause} 秒`);
    else meta.push('几乎不停顿');
  }
  bits.push(`（来自语音${fileName ? `：${fileName}` : ''}）${clean}`);
  if (meta.length) bits.push(`〔说话方式〕${meta.join('，')}`);
  return bits.join('\n');
}

/** 找 ffmpeg：Windows 用 .tools 下的，手机/Linux 用 PATH 里的 */
export function findFfmpeg() {
  const local = [
    path.join(TOOLS_DIR, 'ffmpeg', 'bin', 'ffmpeg.exe'),
    path.join(TOOLS_DIR, 'ffmpeg', 'ffmpeg.exe'),
  ].find((p) => fs.existsSync(p));
  return local ?? 'ffmpeg';
}

function decodeToWav(file, outPath) {
  return new Promise((resolve) => {
    execFile(findFfmpeg(), ['-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', outPath],
      { windowsHide: true, maxBuffer: 1 << 22, timeout: 180000 }, (err) => {
        if (err || !fs.existsSync(outPath)) resolve({ ok: false, error: 'ffmpeg 解码失败：' + String(err?.message ?? '').slice(0, 80) });
        else resolve({ ok: true, path: outPath });
      });
  });
}

/**
 * 处理一个文件：解码 → 识别 → 停顿统计 → 存成素材。
 * 不花模型钱（识别是本地服务）；只有之后跑学习时才消耗 token。
 */
export async function ingestMedia(file, { botId, settings, who = '' } = {}) {
  const st = fs.existsSync(file) ? fs.statSync(file) : null;
  if (!st) return { ok: false, file, error: '文件不存在' };
  if (st.size > MAX_BYTES) return { ok: false, file, error: `文件太大（${(st.size / 1024 / 1024).toFixed(0)}MB）` };

  const isWav = path.extname(file).toLowerCase() === '.wav';
  const tmp = path.join(DATA_DIR, 'tmp', 'learn-media.wav');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });

  let wavPath = file;
  if (!isWav) {
    const d = await decodeToWav(file, tmp);
    if (!d.ok) return { ok: false, file, error: d.error };
    wavPath = d.path;
  }

  let buf;
  try { buf = fs.readFileSync(wavPath); } catch (e) { return { ok: false, file, error: '读不出音频：' + e.message }; }

  let samples, sampleRate;
  try { ({ samples, sampleRate } = wav.parseWav(buf)); } catch (e) { return { ok: false, file, error: 'WAV 解析失败：' + e.message }; }
  if (!wav.hasSpeech(samples, sampleRate)) return { ok: false, file, error: '这段里没听到人声' };

  const target = asr.describeTarget(settings ?? {});
  const r = await asr.recognizeFull(samples, sampleRate, { host: target.host, port: target.port });
  if (!r.ok) return { ok: false, file, error: '识别失败：' + r.error };
  if (!String(r.text ?? '').trim()) return { ok: false, file, error: '识别结果为空' };

  const stats = pauseStats(r.timestamps);
  const text = buildMaterialText({ ...r, stats, fileName: path.basename(file) });
  if (!text) return { ok: false, file, error: '拼不出素材文本' };

  const guessWho = who || path.basename(file, path.extname(file)).slice(0, 20);
  const id = learning.addNote(botId, { text, source: 'media', who: guessWho });
  log.info('media-learn', 'ingested', {
    botId, noteId: id, file: path.basename(file), chars: text.length,
    emotion: r.emotion, event: r.event, pauseCount: stats.pauseCount ?? 0,
  });
  return { ok: true, file, noteId: id, chars: text.length, emotion: r.emotion, event: r.event, stats, preview: text.slice(0, 200) };
}

/** 收录目录里所有还没收录过的（按文件名去重：已收录的同名文件跳过） */
export async function ingestAll({ botId, settings, dir = MEDIA_DIR } = {}) {
  const files = listMedia(dir);
  const done = new Set(learning.listNotes(botId).filter((n) => n.source === 'media').map((n) => n.who));
  const results = [];
  for (const f of files) {
    const base = path.basename(f.name, path.extname(f.name)).slice(0, 20);
    if (done.has(base)) { results.push({ ok: false, file: f.name, skipped: true, error: '之前已经收录过同名文件' }); continue; }
    results.push(await ingestMedia(f.path, { botId, settings, who: base }));
  }
  return { results, dir };
}
