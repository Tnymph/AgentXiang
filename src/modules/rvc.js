// 变声（RVC）客户端 + 音色注册表。
//
// 这边的「音色」是一个目录，里面是一整套训练好的 RVC 模型：
//   .tools/rvc-voices/<名字>/model.pth    音色模型（.pth）
//   .tools/rvc-voices/<名字>/model.index  检索索引（可选；有就更像，没有就糊一点）
//   .tools/rvc-voices/<名字>/voice.json   {label, pitch, f0Method, indexRate, protect, sourceVoice}
// 变声只换音色、不换读音，所以必须有个「声源」：默认用 cosy:biaozhun（标准普通话播音音色），
// 先由 CosyVoice 念出标准发音，再让 RVC 换成目标音色。
//
// 转换交给常驻服务（.tools\miniconda3\envs\rvc 的 rvc-api，默认 6012，只监听本机）。
// 这个服务的工作目录必须是 .tools\rvc-work —— 它在当前目录下找 assets\models 里的
// rmvpe.pt / contentvec_base.pt（已预下载，免得在国内连不上 HuggingFace 干等）。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, TOOLS_DIR } from '../paths.js';
import * as log from '../logger.js';
import * as wav from '../wav.js';
import { safeName, insideDir, listVoices as cosyListVoices } from './cosyvoice.js';

export const RVC_VOICE_DIR = path.join(TOOLS_DIR, 'rvc-voices');
export const VOICE_PREFIX = 'rvc:';
export const DEFAULT_PORT = 6012;
const DEFAULT_TIMEOUT = 300000;
const LOAD_TIMEOUT = 300000;

export const META_DEFAULTS = {
  label: '',
  pitch: 0,                    // 半音：女声→女声一般是 0，差一个八度就 ±12
  f0Method: 'rmvpe',
  indexRate: 0.5,              // 检索索引混入比例，越高越像、太高会糊
  protect: 0.33,               // 清辅音保护，防止气声被啃掉
  volumeEnvelope: 1.0,
  sourceVoice: 'cosy:biaozhun', // 声源：必须是一个 CosyVoice 音色
  embedder: 'contentvec_base',
};

export const isRvcId = (id) => String(id ?? '').startsWith(VOICE_PREFIX);
export const stripPrefix = (id) => String(id ?? '').slice(VOICE_PREFIX.length);

/** 服务地址：只有本机 */
export function target(settings) {
  const port = Number(settings?.rvc?.port) || DEFAULT_PORT;
  const host = String(settings?.rvc?.host ?? '127.0.0.1');
  return { host, port };
}

function readMeta(dir, name) {
  let meta = {};
  // 音色目录名已经过 safeName 白名单，这里再走一次 insideDir 把路径钉死在目录里
  const f = insideDir(dir, 'voice.json');
  if (f && fs.existsSync(f)) {
    try {
      meta = JSON.parse(fs.readFileSync(f, 'utf8')) ?? {};
    } catch (e) {
      log.warn('rvc', 'voice.json 读不了，用默认参数', { name, err: String(e.message).slice(0, 80) });
    }
  }
  const pick = (k) => (meta[k] === undefined || meta[k] === null || meta[k] === '' ? META_DEFAULTS[k] : meta[k]);
  return {
    label: String(meta.label ?? ''),
    pitch: Number(pick('pitch')) || 0,
    f0Method: String(pick('f0Method')),
    indexRate: Number(pick('indexRate')),
    protect: Number(pick('protect')),
    volumeEnvelope: Number(pick('volumeEnvelope')),
    sourceVoice: String(pick('sourceVoice')),
    embedder: String(pick('embedder')),
    note: String(meta.note ?? ''),
  };
}

