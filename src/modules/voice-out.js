// 回复要不要用语音说：四档 + 护栏。
//
// 四档（settings.speak.voice.mode）：
//   text  只发文字（默认，行为和以前一样）
//   voice 全用语音（讲题这类长回复自动退回文字）
//   prob  按概率抽样，prob 是命中率
//   ai    由模型自己决定：tail 里告诉它「想用语音说就在第一行写 [语音]」，本地剥掉记号照办
//
// 为什么这么多护栏：合成一条 11 秒（CPU 单线程），一次回复要发三四条的话
// 人早就走了。所以宁可退回文字，也不让语音队列排到天荒地老。
import path from 'node:path';
import fs from 'node:fs';
import * as rate from './rateLimit.js';
import * as tts from './tts.js';
import * as voices from './voices.js';
import * as wav from '../wav.js';

export const MODES = ['text', 'voice', 'prob', 'ai'];
export const QUALITIES = ['normal', 'high', 'auto'];
// 记号可以出现在任何位置，也可以换括号（模型会照抄提示词里 〔能力〕〔情形〕 那种写法，
// 实测漏过一次：它写 〔语音〕 想用语音念诗，结果记号没剥、还当文字发进群）。
// 覆盖四种常见括号：方括号、实心方头、六角括号、圆括号（全半角都算）。
export const MARKER_RE = /[\[【〔（(]\s*语音\s*[\]】〕）)]/g;

export const DEFAULTS = {
  mode: 'text', prob: 0.3, voiceId: '', sid: 0, quality: 'normal',
  // 语速：0 = 用档位里的默认（zipvoice 默认 0.82，「张小向」那套听惯的值）。
  // 用户反馈「语速快了」时就调这个数（更小 = 更慢）。
  speed: 0,
  maxChars: 26, maxMessages: 2, maxMessagesForced: 4, perHour: 20, pauseMs: 0,
  trimOnset: true, trimExtraMs: 250, trimFallbackMs: 900,
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));

/** 读设置，坏值一律夹到安全范围（设置是人工填的，不能让它把主流程带崩） */
export function cfg(settings) {
  const raw = settings?.speak?.voice ?? {};
  return {
    mode: MODES.includes(raw.mode) ? raw.mode : DEFAULTS.mode,
    prob: clamp(Number(raw.prob ?? DEFAULTS.prob), 0, 1),
    voiceId: String(raw.voiceId ?? DEFAULTS.voiceId),
    sid: Math.max(0, Number.parseInt(raw.sid ?? DEFAULTS.sid, 10) || 0),
    quality: QUALITIES.includes(raw.quality) ? raw.quality : DEFAULTS.quality,
    // 语速：0 = 用档位默认；允许 0.5~1.5（更小更慢）
    speed: clamp(Number(raw.speed ?? DEFAULTS.speed), 0, 1.5),
    maxChars: clamp(Number(raw.maxChars ?? DEFAULTS.maxChars), 4, 60),
    maxMessages: clamp(Number(raw.maxMessages ?? DEFAULTS.maxMessages), 1, 5),
    maxMessagesForced: clamp(Number(raw.maxMessagesForced ?? DEFAULTS.maxMessagesForced), 1, 8),
    perHour: clamp(Number(raw.perHour ?? DEFAULTS.perHour), 0, 240),
    // 句间停顿（毫秒）：vits 类音色停顿很短，靠逐句合成自己补；0 = 不补
    pauseMs: clamp(Number(raw.pauseMs ?? DEFAULTS.pauseMs), 0, 1500),
    // 掐掉开头伪影：ZipVoice 类模型会在开头吐 0.5~1.5 秒不稳定音频（26 字的消息里占三分之一）。
    // 默认开。**实测 6 条：4 条各掐掉 2.0~2.7 秒且回读从第一个字就正确，2 条检测不到原样不动，
    // 0 条切掉正话**（判定要求对齐分够高、掐点 ≤3 秒、掐完还剩 40% 以上）。
    // 识别服务不在时就原样发，不影响发送。
    trimOnset: raw.trimOnset !== false,
    // 在定位到的起点之后再**多切**这么多毫秒：识别的时间戳常比真实起音早一点，
    // 只按它切会留一小段尾巴（用户反馈「切得有点不完全」）。
    // 切多了有自检兜着（掐完回读一次，内容掉太多自动还原），所以敢给大一点
    trimExtraMs: clamp(Number(raw.trimExtraMs ?? DEFAULTS.trimExtraMs), 0, 1000),
    // 定位不到时（识别读得差）退而求其次硬切这么多毫秒；0 = 不硬切
    trimFallbackMs: clamp(Number(raw.trimFallbackMs ?? DEFAULTS.trimFallbackMs), 0, 1000),
  };
}

/**
 * 剥掉语音记号。forced = 模型自己要求用语音说（记号出现在哪都算）。
 * 顺手把多余空格收掉 —— 记号被剥掉后常常留下一个空格。
 */
export function stripMarker(text) {
  const s = String(text ?? '');
  const hit = MARKER_RE.test(s);
  MARKER_RE.lastIndex = 0;                 // 全局正则带状态，用完必须复位
  if (!hit) return { text: s.trim(), forced: false };
  return { text: s.replace(MARKER_RE, ' ').replace(/[ \t]{2,}/g, ' ').replace(/\s+([，。！？；：])/g, '$1').trim(), forced: true };
}

/**
 * 这一条要不要用语音发。
 * detailed（在讲题/举例）默认退回文字：讲题要长、要能回头翻，语音念一遍记不住。
 */
