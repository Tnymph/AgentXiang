// 日志：system.log（运行/连接/报错）与 chat.log（对话流水）分开，按日滚动
// 所有输出都过一次打码，密钥永不落盘
import fs from 'node:fs';
import path from 'node:path';
import { LOGS_DIR, INBOX_LOGS } from './paths.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel = LEVELS.info;
const streams = new Map();       // name -> { date, stream }
const registeredSecrets = new Set();

// ---------- 路径安全 ----------

/**
 * 把单个文件名片段拼进根目录，并确认结果没有越界。
 * 只接受不含路径分隔符的纯文件名，杜绝 ../ 之类的穿越。
 */
export function safeJoin(root, fragment, suffix = '') {
  const name = String(fragment) + suffix;
  if (name !== path.basename(name) || name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new Error(`非法文件名: ${name}`);
  }
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, name);
  if (target !== rootAbs && !target.startsWith(rootAbs + path.sep)) {
    throw new Error(`路径越界: ${name}`);
  }
  return target;
}

// ---------- 打码 ----------

/** 注册一个需要永久打码的字符串（密钥、cookie 等） */
export function registerSecret(value) {
  if (typeof value === 'string' && value.trim().length >= 8) {
    registeredSecrets.add(value.trim());
  }
}

/** 清空已注册的密钥（如重置 key 后） */
export function clearSecrets() {
  registeredSecrets.clear();
}

/** 对任意文本打码：已注册密钥 + 常见 key 形态 */
export function mask(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const s of registeredSecrets) {
    out = out.split(s).join(maskTail(s));
  }
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, (m) => maskTail(m));
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, (_m, p1) => p1 + '****');
  return out;
}

/** 只保留尾部若干位，其余打星 */
export function maskTail(secret) {
  const s = String(secret);
  if (s.length <= 4) return '****';
  return s.slice(0, 3) + '****' + s.slice(-4);
}

// ---------- 基础 ----------

export function setDebug(on) {
  minLevel = on ? LEVELS.debug : LEVELS.info;
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function streamFor(name) {
  const date = today();
  let s = streams.get(name);
  if (s && s.date !== date) {
    try { s.stream.end(); } catch { /* 忽略 */ }
    streams.delete(name);
    s = null;
  }
  if (!s) {
    const file = safeJoin(LOGS_DIR, name, `-${date}.log`);
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    s = { date, stream: fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' }) };
    streams.set(name, s);
  }
  return s;
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function emit(name, line) {
  try {
    streamFor(name).stream.write(mask(line) + '\n');
  } catch { /* 日志失败不能影响主流程 */ }
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

// ---------- 对外接口 ----------

/** 写一条系统日志 */
export function log(level, module, event, detail) {
  if ((LEVELS[level] ?? LEVELS.info) < minLevel) return;
  let tail = '';
  if (detail !== undefined && detail !== null) {
    tail = typeof detail === 'string' ? detail : safeJson(detail);
  }
  const line = `${stamp()} [${level.toUpperCase().padEnd(5)}] ${module} | ${event}` +
    (tail ? ` | ${tail}` : '');
  emit('system', line);
  // 控制台同样要打码：终端回滚、重定向、CI 日志都会留痕
  const shown = mask(line);
  if (LEVELS[level] >= LEVELS.warn) console.error(shown);
  else console.log(shown);
}

export const debug = (m, e, d) => log('debug', m, e, d);
export const info = (m, e, d) => log('info', m, e, d);
export const warn = (m, e, d) => log('warn', m, e, d);
export const error = (m, e, d) => log('error', m, e, d);

/** 写一条对话流水（谁说了什么、机器人回了什么、走了哪个分支） */
export function chat(entry) {
  const {
    bot = '-', session = '-', direction = 'in', who = '-',
    text = '', branch = '', extra = '',
  } = entry || {};
  const line = `${stamp()} bot=${bot} session=${session} ${direction} who=${who}` +
    (branch ? ` branch=${branch}` : '') +
    ` | ${String(text).replace(/\r?\n/g, ' ')}` +
    (extra ? ` | ${extra}` : '');
  emit('chat', line);
}

/** 记录一次 API 用量（用于界面上的命中率与省钱面板） */
export function usage(entry) {
  emit('usage', `${stamp()} ${safeJson(entry)}`);
}

/** 关闭所有日志流（进程退出前调用） */
export function closeLogs() {
  for (const s of streams.values()) {
    try { s.stream.end(); } catch { /* 忽略 */ }
  }
  streams.clear();
}

/** 列出可导出的日志文件（只返回纯文件名，已校验） */
export function listLogFiles(days = 30) {
  if (!fs.existsSync(LOGS_DIR)) return [];
  const cutoff = Date.now() - days * 86400_000;
  return fs.readdirSync(LOGS_DIR)
    .filter((f) => f.endsWith('.log'))
    .sort()
    .map((f) => ({ name: f, full: safeJoin(LOGS_DIR, f) }))
    .filter((x) => {
      try { return fs.statSync(x.full).mtimeMs >= cutoff; } catch { return false; }
    });
}

/** 把指定天数内的日志汇总成单个文件，返回文件路径 */
export function exportLogBundle(days = 30) {
  const files = listLogFiles(days);
  const parts = [];
  for (const f of files) {
    parts.push(`\n########## ${f.name} ##########\n`);
    parts.push(mask(fs.readFileSync(f.full, 'utf8')));
  }
  fs.mkdirSync(INBOX_LOGS, { recursive: true });
  const outFile = safeJoin(INBOX_LOGS, `agentxiang-logs-${today()}.txt`);
  fs.writeFileSync(outFile, parts.join(''), 'utf8');
  return outFile;
}
