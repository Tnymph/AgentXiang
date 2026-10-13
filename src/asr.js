// 语音识别客户端
//
// 架构：识别模型跑在一个常驻的本地服务里（sherpa-onnx 自带的 websocket 服务端，
// 由 scripts/asr-server.cmd 启动）。本模块只负责把音频按协议送过去、把文字取回来。
//
// 这样做有两个好处：
//  1. 模型只加载一次。若每条语音都新起一个进程，光加载模型就要两三秒。
//  2. 主程序里不存在任何外部进程调用，也就没有把配置项变成命令执行的风险。
//
// 协议（sherpa-onnx offline websocket）：
//   二进制消息 = 4 字节小端采样率 + 4 字节小端样本总字节数 + float32 样本（-1..1）
//   文本消息   = "Done"（表示不再发音频）
//   服务端回   = JSON
//   同一条连接可以连续送多段：送一段 → 收一段结果 → 再送下一段。
import { assertEndpoint } from './net.js';
import { toAsrSamples, splitOnSilence, packForServer, hasSpeech } from './wav.js';
import * as log from './logger.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 6007;

function wsUrl({ host = DEFAULT_HOST, port = DEFAULT_PORT }) {
  return assertEndpoint(`ws://${host}:${port}/`).href;
}

/** 从服务端返回里找出识别文本，兼容几种可能的字段位置 */
export function pickText(payload) {
  const seen = new Set();
  const walk = (node, depth = 0) => {
    if (node === null || node === undefined || depth > 6) return '';
    if (typeof node === 'string') {
      const t = node.trim();
      if (!t || t === 'Done') return '';
      return t;
    }
    if (typeof node !== 'object') return '';
    if (seen.has(node)) return '';
    seen.add(node);

    // 数组：把各元素的文本拼起来（例如 segments: [{text}, {text}]）
    if (Array.isArray(node)) return node.map((x) => walk(x, depth + 1)).join('');

    if (typeof node.text === 'string' && node.text.trim()) return node.text.trim();
    for (const key of ['result', 'results', 'data', 'segments', 'value']) {
      if (node[key] !== undefined) {
        const t = walk(node[key], depth + 1);
        if (t) return t;
      }
    }
    return '';
  };
  return walk(payload);
}

function parseMessage(raw) {
  const s = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
  const trimmed = s.trim();
  if (!trimmed || trimmed === 'Done') return { kind: 'signal', text: '' };
  try {
    return { kind: 'result', text: pickText(JSON.parse(trimmed)) };
  } catch {
    return { kind: 'text', text: trimmed };
  }
}

/**
 * 打开一个识别会话，可以连续送多段音频，最后 close()。
 * 会话复用是必要的：一段长音频会被切成几十段，每段单开一条连接太浪费。
 * 返回 { ok, send(samples, rate), close() } 或 { ok:false, error }
 */
export function openSession({ host, port, timeoutMs = 30000 } = {}) {
  let url;
  try { url = wsUrl({ host, port }); }
  catch (e) { return Promise.resolve({ ok: false, error: String(e.message) }); }

  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let resolved = false;
    let closed = false;
    let pending = null;

    const settle = (value) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(connectTimer);
      resolve(value);
    };

    const connectTimer = setTimeout(() => settle({ ok: false, error: '连接识别服务超时' }), timeoutMs);

    const drain = (error) => {
      if (pending) {
        clearTimeout(pending.timer);
        const p = pending;
        pending = null;
        p.resolve({ ok: false, error });
      }
    };

    ws.addEventListener('error', () => {
      if (!resolved) settle({ ok: false, error: '连接识别服务失败（服务未启动？）' });
      else drain('识别服务连接出错');
    });

    ws.addEventListener('close', () => {
      closed = true;
      if (!resolved) settle({ ok: false, error: '识别服务拒绝了连接' });
      else drain('识别服务断开了连接');
    });

    ws.addEventListener('message', (ev) => {
      const m = parseMessage(ev.data);
      if (m.kind === 'signal') {
        // 收到 Done 之类的信号：按协议再问一次
        try { ws.send('Done'); } catch { /* 忽略 */ }
        return;
      }
      if (!pending) return;
      clearTimeout(pending.timer);
      const p = pending;
      pending = null;
      p.resolve({ ok: true, text: m.text ?? '' });
    });

    ws.addEventListener('open', () => {
      settle({
        ok: true,
        send(samples, sampleRate = 16000) {
          if (closed) return Promise.resolve({ ok: false, error: '会话已关闭' });
          if (pending) return Promise.resolve({ ok: false, error: '上一段音频还没返回结果' });
          return new Promise((res) => {
            const t = setTimeout(() => {
              if (pending) { pending = null; res({ ok: false, error: '识别超时' }); }
            }, timeoutMs);
            pending = { resolve: res, timer: t };
            try {
              ws.send(packForServer(samples, sampleRate));
            } catch (e) {
              clearTimeout(t);
              pending = null;
              res({ ok: false, error: '发送音频失败：' + String(e.message) });
            }
          });
        },
        close() {
          try { ws.send('Done'); } catch { /* 忽略 */ }
          try { ws.close(); } catch { /* 忽略 */ }
        },
      });
    });
  });
}