export function decide({ cfg, text, detailed = false, forced = false, random = Math.random }) {
  if (cfg.mode === 'text') return { voice: false, why: '文字档' };
  if (!String(text ?? '').trim()) return { voice: false, why: '没内容' };
  if (detailed) return { voice: false, why: '讲题走文字' };
  if (cfg.mode === 'voice') return { voice: true, why: '语音档' };
  if (cfg.mode === 'ai') return forced ? { voice: true, why: '模型指定' } : { voice: false, why: '模型没要语音' };
  return random() < cfg.prob
    ? { voice: true, why: `随机命中(${cfg.prob})` }
    : { voice: false, why: `随机未命中(${cfg.prob})` };
}

/** 实际用哪一档质量：auto = 讲题用高质量，其余用默认档（高质量慢 3 倍） */
export function qualityFor(cfg, { detailed = false } = {}) {
  if (cfg.quality === 'auto') return detailed ? 'high' : 'normal';
  return cfg.quality;
}

/** 占一条语音配额（每小时上限）。0 = 语音关着。 */
export function take(botId, cfg, now = Date.now()) {
  if (cfg.perHour <= 0) return { ok: false, reason: '语音上限为 0（等于关着）' };
  const r = rate.hit(`voice:${botId}:h`, 3600_000, cfg.perHour, now);
  if (!r.ok) {
    return { ok: false, reason: `语音条数已达上限(${cfg.perHour}/小时)`, retryAfterMs: r.retryAfterMs };
  }
  return { ok: true, count: r.count, remaining: cfg.perHour - r.count };
}

/** 只读看一眼配额（不消费），给界面用 */
export function peek(botId, cfg, now = Date.now()) {
  const used = rate.peek(`voice:${botId}:h`, 3600_000, now);
  return { used, limit: cfg.perHour, remaining: Math.max(0, cfg.perHour - used) };
}

/**
 * 一条回复要发 count 条语音，配额够不够（只看不消费）。
 * 不够就整条走文字 —— 不能发一半，那会变成「前半语音后半文字」的混合回复。
 */
export function canAfford(botId, cfg, count, now = Date.now()) {
  if (cfg.perHour <= 0) return { ok: false, why: '语音上限为 0' };
  const p = peek(botId, cfg, now);
  if (p.remaining < count) return { ok: false, why: `本小时只剩 ${p.remaining} 条，这条要 ${count} 条` };
  return { ok: true, remaining: p.remaining };
}

/**
 * 切成要说的几条。超长就不发语音 —— 切成十条语音比发一段文字难听得多。
 * forced = 模型自己点名要用语音（ai 档写了 [语音]）：这种情况多给几条额度 ——
 * 群里说「朗读一下这首诗」是明确要求，被 2 条卡掉会显得答非所问（实测过一次）。
 * 返回 { ok, parts, why }
 */
export function plan(text, cfg, { forced = false } = {}) {
  const parts = tts.splitForSpeech(text, cfg.maxChars);
  const limit = forced ? cfg.maxMessagesForced : cfg.maxMessages;
  if (!parts.length) return { ok: false, why: '没内容', parts: [] };
  if (parts.length > limit) {
    return { ok: false, why: `太长(${parts.length}条 > 上限${limit}${forced ? '，模型点名' : ''})`, parts };
  }
  return { ok: true, parts, why: `${parts.length}条${forced ? '（模型点名）' : ''}` };
}

/** NapCat 只认 file:// 加正斜杠（file:///C:/x/y.wav） */
export function fileUrl(p) {
  const s = path.resolve(String(p)).replace(/\\/g, '/');
  return `file:///${s.replace(/^\/+/, '')}`;
}

/**
 * 合成一条语音。先占配额再合成；合成失败不退还配额，
 * 因为失败通常意味着「音色/程序有问题」，让它继续吃配额反而能快速退回文字。
 * 返回 { ok, path, quality, remaining } 或 { ok:false, error, stage }
 */
export async function speak(text, { cfg, botId, detailed = false, timeoutMs }) {
  const clean = String(text ?? '').trim();
  if (!clean) return { ok: false, error: '没有要说的', stage: 'text' };
  const q = take(botId, cfg);
  if (!q.ok) return { ok: false, error: q.reason, stage: 'quota' };
  const quality = qualityFor(cfg, { detailed });
  const engine = voices.engineOf(cfg.voiceId);
  // 音色决定引擎：cosy: 开头走 CosyVoice2 的常驻服务，其余走 sherpa（两个引擎的返回形状一致）
  const r = await voices.synthesizeAny(clean, {
    voiceId: cfg.voiceId, sid: cfg.sid, quality, speed: cfg.speed, pauseMs: cfg.pauseMs, timeoutMs,
  });
  if (!r.ok) return { ok: false, error: r.error, stage: 'synth', quality, engine };
  // 掐掉开头伪影：只有 ZipVoice 那类「参考音频提示」的老引擎有这毛病。
  // CosyVoice2 实测没有（0 秒），变声（rvc）的声源就是 CosyVoice，同样没有，
  // 都不做这一步——它的自检要额外调两次识别，不便宜。
  let trim = { trimmed: false };
  if (cfg.trimOnset && engine === 'zipvoice') {
    trim = await tts.trimOnset(r.path, clean, {
      settings: null, extraMs: cfg.trimExtraMs, fallbackMs: cfg.trimFallbackMs,
    });
    if (trim.trimmed) {
      const buf = fs.readFileSync(r.path);
      const info = wav.headerInfo(buf.subarray(0, 64));
      r.seconds = wav.durationSec(info, buf.length);
      r.size = buf.length;
    }
  }
  return {
    ok: true, path: r.path, voice: r.voice, kind: r.kind, engine, quality, pauseMs: r.pauseMs ?? 0,
    seconds: r.seconds, ms: r.ms, remaining: q.remaining, trimmedSec: trim.trimmed ? trim.cutSec : 0,
  };
}
