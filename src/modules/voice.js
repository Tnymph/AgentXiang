// 语音条识别：把 QQ 语音转成文字，接进消息管线
//
// 流程：向 NapCat 要转码后的 wav —— 本机路径就直接读，环回 URL 就取回来 ——
//       再交给常驻识别服务。整条链路只用 Node 内置能力，不调用任何外部程序。
//
// 注意：识别失败不应中断消息处理，只是这条消息少了一段文字，所以全程不抛错，
//       失败原因写进日志与返回值。
import fs from 'node:fs';
import path from 'node:path';
import * as log from '../logger.js';
import * as net from '../net.js';
import * as asr from '../asr.js';

const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

/** 取一段语音的音频字节：本机路径直接读，否则走环回取件 */
export async function fetchAudio(client, voice) {
  const file = String(voice?.file ?? '');
  const url = String(voice?.url ?? '');

  // 情况一：NapCat 是与我们同一台机器上的常驻服务，转码后常直接给本地路径
  if (file && path.isAbsolute(file) && fs.existsSync(file)) {
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) return { ok: false, reason: '不是文件' };
      if (st.size > MAX_AUDIO_BYTES) return { ok: false, reason: `文件过大 ${st.size}` };
      return { ok: true, buffer: fs.readFileSync(file), from: 'local-file' };
    } catch (e) {
      return { ok: false, reason: String(e.message) };
    }
  }

  // 情况二：让 NapCat 把它转成 wav
  let got = null;
  try {
    got = await client.getRecord(file || url, 'wav');
  } catch (e) {
    log.debug('voice', 'get_record 失败', String(e.message));
  }

  const candidate = got?.file || got?.url || url;
  if (!candidate) return { ok: false, reason: '拿不到音频地址' };

  // 转码后也可能直接落在本地
  if (path.isAbsolute(candidate) && fs.existsSync(candidate)) {
    try {
      const st = fs.statSync(candidate);
      if (st.size > MAX_AUDIO_BYTES) return { ok: false, reason: `文件过大 ${st.size}` };
      return { ok: true, buffer: fs.readFileSync(candidate), from: 'local-file' };
    } catch (e) {
      return { ok: false, reason: String(e.message) };
    }
  }

  // 否则按环回 URL 取（只允许 127.0.0.1 / ::1，取不到局域网别处）
  const r = await net.fetchLoopback(candidate, { maxBytes: MAX_AUDIO_BYTES });
  if (!r.ok) return { ok: false, reason: r.reason ?? '取音频失败' };
  return { ok: true, buffer: r.buffer, from: 'loopback' };
}

/**
 * 识别一条消息里的所有语音。
 * 返回 { ok, text, count, errors[] }
 */
export async function transcribeVoices(client, msg, settings) {
  const cfg = settings?.api?.voiceAsr ?? {};
  if (cfg.enabled === false) return { ok: false, text: '', count: 0, errors: ['语音识别已关闭'] };
  if (!msg.voices?.length) return { ok: false, text: '', count: 0, errors: [] };

  const target = asr.describeTarget(settings);
  const maxSec = Number(cfg.maxSeconds) || 60;
  const timeoutMs = Number(cfg.timeoutMs) || 30000;

  const texts = [];
  const errors = [];

  for (const voice of msg.voices.slice(0, 3)) {
    const audio = await fetchAudio(client, voice);
    if (!audio.ok) { errors.push('取音频失败：' + audio.reason); continue; }

    const r = await asr.transcribeWav(audio.buffer, { ...target, timeoutMs });
    if (!r.ok) { errors.push(r.error); continue; }
    if (r.durationSec > maxSec) {
      errors.push(`音频 ${r.durationSec.toFixed(0)} 秒超过上限 ${maxSec} 秒`);
      continue;
    }
    if (r.text) {
      texts.push(r.text);
      log.debug('voice', 'transcribed', {
        from: audio.from, sec: Number(r.durationSec.toFixed(1)),
        segs: r.segments, chars: r.text.length, speed: (r.durationSec / (r.elapsedMs / 1000)).toFixed(1),
      });
    }
  }

  return { ok: texts.length > 0, text: texts.join(' '), count: texts.length, errors };
}

/** 把识别结果并进消息文本，让后续流程把它当普通文本处理 */
export function mergeVoiceText(msg, voiceText) {
  if (!voiceText) return msg;
  const spoken = `[语音] ${voiceText}`;
  msg.voiceText = voiceText;
  msg.textClean = msg.textClean ? `${msg.textClean} ${spoken}` : spoken;
  msg.text = msg.text ? `${msg.text} ${spoken}` : spoken;
  return msg;
}
