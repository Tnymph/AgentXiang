// 音色的统一入口：把三个引擎的音色放在一个清单里。
//
// 设计要点：**音色决定引擎** —— 选到 `cosy:xxx` 就走 CosyVoice2，选到 `rvc:xxx` 就先让
// CosyVoice 用标准普通话念出来、再用 RVC 换成目标音色，选到别名的就走 sherpa，
// 所以「切换引擎」等于换一个音色 id，不用再单独维护一个引擎开关。
import * as tts from './tts.js';
import * as cosy from './cosyvoice.js';
import * as rvc from './rvc.js';

/** 全部音色（新引擎的排前面：变声 → CosyVoice → sherpa） */
export function listAll() {
  const sherpa = tts.listVoices().map((v) => ({
    ...v,
    // 老引擎两种：克隆（zipvoice）/ 固定音色（vits）
    engine: v.kind === 'zipvoice' ? 'zipvoice' : 'vits',
  }));
  return [...rvc.listVoices(), ...cosy.listVoices(), ...sherpa];
}

export function find(id) {
  return listAll().find((v) => v.id === String(id ?? '')) ?? null;
}

/** 这个音色用哪个引擎；找不到就按「老引擎」处理（保持老行为） */
export function engineOf(id) {
  if (rvc.isRvcId(id)) return 'rvc';
  if (cosy.isCosyId(id)) return 'cosyvoice';
  return find(id)?.engine ?? 'zipvoice';
}

/** 变声音色的声源（先由它把字念标准，再变声）；声源本身必须是 CosyVoice 音色 */
export function sourceOf(id) {
  const v = rvc.find(id);
  return v?.sourceVoice || rvc.META_DEFAULTS.sourceVoice;
}

/**
 * 用指定音色合一句。参数透传，返回形状三个引擎一致：
 * { ok, path, seconds, ms, voice, engine, sampleRate }
 */
export async function synthesizeAny(text, opts = {}) {
  const engine = engineOf(opts.voiceId);
  if (engine === 'cosyvoice') {
    // CosyVoice 自己的韵律就够好，不需要「逐句补停顿」那套（那会让每句都重算一次，很贵）；
    // 语速由 speed 控制。
    const { pauseMs, sid, quality, ...rest } = opts;
    return cosy.synthesize(text, rest);
  }
  if (engine === 'rvc') {
    // 两步：先标准普通话念一遍，再变声。变声只换音色不换读音，所以声源用固定的标准音色。
    const { pauseMs, sid, quality, ...rest } = opts;
    const spoken = await cosy.synthesize(text, { ...rest, voiceId: sourceOf(opts.voiceId) });
    if (!spoken.ok) return spoken;
    const conv = await rvc.convert(spoken.path, { ...rest, voiceId: opts.voiceId });
    if (!conv.ok) {
      // 变声没成功就把声源那段直接用掉：宁可音色不对，也别让这条回复没声音
      return { ...spoken, engine: 'rvc', voice: opts.voiceId, convertError: conv.error };
    }
    return { ...conv, spokenMs: spoken.ms, sourceVoice: sourceOf(opts.voiceId) };
  }
  return tts.synthesize(text, opts);
}

export { cosy, rvc };
