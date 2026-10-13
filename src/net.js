// 网络层：统一的 URL 安全校验 + 带限额的请求
//
// 两类 URL 分开对待，这是有意为之：
//
//  1) 来源不可信的 URL（QQ 消息里的图片/语音链接、合并转发里的链接）
//     —— 用 assertRemoteUrl()：只允许 http/https，且必须解析到公网地址。
//        这是防 SSRF 的主战场：伪造的链接可能指向内网服务。
//
//  2) 管理员在界面里自己填的服务端点（模型 baseUrl、NapCat 的 ws 地址）
//     —— 用 assertEndpoint()：只允许 http/https/ws/wss。
//        这里刻意放行本地与私有地址，因为本项目的部署模型就是
//        「NapCat 跑在 127.0.0.1」「可能接本地模型」，一律拒绝会让程序无法工作。
//        端点来自管理员配置而非攻击者输入，风险归属不同。
import dns from 'node:dns/promises';
import net from 'node:net';
import * as log from './logger.js';

const DHCP_LINK_LOCAL = /^169\.254\./;

/** 判断一个 IPv4 是否属于私有/保留/环回地址 */
export function isPrivateIpv4(ip) {
  const p = ip.split('.').map((x) => Number(x));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true;                          // 0.0.0.0/8
  if (a === 10) return true;                         // 10/8
  if (a === 127) return true;                        // 环回
  if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true;           // 链路本地
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12
  if (a === 192 && b === 168) return true;           // 192.168/16
  if (a === 192 && b === 0) return true;             // 192.0.0/24 与 192.0.2/24
  if (a === 192 && b === 88 && p[2] === 99) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;  // 198.18/15
  if (a === 198 && b === 51 && p[2] === 100) return true;
  if (a === 203 && b === 0 && p[2] === 113) return true;
  if (a >= 224) return true;                         // 组播与保留
  return false;
}

/** 判断一个 IPv6 是否属于私有/保留/环回地址 */
export function isPrivateIpv6(ip) {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (s === '::' || s === '::1') return true;
  // IPv4 映射地址：把内嵌的 IPv4 取出来再判
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  if (/^f[cd]/.test(s)) return true;        // fc00::/7 唯一本地
  if (/^fe[89ab]/.test(s)) return true;     // fe80::/10 链路本地
  if (/^ff/.test(s)) return true;           // ff00::/8 组播
  if (s.startsWith('2001:db8')) return true; // 文档用
  if (s.startsWith('2002:')) return true;   // 6to4
  return false;
}

export function isPrivateIp(ip) {
  return net.isIPv6(ip) ? isPrivateIpv6(ip) : isPrivateIpv4(ip);
}

/** 解析主机名，返回全部 IP */
export async function resolveHost(host) {
  if (net.isIP(host)) return [host];
  const rows = await dns.lookup(host, { all: true });
  return rows.map((r) => r.address);
}

/**
 * 校验来源不可信的 URL：只允许 http/https，且解析结果必须全是公网地址。
 * 通过则返回规范化后的 URL 对象，否则抛错。
 */
export async function assertRemoteUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('URL 无法解析'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`拒绝非 http/https 协议: ${u.protocol}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('URL 缺少主机名');
  const ips = await resolveHost(host);
  if (ips.length === 0) throw new Error('主机名无法解析');
  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      throw new Error(`拒绝内网/保留地址: ${host} -> ${ip}`);
    }
  }
  return u;
}

/**
 * 校验管理员配置的服务端点：只允许 http/https/ws/wss。
 * 放行本地与私有地址（见文件头说明）。
 */
export function assertEndpoint(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('端点 URL 无法解析'); }
  const ok = ['http:', 'https:', 'ws:', 'wss:'];
  if (!ok.includes(u.protocol)) throw new Error(`端点协议不允许: ${u.protocol}`);
  if (!u.hostname) throw new Error('端点缺少主机名');
  return u;
}

/**
 * 下载远程内容（默认用于图片/语音）。
 * - 走 assertRemoteUrl 校验
 * - 限制体积与超时，超限即中止
 * 返回 { ok, status, bytes, contentType, buffer }
 */
export async function fetchRemote(rawUrl, { maxBytes = 8 * 1024 * 1024, timeoutMs = 20000, headers = {} } = {}) {
  const u = await assertRemoteUrl(rawUrl);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(u, { signal: ac.signal, redirect: 'follow', headers });
    if (!res.ok) return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len && len > maxBytes) {
      return { ok: false, status: res.status, reason: `体积超限 ${len} > ${maxBytes}` };
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) {
        ac.abort();
        return { ok: false, status: res.status, reason: `下载超过上限 ${maxBytes}` };
      }
      chunks.push(chunk);
    }
    return {
      ok: true,
      status: res.status,
      bytes: total,
      contentType: res.headers.get('content-type') ?? '',
      buffer: Buffer.concat(chunks),
    };
  } catch (e) {
    log.debug('net', 'fetch failed', { url: u.href, err: String(e.message) });
    return { ok: false, status: 0, reason: String(e.message) };
  } finally {
    clearTimeout(timer);
  }
}

/** 判断一个主机名/IP 是否指向本机环回 */
export function isLoopbackHost(host) {
  const h = String(host ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost') return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (/^127\./.test(h)) return true;
  if (h.startsWith('::ffff:127.')) return true;
  return false;
}

/**
 * 只允许访问本机环回地址的取件函数。
 *
 * 用途是把「本机服务」（比如 NapCat）返回的资源取回来。
 * 这类地址可能被服务端填成 http://127.0.0.1:xxxx，用 assertRemoteUrl 会被正确地拒掉，
 * 但那条规则是防「攻击者伪造外链探测内网」，而这里是访问我们自己的本机服务。
 * 因此单独开一个只认环回的口子：范围被限定在 127.0.0.0/8 与 ::1，
 * 即使 URL 被伪造也无法触及局域网里的其他机器。
 */
export async function fetchLoopback(rawUrl, { maxBytes = 12 * 1024 * 1024, timeoutMs = 20000, headers = {} } = {}) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { return { ok: false, status: 0, reason: 'URL 无法解析' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, status: 0, reason: `协议不允许: ${u.protocol}` };
  }
  if (!isLoopbackHost(u.hostname)) {
    return { ok: false, status: 0, reason: `只允许环回地址，拒绝: ${u.hostname}` };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(u, { signal: ac.signal, redirect: 'error', headers });
    if (!res.ok) return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len && len > maxBytes) return { ok: false, status: res.status, reason: `体积超限 ${len}` };
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) { ac.abort(); return { ok: false, status: res.status, reason: '下载超过上限' }; }
      chunks.push(chunk);
    }
    return { ok: true, status: res.status, bytes: total, contentType: res.headers.get('content-type') ?? '', buffer: Buffer.concat(chunks) };
  } catch (e) {
    return { ok: false, status: 0, reason: String(e.message) };
  } finally {
    clearTimeout(timer);
  }
}

/** 把字节数换算成人类可读 */
export function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export { DHCP_LINK_LOCAL };
