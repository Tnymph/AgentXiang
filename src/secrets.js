// 密钥存储：API Key 独立于普通配置，单独加密落盘
//
// 保护策略
//  - Windows：DPAPI（CurrentUser 作用域）加密。文件被拷到别的机器或别的用户下都解不开。
//  - 其他平台：退化为带权限位的明文文件，并在日志里明确告警，不假装安全。
//
// 安全约定
//  - 明文只经 stdin/stdout 传给 PowerShell，绝不拼接进命令行（否则会出现在进程列表里）。
//  - 读出的密钥会注册进 logger 的打码表，日志里永远不会出现原文。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SECRETS_FILE, DATA_DIR } from './paths.js';
import * as log from './logger.js';

const IS_WIN = process.platform === 'win32';

// ---------- PowerShell 桥（固定脚本，无任何插值） ----------

const PS_ENCRYPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
[Console]::Out.Write([Convert]::ToBase64String($enc))
`;

const PS_DECRYPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$b64 = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($b64.Trim())
$dec = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($dec))
`;

function runPs(script, stdin, timeoutMs = 20000) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: stdin ?? '',
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    ok: r.status === 0,
    out: (r.stdout ?? '').trim(),
    err: (r.stderr ?? '').trim(),
  };
}

// ---------- 加解密 ----------

export function dpapiAvailable() {
  if (!IS_WIN) return false;
  const r = runPs(PS_ENCRYPT, 'probe');
  return r.ok && r.out.length > 0;
}

export function encryptBuf(plain) {
  if (!IS_WIN) return null;
  const r = runPs(PS_ENCRYPT, plain);
  if (!r.ok) throw new Error('DPAPI 加密失败: ' + (r.err || '未知错误'));
  return r.out;
}

export function decryptBuf(b64) {
  if (!IS_WIN) return null;
  const r = runPs(PS_DECRYPT, b64);
  if (!r.ok) throw new Error('DPAPI 解密失败: ' + (r.err || '未知错误'));
  return r.out;
}

// ---------- 读写 ----------

/** 秘密文件的结构 */
function emptySecrets() {
  return { version: 1, encrypted: IS_WIN, bots: {} };
}

let cache = null;

export function loadSecrets() {
  if (cache) return cache;
  if (!fs.existsSync(SECRETS_FILE)) {
    cache = emptySecrets();
    return cache;
  }
  let text;
  try {
    const raw = fs.readFileSync(SECRETS_FILE, 'utf8');
    if (IS_WIN) {
      text = decryptBuf(raw);
      if (text === null) throw new Error('无法解密');
    } else {
      text = raw;
      log.warn('secrets', '非 Windows 平台：密钥以明文存放，仅靠文件权限保护');
    }
    cache = JSON.parse(text);
    if (!cache.bots) cache.bots = {};
  } catch (e) {
    log.error('secrets', '密钥文件读取失败，按空处理', String(e.message));
    cache = emptySecrets();
  }
  registerAll(cache);
  return cache;
}

function registerAll(secrets) {
  log.clearSecrets();
  for (const v of Object.values(secrets.bots ?? {})) {
    if (v?.apiKey) log.registerSecret(v.apiKey);
    if (v?.accessToken) log.registerSecret(v.accessToken);
  }
}

export function saveSecrets() {
  if (!cache) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const text = JSON.stringify(cache);
  if (IS_WIN) {
    const b64 = encryptBuf(text);
    if (b64 === null) throw new Error('DPAPI 不可用，拒绝以明文写入密钥');
    fs.writeFileSync(SECRETS_FILE, b64, 'utf8');
  } else {
    fs.writeFileSync(SECRETS_FILE, text, { encoding: 'utf8', mode: 0o600 });
  }
  registerAll(cache);
  log.info('secrets', 'saved', { encrypted: IS_WIN });
}

// ---------- 对外接口 ----------

export function getApiKey(botId) {
  const s = loadSecrets();
  return s.bots?.[String(botId)]?.apiKey ?? '';
}

export function setApiKey(botId, key) {
  const s = loadSecrets();
  const id = String(botId);
  if (!s.bots[id]) s.bots[id] = {};
  s.bots[id].apiKey = String(key ?? '').trim();
  saveSecrets();
}

/** 重置：先清空再改，与界面上的「只能重置后修改」对应 */
export function resetApiKey(botId) {
  const s = loadSecrets();
  const id = String(botId);
  if (s.bots?.[id]) delete s.bots[id].apiKey;
  saveSecrets();
  log.info('secrets', 'api key reset', { botId });
}

export function hasApiKey(botId) {
  return getApiKey(botId).length > 0;
}

/** 供界面显示的掩码，绝不返回原文 */
export function maskedApiKey(botId) {
  const k = getApiKey(botId);
  return k ? log.maskTail(k) : '';
}

export function getAccessToken() {
  return loadSecrets().bots?.__global?.accessToken ?? '';
}

export function setAccessToken(token) {
  const s = loadSecrets();
  if (!s.bots.__global) s.bots.__global = {};
  s.bots.__global.accessToken = String(token ?? '').trim();
  saveSecrets();
}

// ---- 搜索密钥（联网搜索用；全局一份，不属于任何单个机器人）----

export function getSearchKey() {
  return loadSecrets().bots?.__global?.searchKey ?? '';
}

export function setSearchKey(key) {
  const s = loadSecrets();
  if (!s.bots.__global) s.bots.__global = {};
  s.bots.__global.searchKey = String(key ?? '').trim();
  saveSecrets();
}

export function resetSearchKey() {
  const s = loadSecrets();
  if (s.bots?.__global) s.bots.__global.searchKey = '';
  saveSecrets();
}

export function hasSearchKey() {
  return !!getSearchKey();
}

/** 供界面显示的掩码，绝不返回原文 */
export function maskedSearchKey() {
  const k = getSearchKey();
  return k ? log.maskTail(k) : '';
}
