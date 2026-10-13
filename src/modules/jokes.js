// 网上抓一条「网感」素材，给机器人当聊天素材用
//
// 2026-09-23 实测了一圈公开接口，从这台机器能连通的只有一言：
//   ✅ v1.hitokoto.cn / international.v1.hitokoto.cn
//   ❌ api.vvhan.com、api.uomg.com（域名解析不了）
//   ❌ api.oioweb.cn、api.52vmy.cn（连接失败）、v.api.aa1.cn（404）、api.btstu.cn（失败）
// 所以主源用一言、国际口作备用——两个是同一个服务，抗单点。
// 它没有「长篇笑话」，但「抖机灵 / 来自网络」这两类正是网感素材，
// 比硬凑一段段子更像真人网友会随口说的东西。
//
// 安全：一律走 net.fetchRemote —— 只允许 http(s)，发请求前校验 host 并拒绝
// 回环/私有/保留地址。这是硬约束，不要绕开它自己发请求。
import * as log from '../logger.js';
import { fetchRemote } from '../net.js';

/** 素材源。按顺序试，前一个失败就用下一个。加新源直接往这里加一条。 */
export const SOURCES = [
  { name: '一言·抖机灵', url: 'https://v1.hitokoto.cn/?c=l&c=f&encode=json' },
  { name: '一言·国际口', url: 'https://international.v1.hitokoto.cn/?c=l&c=f&encode=json' },
];

// 接口有频率限制，而且机器人可能在几条消息里连着要用——所以同一个进程里
// 20 秒内只真抓一次，其余复用上一条。
const MIN_INTERVAL_MS = 20_000;
let lastAt = 0;
let lastResult = null;

const pick = (json) => {
  const t = String(json?.hitokoto ?? json?.data?.content ?? '').trim();
  if (!t) return null;
  return { text: t.slice(0, 120), from: String(json?.from ?? json?.data?.from ?? '').trim() };
};

/** 从某一个源抓。失败返回 null，不抛。 */
async function fetchFrom(source, { timeoutMs }) {
  try {
    const res = await fetchRemote(source.url, { timeoutMs, maxBytes: 128 * 1024 });
    if (!res.ok) {
      log.debug('jokes', '抓取失败', { source: source.name, status: res.status, reason: res.reason });
      return null;
    }
    let json;
    try { json = JSON.parse(res.buffer.toString('utf8')); } catch { return null; }
    const got = pick(json);
    if (!got) return null;
    return { ok: true, ...got, source: source.name };
  } catch (e) {
    // 网络不通、域名解析不了、被安全策略拒绝，都会走到这里——都只是「没素材」，不影响回复
    log.debug('jokes', '抓取抛错', { source: source.name, err: String(e.message) });
    return null;
  }
}

/**
 * 取一条素材。
 * @returns {{ ok:boolean, text?:string, from?:string, source?:string, reason?:string, cached?:boolean }}
 */
export async function fetchOne({ timeoutMs = 9000, force = false, sources = SOURCES, now = Date.now() } = {}) {
  if (!force && lastResult && now - lastAt < MIN_INTERVAL_MS) {
    return { ...lastResult, cached: true };
  }
  for (const s of sources) {
    const r = await fetchFrom(s, { timeoutMs });
    if (r) {
      lastAt = Date.now();
      lastResult = r;
      log.debug('jokes', '拿到素材', { source: r.source, chars: r.text.length });
      return r;
    }
  }
  lastAt = Date.now();                 // 失败也记时间，避免连着打接口
  lastResult = null;
  return { ok: false, reason: '所有素材源都没取到' };
}

/** 清掉节流与缓存（测试用） */
export function resetJokes() {
  lastAt = 0;
  lastResult = null;
}

/**
 * 从消息里判断「他是在要个乐子」（本地粗判，不花模型调用）。
 *
 * 只认**名词**：出现「段子/笑话/乐子/整活」这类词才去抓。
 * 不要认「讲个」「来个」这种光杆动词——「讲个题」「来个例子」不是要段子；
 * 也不要认「笑死我了」「好搞笑」这类感叹：那是反应，不是请求，
 * 为他去抓一次素材纯属浪费。
 *
 * 宁可略松一点也不要漏：判断错了只是白抓一条素材，
 * 而素材用不用由模型决定（提示词里写明了「不搭就别硬塞」）。
 */
export const JOKE_HINT = /段子|笑话|乐子|整活|沙雕|抽象活|梗图|表情包|好玩的|有意思的|笑一个/;

export function looksLikeAsking(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  return JOKE_HINT.test(t);
}
