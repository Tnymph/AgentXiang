// 文本相同判定：三档模式，复读检测与频控的「重复」判断共用同一档设置

/** 全角转半角（含表意空格） */
export function toHalfWidth(s) {
  return String(s)
    .replace(/\u3000/g, ' ')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

/** 去掉不可见字符（零宽、变体选择符、控制符） */
export function stripInvisible(s) {
  return String(s).replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFE00-\uFE0F]/g, '');
}

const PUNCT = /[\s!-/:-@\[-`{-~\u3000-\u303F\uFF01-\uFF65·—…“”‘’《》〈〉【】、。，！？；：（）]/g;

/**
 * 按档位规范化文本
 *  strict   —— 一字不差
 *  loose    —— 去首尾空白 + 全角半角归一 + 去不可见 + 忽略大小写
 *  loosest  —— 在 loose 基础上再去掉所有空白与标点
 */
export function normalize(text, mode = 'loose') {
  const raw = String(text ?? '');
  if (mode === 'strict') return raw;
  let out = toHalfWidth(out0(raw));
  if (mode === 'loosest') out = out.replace(PUNCT, '');
  else out = out.trim();
  return out;
}

function out0(raw) {
  return stripInvisible(raw).trim().toLowerCase();
}

/** 两段文本在该档位下是否算相同 */
export function sameText(a, b, mode = 'loose') {
  const x = normalize(a, mode);
  const y = normalize(b, mode);
  if (!x || !y) return false;
  return x === y;
}

/** 档位是否合法 */
export function isValidMode(mode) {
  return mode === 'strict' || mode === 'loose' || mode === 'loosest';
}