/** 列出本机所有 RVC 音色（目录里有 model.pth 才算） */
export function listVoices(dir = RVC_VOICE_DIR) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (!safeName(e.name).ok) continue;
    const d = path.join(dir, e.name);
    const model = path.join(d, 'model.pth');
    if (!fs.existsSync(model)) continue;
    const index = path.join(d, 'model.index');
    const meta = readMeta(d, e.name);
    out.push({
      id: `${VOICE_PREFIX}${e.name}`,
      engine: 'rvc',
      kind: 'rvc',
      name: e.name,
      label: meta.label,
      dir: d,
      model,
      index: fs.existsSync(index) ? index : '',
      modelMB: Number((fs.statSync(model).size / 1048576).toFixed(1)),
      indexMB: fs.existsSync(index) ? Number((fs.statSync(index).size / 1048576).toFixed(1)) : 0,
      pitch: meta.pitch,
      f0Method: meta.f0Method,
      indexRate: meta.indexRate,
      protect: meta.protect,
      volumeEnvelope: meta.volumeEnvelope,
      sourceVoice: meta.sourceVoice,
      embedder: meta.embedder,
      note: meta.note,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** 按 id 找一个音色（也接受不带前缀的名字） */
export function find(id, dir = RVC_VOICE_DIR) {
  const name = isRvcId(id) ? stripPrefix(id) : String(id ?? '');
  if (!safeName(name).ok) return null;
  return listVoices(dir).find((v) => v.name === name) ?? null;
}

/**
 * 改一个变声音色的参数（写回 voice.json）。变声参数得靠耳朵调，所以界面要能直接改。
 * 只认几个数值型字段；换模型这种事就自己往目录里放文件。
 */
export function saveMeta(id, patch = {}, dir = RVC_VOICE_DIR) {
  const name = isRvcId(id) ? stripPrefix(id) : String(id ?? '');
  if (!safeName(name).ok) return { ok: false, error: '音色名不合法' };
  const d = insideDir(dir, name);
  if (!d || !fs.existsSync(path.join(d, 'model.pth'))) return { ok: false, error: `找不到变声音色 ${name}` };

  const cur = readMeta(d, name);
  const next = { ...cur, name };
  if (patch.pitch !== undefined) {
    const v = Number(patch.pitch);
    if (!Number.isFinite(v) || v < -24 || v > 24) return { ok: false, error: '音高要在 -24 ~ 24 个半音之间' };
    next.pitch = Math.round(v);
  }
  if (patch.indexRate !== undefined) {
    const v = Number(patch.indexRate);
    if (!Number.isFinite(v) || v < 0 || v > 1) return { ok: false, error: '索引比例要在 0 ~ 1 之间' };
    next.indexRate = v;
  }
  if (patch.protect !== undefined) {
    const v = Number(patch.protect);
    if (!Number.isFinite(v) || v < 0 || v > 0.5) return { ok: false, error: '清辅音保护要在 0 ~ 0.5 之间' };
    next.protect = v;
  }
  if (patch.sourceVoice !== undefined) {
    const v = String(patch.sourceVoice).trim();
    if (!/^cosy:[A-Za-z0-9_-]{2,32}$/.test(v)) return { ok: false, error: '声源要写成 cosy:名字（必须是个 CosyVoice 音色）' };
    if (!listSourceCandidates().includes(v)) return { ok: false, error: `没有这个声源音色：${v}` };
    next.sourceVoice = v;
  }

  const metaFile = insideDir(d, 'voice.json');
  if (!metaFile) return { ok: false, error: '音色路径不合法' };
  fs.writeFileSync(metaFile, JSON.stringify(next, null, 2) + '\n', 'utf8');
  log.info('rvc', 'meta saved', { voice: name, pitch: next.pitch, indexRate: next.indexRate, sourceVoice: next.sourceVoice });
  return { ok: true, voice: listVoices(dir).find((v) => v.name === name) ?? null };
}

/** 可以当声源的音色（CosyVoice 那一批的音色 id） */
export function listSourceCandidates() {
  return cosyListVoices().map((v) => v.id);
}

/** 服务在不在、模型齐不齐 */
export async function probe(settings) {
  const { host, port } = target(settings);
  const missing = ['rmvpe.pt', 'contentvec_base.pt']
    .filter((f) => !fs.existsSync(path.join(TOOLS_DIR, 'rvc-work', 'assets', 'models', f)));
  const base = { host, port, models: missing.length === 0, missing, voices: listVoices().length };
  try {
    const r = await fetch(`http://${host}:${port}/api/v1/health`, { signal: AbortSignal.timeout(4000) });
    const j = await r.json().catch(() => ({}));
    // 只认这个服务自己的应答形状：本机别的程序（比如 QQ 的 6099）也会回 200，
    // 光看状态码会把别人的服务当成自己的。
    const mine = j.status === 'healthy' || typeof j.models_loaded === 'number';
    if (!mine) {
      return { ...base, ok: false, error: `端口 ${port} 上不是变声服务（应答 ${r.status}）`, service: null, device: null };
    }
    return {
      ...base, ok: true, service: j,
      device: j.device ?? null, loaded: Number(j.models_loaded ?? 0),
    };
  } catch (e) {
    return { ...base, ok: false, error: String(e.message).slice(0, 80), device: null };
  }
}

/**
 * 把一段音频换成目标音色。输入/输出都必须落在项目目录里（本机服务，但别开成任意文件读写的口子）。
 * 返回 { ok, path, seconds, ms, voice } 或 { ok:false, error }
 */
export async function convert(inputPath, {
  voiceId = '', settings = null, timeoutMs = DEFAULT_TIMEOUT, root = ROOT, outPath = '',
} = {}) {
  const voice = find(voiceId);
  if (!voice) return { ok: false, error: `找不到变声音色 ${voiceId}` };

  const rootAbs = path.resolve(root);
  const src = path.resolve(rootAbs, String(inputPath ?? ''));
  if (!(src === rootAbs || src.startsWith(rootAbs + path.sep))) {
    return { ok: false, error: '要转换的音频必须在项目目录里' };
  }
  if (!fs.existsSync(src)) return { ok: false, error: `要转换的音频不存在：${src}` };

  const { host, port } = target(settings);
  const base = `http://${host}:${port}`;
  const t0 = Date.now();

  // 1) 先让服务把模型载入（同一路径重复载入是幂等的，直接调最省事）
  let modelId = '';
  try {
    const r = await fetch(`${base}/api/v1/models/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_path: voice.model }),
      signal: AbortSignal.timeout(LOAD_TIMEOUT),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { ok: false, error: `变声服务载入模型失败 HTTP ${r.status}：${body.slice(0, 160)}` };
    }
    modelId = (await r.json()).model_id ?? '';
  } catch (e) {
    log.warn('rvc', '服务调用失败', { err: String(e.message).slice(0, 120), host, port });
    return { ok: false, error: `变声服务没响应（${host}:${port}）` };
  }
  if (!modelId) return { ok: false, error: '变声服务没给出 model_id' };

  // 2) 转换；服务把结果写在输入文件旁边（<名字>_converted.wav）
  //    注意是 /convert/file：不带 /file 的那个要 multipart 上传音频，会 422
  let out = '';
  try {
    const r = await fetch(`${base}/api/v1/convert/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_id: modelId,
        input_path: src,
        output_format: 'wav',
        pitch: voice.pitch,
        f0_method: voice.f0Method,
        index_path: voice.index || null,
        index_rate: voice.indexRate,
        protect: voice.protect,
        volume_envelope: voice.volumeEnvelope,
        embedder_model: voice.embedder,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { ok: false, error: `变声失败 HTTP ${r.status}：${body.slice(0, 200)}` };
    }
    out = String((await r.json()).output_path ?? '');
  } catch (e) {
    return { ok: false, error: `变声超时或断线：${String(e.message).slice(0, 120)}` };
  }
  if (!out) return { ok: false, error: '变声服务没有输出文件' };
  if (!(out === rootAbs || out.startsWith(rootAbs + path.sep))) {
    return { ok: false, error: '变声服务的输出跑到项目目录外了，不要用' };
  }
  if (!fs.existsSync(out)) return { ok: false, error: `变声输出不存在：${out}` };

  const dest = outPath || out;
  if (dest !== out) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(out, dest);
  }
  const info = wav.headerInfo(fs.readFileSync(dest).subarray(0, 64));
  const size = fs.statSync(dest).size;
  const ms = Date.now() - t0;
  log.info('rvc', 'ok', { voice: voice.name, in: path.basename(src), ms, size, rate: info.sampleRate });
  return {
    ok: true, path: dest, size, ms, engine: 'rvc', kind: 'rvc',
    voice: `${VOICE_PREFIX}${voice.name}`,
    sampleRate: info.sampleRate,
    seconds: wav.durationSec(info, size),
  };
}