/** 识别单段音频（内部开一次会话，用完即关） */
export async function recognizeSamples(samples, opts = {}) {
  const started = Date.now();
  const session = await openSession(opts);
  if (!session.ok) return { ok: false, error: session.error, elapsedMs: Date.now() - started };
  try {
    const r = await session.send(samples, opts.sampleRate ?? 16000);
    return { ...r, elapsedMs: Date.now() - started };
  } finally {
    session.close();
  }
}

/**
 * 识别一段 wav 字节。长音频按静音切段后逐段识别，共用一条连接，最后拼接。
 * 返回 { ok, text, segments, durationSec, elapsedMs, error }
 */
export async function transcribeWav(buf, { host, port, timeoutMs = 30000, maxSegmentSec = 25 } = {}) {
  let parsed;
  try { parsed = toAsrSamples(buf, 16000); }
  catch (e) { return { ok: false, error: '解析 wav 失败：' + String(e.message) }; }

  // 全是静音就别送了：模型会在静音上编出「嗯」「谢谢」这类幻觉文本
  if (!hasSpeech(parsed.samples, parsed.sampleRate)) {
    return { ok: true, text: '', segments: 0, durationSec: parsed.durationSec, elapsedMs: 0, silent: true };
  }

  const parts = splitOnSilence(parsed.samples, parsed.sampleRate, { maxSec: maxSegmentSec });
  const started = Date.now();
  const session = await openSession({ host, port, timeoutMs });
  if (!session.ok) return { ok: false, error: session.error, durationSec: parsed.durationSec };

  const texts = [];
  try {
    for (const seg of parts) {
      const r = await session.send(seg, parsed.sampleRate);
      if (!r.ok) return { ok: false, error: r.error, durationSec: parsed.durationSec, elapsedMs: Date.now() - started };
      if (r.text) texts.push(r.text);
    }
  } finally {
    session.close();
  }

  const elapsedMs = Date.now() - started;
  log.debug('asr', 'done', { segs: parts.length, chars: texts.join('').length, elapsedMs, durationSec: parsed.durationSec });
  return {
    ok: true,
    text: texts.join('').trim(),
    segments: parts.length,
    durationSec: parsed.durationSec,
    elapsedMs,
  };
}

/** 探测识别服务是否在线（直接发一段极短静音走完整流程） */
export async function probe({ host, port, timeoutMs = 6000 } = {}) {
  const silence = new Float32Array(1600);   // 0.1 秒
  const r = await recognizeSamples(silence, { host, port, timeoutMs });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export function describeTarget(settings) {
  const a = settings?.asr ?? {};
  return { host: a.host || DEFAULT_HOST, port: Number(a.port) || DEFAULT_PORT };
}

export { DEFAULT_PORT, DEFAULT_HOST };

/**
 * 一次性识别，但把完整结果带回来：emotion（情绪）、event（事件，如笑声）、
 * timestamps（逐字时间戳，用来算停顿）、lang。
 *
 * 现有的 transcribeWav 只给文本 —— 学「他说话什么语气、节奏」需要这些额外字段，
 * 所以单独开一个入口，不动原来那条链路。
 */
export async function recognizeFull(samples, sampleRate, { host, port, timeoutMs = 60000 } = {}) {
  let url;
  try { url = wsUrl({ host, port }); } catch (e) { return { ok: false, error: String(e.message) }; }
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } try { ws.close(); } catch { /* 忽略 */ } };
    const timer = setTimeout(() => finish({ ok: false, error: '识别超时' }), timeoutMs);
    ws.addEventListener('error', () => { clearTimeout(timer); finish({ ok: false, error: '连接识别服务失败' }); });
    ws.addEventListener('open', () => {
      try { ws.send(packForServer(samples, sampleRate)); }
      catch (e) { clearTimeout(timer); finish({ ok: false, error: String(e.message) }); }
    });
    ws.addEventListener('message', (ev) => {
      clearTimeout(timer);
      const text = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
      if (text.trim() === 'Done') return;
      let payload;
      try { payload = JSON.parse(text); } catch { finish({ ok: true, text: text.trim(), emotion: '', event: '', timestamps: [] }); return; }
      const clean = (v) => String(v ?? '').replace(/[<>|]/g, '').trim();
      finish({
        ok: true,
        text: pickText(payload),
        emotion: clean(payload.emotion),
        event: clean(payload.event),
        lang: clean(payload.lang),
        timestamps: Array.isArray(payload.timestamps) ? payload.timestamps.map(Number) : [],
      });
    });
  });
}
