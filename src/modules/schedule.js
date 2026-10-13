// 时段方案：每天的时间段 + 三个（可加）方案空位，切换立即生效
import * as db from '../db.js';
import * as log from '../logger.js';

const DAY_MINUTES = 1440;
const HM_RE = /^(\d{1,2}):(\d{2})$/;

/** "23:30" -> 1410；"24:00" -> 1440；非法返回 null */
export function parseHm(s) {
  const m = String(s ?? '').trim().match(HM_RE);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (mi > 59) return null;
  const total = h * 60 + mi;
  if (total > DAY_MINUTES) return null;
  return total;
}

/** "23:30-03:10" -> { start, end }；支持跨零点 */
export function parseRange(text) {
  const parts = String(text ?? '').split(/[-~—]/).map((x) => x.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  const start = parseHm(parts[0]);
  const end = parseHm(parts[1]);
  if (start === null || end === null) return null;
  return { start, end };
}

/** 某个时刻（当天第几分钟）是否落在区间内；end <= start 视为跨零点 */
export function isInRange(range, minutes) {
  if (!range) return false;
  const { start, end } = range;
  if (start === end) return false;                 // 零长度区间无效
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;        // 跨零点
}

export function isInAnyRange(ranges, minutes) {
  return (ranges ?? []).some((r) => isInRange(r, minutes));
}

/** 当前时刻是当天第几分钟 */
export function minutesOfDay(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

/** 从库里的 ranges JSON 解析成区间数组（容错） */
export function parseRanges(json) {
  let arr = [];
  try { arr = JSON.parse(json || '[]'); } catch { arr = []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((r) => (typeof r === 'string' ? parseRange(r) : r))
    .filter((r) => r && Number.isFinite(r.start) && Number.isFinite(r.end));
}

/** 列出某机器人的所有时段方案 */
export function listSlots(botId) {
  return db.all('select * from schedules where bot_id = ? order by slot_no', botId);
}

/** 取当前生效方案的区间数组 */
export function activeRanges(botId, settings) {
  const slotNo = settings?.schedule?.activeSlot ?? 1;
  const row = db.one('select * from schedules where bot_id = ? and slot_no = ?', botId, slotNo);
  if (!row) return { slotNo, name: '', ranges: [] };
  return { slotNo, name: row.name, ranges: parseRanges(row.ranges) };
}

/** 切到某个方案（立即生效：不做缓存，每次判断都重新读） */
export function switchSlot(botId, slotNo) {
  db.run('update schedules set is_active = case when slot_no = ? then 1 else 0 end where bot_id = ?', slotNo, botId);
  log.info('schedule', 'slot switched', { botId, slotNo });
}

/** 确保至少存在三个方案空位 */
export function ensureSlots(botId, count = 3) {
  const existing = listSlots(botId);
  for (let i = 1; i <= count; i++) {
    if (!existing.some((s) => s.slot_no === i)) {
      db.run('insert into schedules (bot_id, slot_no, name, ranges, is_active) values (?,?,?,?,?)',
        botId, i, `方案${i}`, '[]', i === 1 ? 1 : 0);
    }
  }
}

/**
 * API 是否应当接入。
 * 三态手动覆盖优先：force_on / force_off / auto（按时段）。
 * 返回 { active, reason }，reason 用于日志与界面展示。
 */
export function isApiActive(botId, settings, now = new Date()) {
  const mode = settings?.api?.mode ?? 'auto';
  if (mode === 'force_on') return { active: true, reason: '强制开启' };
  if (mode === 'force_off') return { active: false, reason: '强制关闭' };

  const { slotNo, ranges } = activeRanges(botId, settings);
  if (ranges.length === 0) return { active: false, reason: `方案${slotNo}未配置时段` };

  const m = minutesOfDay(now);
  const hit = isInAnyRange(ranges, m);
  return {
    active: hit,
    reason: hit ? `方案${slotNo}时段内` : `方案${slotNo}时段外`,
    minutes: m,
  };
}
