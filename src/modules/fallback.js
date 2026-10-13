// 默认回复（兜底）：一个池子 + 按场景选择使用
//
// 场景清单与确认书一致；「不回复的类型」用 scene='none' 表示。
// 任一场景下若没有任何启用的条目 => 完全静默（不回话）。
import * as db from '../db.js';

export const SCENES = ['api_off', 'video', 'file', 'card', 'location', 'voice', 'other'];
export const SCENE_LABEL = {
  api_off: '未接入 API 时',
  video: '视频',
  file: '文件',
  card: '链接卡片',
  location: '位置',
  voice: '语音条',
  other: '其他无法处理',
};

/** 各场景的开箱默认话（可在界面上改） */
const SEED = {
  api_off: ['我现在脑袋不太灵光，等会儿再聊', '这会儿接不上线，回头说'],
  video: ['视频我打不开，你说给我听吧', '看不了视频，说文字吧'],
  file: ['文件我收不到，你直接说吧', '文件打不开，内容讲一下？'],
  card: ['这种卡片我点不开', '卡片我打不开，你说说是什么'],
  location: ['位置我看不了', '我看不到位置，你描述一下'],
  voice: ['语音我暂时听不了，打字吧', '听不了语音，发文字吧'],
  other: ['这个我处理不了', '这条我看不懂，换个方式？'],
};

/** 首次运行时铺一遍默认条目 */
export function seedDefaults(botId) {
  const n = db.one('select count(*) as c from fallback_replies where bot_id = ?', botId);
  if (Number(n?.c ?? 0) > 0) return 0;
  const t = Date.now();
  let count = 0;
  for (const scene of SCENES) {
    for (const text of SEED[scene] ?? []) {
      db.run('insert into fallback_replies (bot_id, scene, text, enabled, is_fixed, created_at) values (?,?,?,?,?,?)',
        botId, scene, text, 1, 0, t);
      count++;
    }
  }
  return count;
}

export function listFor(botId, scene) {
  return db.all('select * from fallback_replies where bot_id = ? and scene = ? order by id', botId, scene);
}

export function listAll(botId) {
  return db.all('select * from fallback_replies where bot_id = ? order by scene, id', botId);
}

export function addReply(botId, scene, text) {
  if (!SCENES.includes(scene)) throw new Error('非法场景');
  db.run('insert into fallback_replies (bot_id, scene, text, enabled, is_fixed, created_at) values (?,?,?,?,?,?)',
    botId, scene, String(text), 1, 0, Date.now());
}

export function updateReply(id, { text, enabled, isFixed }) {
  if (text !== undefined) db.run('update fallback_replies set text = ? where id = ?', String(text), id);
  if (enabled !== undefined) db.run('update fallback_replies set enabled = ? where id = ?', enabled ? 1 : 0, id);
  if (isFixed) {
    // 每场景至多一条固定
    const row = db.one('select bot_id, scene from fallback_replies where id = ?', id);
    if (row) {
      db.run('update fallback_replies set is_fixed = 0 where bot_id = ? and scene = ?', row.bot_id, row.scene);
    }
    db.run('update fallback_replies set is_fixed = 1 where id = ?', id);
  }
}

export function removeReply(id) {
  db.run('delete from fallback_replies where id = ?', id);
}

/**
 * 取一条该场景的默认回复。
 * 固定条目优先；否则从启用的里随机；都没有则返回 null（完全静默）。
 */
export function pickReply(botId, scene, random = Math.random) {
  const rows = listFor(botId, scene).filter((r) => Number(r.enabled) === 1);
  if (rows.length === 0) return null;
  const fixed = rows.find((r) => Number(r.is_fixed) === 1);
  if (fixed) return fixed.text;
  const idx = Math.floor(random() * rows.length) % rows.length;
  return rows[idx].text;
}

// ---------- 冷却 ----------

const lastSent = new Map();   // `${botId}:${personId}` -> ts

/** 同一个人在该冷却时间内只回一次默认回复 */
export function allowCooldown(botId, personId, settings, now = Date.now()) {
  const sec = settings?.fallback?.cooldownSec ?? 30;
  const key = `${botId}:${personId}`;
  const prev = lastSent.get(key) ?? 0;
  if (now - prev < sec * 1000) {
    return { ok: false, retryInSec: Math.ceil((sec * 1000 - (now - prev)) / 1000) };
  }
  lastSent.set(key, now);
  return { ok: true };
}

export function resetCooldown() {
  lastSent.clear();
}
