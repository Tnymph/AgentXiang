// 从另一个机器人复制配置
//
// 多机器人时最烦的是重复劳动：时段表、名单、限流阈值每个号都要配一遍。
// 这个模块把这些「不涉及个人隐私」的配置整块搬过去。
//
// 刻意不复制的东西：记忆、印象、风格卡、密钥 —— 那些是两个号之所以是两个号的原因。
import * as db from '../db.js';
import * as log from '../logger.js';
import { botSettings, saveBotSettings } from '../config.js';

/** 可复制的部分 */
export const COPYABLE = [
  { key: 'schedule', label: '时段方案', desc: '三个方案的时间段与当前生效的那个' },
  { key: 'lists', label: '名单', desc: '用户/群 × 接收/回复，含黑白名单模式' },
  { key: 'fallback', label: '默认回复', desc: '各场景的兜底话术与启用状态' },
  { key: 'pickup', label: '接话', desc: '触发词与要接的话（含模式、冷却）' },
  { key: 'speaking', label: '发言与复读频控', desc: '发言模式、字数上限、复读参数、限流阈值' },
  { key: 'admins', label: '管理员', desc: '能用聊天命令的 QQ 号' },
  { key: 'api', label: 'API 设置', desc: '接入模式、思考档位、识别开关（不含密钥）' },
];

const VALID = new Set(COPYABLE.map((x) => x.key));

function copySchedule(from, to) {
  db.run('delete from schedules where bot_id = ?', to);
  for (const s of db.all('select * from schedules where bot_id = ? order by slot_no', from)) {
    db.run('insert into schedules (bot_id, slot_no, name, ranges, is_active) values (?,?,?,?,?)',
      to, s.slot_no, s.name, s.ranges, s.is_active);
  }
  // 当前生效的方案编号也要一起搬
  const src = botSettings(from);
  saveBotSettings(to, { schedule: src.schedule });
}

function copyLists(from, to) {
  db.run('delete from list_entries where bot_id = ?', to);
  for (const r of db.all('select * from list_entries where bot_id = ?', from)) {
    db.run('insert into list_entries (bot_id, scope, direction, mode, target, created_at) values (?,?,?,?,?,?)',
      to, r.scope, r.direction, r.mode, r.target, Date.now());
  }
}

function copyFallback(from, to) {
  db.run('delete from fallback_replies where bot_id = ?', to);
  for (const r of db.all('select * from fallback_replies where bot_id = ?', from)) {
    db.run('insert into fallback_replies (bot_id, scene, text, enabled, is_fixed, created_at) values (?,?,?,?,?,?)',
      to, r.scene, r.text, r.enabled, r.is_fixed, Date.now());
  }
}

function copySpeaking(from, to) {
  const src = botSettings(from);
  saveBotSettings(to, {
    speak: src.speak,
    rate: src.rate,
    repeatEcho: src.repeatEcho,
    context: src.context,
    fallback: src.fallback,
    pickup: src.pickup,
  });
}

function copyPickup(from, to) {
  db.run('delete from pickup_rules where bot_id = ?', to);
  for (const r of db.all('select * from pickup_rules where bot_id = ?', from)) {
    db.run(`insert into pickup_rules
      (bot_id, pattern, match, reply, mode, enabled, cooldown_sec, hits, last_hit_at, created_at)
      values (?,?,?,?,?,?,?,0,0,?)`,
      to, r.pattern, r.match, r.reply, r.mode, r.enabled, r.cooldown_sec, Date.now());
  }
}

function copyAdmins(from, to) {
  db.run('delete from admins where bot_id = ?', to);
  for (const r of db.all('select qq from admins where bot_id = ?', from)) {
    db.run('insert or replace into admins (bot_id, qq, added_at) values (?,?,?)', to, r.qq, Date.now());
  }
}

function copyApi(from, to) {
  const src = botSettings(from);
  // 只搬设置，不搬密钥：密钥存在独立的密钥库里，复制它等于把凭据再写一份
  saveBotSettings(to, { api: { ...src.api } });
}

const HANDLERS = {
  schedule: copySchedule,
  lists: copyLists,
  fallback: copyFallback,
  pickup: copyPickup,
  speaking: copySpeaking,
  admins: copyAdmins,
  api: copyApi,
};

/**
 * 把 from 的指定部分复制到 to。
 * 返回 { ok, copied: [...], skipped: [...] }
 */
export function copyConfig(fromBotId, toBotId, parts) {
  if (fromBotId === toBotId) return { ok: false, error: '源和目标不能是同一个机器人' };
  if (!db.getBot(fromBotId)) return { ok: false, error: '源机器人不存在' };
  if (!db.getBot(toBotId)) return { ok: false, error: '目标机器人不存在' };

  const want = (parts ?? []).filter((p) => VALID.has(p));
  if (want.length === 0) return { ok: false, error: '没有选中任何要复制的部分' };

  db.tx(() => {
    for (const p of want) HANDLERS[p](fromBotId, toBotId);
  });

  log.info('clone', 'config copied', { from: fromBotId, to: toBotId, parts: want });
  return { ok: true, copied: want };
}
