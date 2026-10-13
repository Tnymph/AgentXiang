// 联网搜索：把「查一下」交给模型自己决定 —— 以 function call 的形式给它一个工具。
//
// 全项目只有这里会因为"想查点东西"而发对外请求。规矩：
//   - 接口地址、请求体结构都写死在这个文件里（白名单），查询词来自模型的 tool_call
//   - 查询词过 cleanQuery：截断长度、去掉控制字符
//   - 密钥存在加密的全局槽位（secrets.js 的 __global），界面只显示掩码
//   - 每次搜索都计入每小时上限，跟图片识别一个道理：防的是"模型上瘾"
import * as log from '../logger.js';
import { assertEndpoint } from '../net.js';

// 必应 RSS 会看 UA，用浏览器那套最稳
const RSS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** 支持的搜索服务。加一家就在这加一条，别在别处写死。 */
export const PROVIDERS = {
  bing: {
    label: '必应（免密钥）',
    endpoint: 'https://cn.bing.com/search',
    kind: 'rss',
    applyUrl: '',
    quota: '不用注册、不用密钥。结果条数少（一次 10 条以内），适合简单查询',
  },
  bocha: {
    label: '博查',
    endpoint: 'https://api.bochaai.com/v1/web-search',
    kind: 'json',
    applyUrl: 'https://open.bochaai.com/',
    quota: '注册送 1000 次（3 个月有效），之后 ¥36/1000 次；结果更全，适合认真查',
  },
};

/** 这一家要不要密钥 */
export function needsKey(provider) {
  return PROVIDERS[provider]?.kind !== 'rss';
}

/** 解析必应 RSS：<item> 里取标题/链接/摘要，顺手解掉常见的 HTML 实体 */
export function parseRss(xml, limit = 5) {
  const decode = (s) => String(s)
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  const pick = (block, tag) => {
    const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return m ? decode(m[1]) : '';
  };
  const items = String(xml ?? '').match(/<item>[\s\S]*?<\/item>/g) ?? [];
  return items.slice(0, limit).map((b) => ({
    title: pick(b, 'title').slice(0, 200),
    url: pick(b, 'link').slice(0, 500),
    snippet: pick(b, 'description').slice(0, 600),
  })).filter((r) => r.title || r.snippet);
}

/** 给模型的工具说明。这段话会直接影响它什么时候查、怎么查，别随手改。 */
export const TOOL_SPEC = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      '联网搜索，返回几条网页摘要。'
      + '问到具体价格、新闻、赛事、某人的近况、某个确切数字、或者任何会过期的信息时，先查再回答 —— '
      + '不要用「我不查这个」「你自己去看」把人打发走，也不要凭印象编。'
      + '寒暄、闲聊、常识、数学题、以及你本来就知道的事，不要查。'
      + '一次答不上来可以换个说法再搜一次，但别反复搜同一件事。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词。像人在搜索框里打的那样，**短、具体**，几个词就够（比如「DeepSeek API 价格」），别写成一整句话，也别超过十几个字 —— 太长会搜出一堆不相干的东西。' },
      },
      required: ['query'],
    },
  },
};

/** 搜索词清洗：去控制字符、压平空白、截断。返回空串表示不该搜。 */
export function cleanQuery(q) {
  const s = String(q ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, 180);
}

/**
 * 把各家返回的结果统一成 [{ title, url, snippet }]。
 * 字段名各家不一样（博查照搬必应那套），所以多试几种路径，认不出就返回空数组。
 */
export function normalizeResults(body, limit = 5) {
  const pick = (arr) => (Array.isArray(arr) ? arr : []);
  const lists = [
    body?.data?.webPages?.value,
    body?.webPages?.value,
    body?.data?.value,
    body?.data?.results,
    body?.results,
  ];
  const raw = lists.map(pick).find((a) => a.length) ?? [];
  return raw.slice(0, limit).map((r) => ({
    title: String(r.name ?? r.title ?? '').slice(0, 200),
    url: String(r.url ?? r.link ?? '').slice(0, 500),
    snippet: String(r.summary ?? r.snippet ?? r.description ?? '').slice(0, 600),
  })).filter((r) => r.title || r.snippet);
}

/** 把结果压成给模型看的短文本：省 token，同时保留出处 */
export function formatForModel(results) {
  if (!results.length) return '（没搜到有意义的结果）';
  return results.map((r, i) => `${i + 1}. ${r.title}\n${r.snippet}\n来源：${r.url}`).join('\n\n').slice(0, 4000);
}

// ---------- 每小时上限 ----------

const used = new Map(); // botId -> { hour, n }

function hourKey(now = Date.now()) {
  return Math.floor(now / 3600000);
}

/** 这个机器人这一小时还能搜几次 */
export function searchQuota(botId, limit, now = Date.now()) {
  const state = used.get(botId);
  const h = hourKey(now);
  const n = state && state.hour === h ? state.n : 0;
  return { used: n, limit, left: Math.max(0, limit - n), ok: n < limit };
}

/** 记一次搜索 */
export function noteSearch(botId, now = Date.now()) {
  const h = hourKey(now);
  const state = used.get(botId);
  used.set(botId, state && state.hour === h ? { hour: h, n: state.n + 1 } : { hour: h, n: 1 });
}

export function resetSearchQuota() {
  used.clear();
}

/**
 * 真的去搜一次。
 * 返回 { ok, results, error }；调用方拿到 !ok 也要给模型一个说法，别让它干等。
 */
export async function searchWeb(query, { apiKey, provider = 'bing', count = 5, timeoutMs = 12000 } = {}) {
  const q = cleanQuery(query);
  if (!q) return { ok: false, error: '搜索词为空' };
  const p = PROVIDERS[provider];
  if (!p) return { ok: false, error: `不认识的搜索服务：${provider}` };
  if (needsKey(provider) && !apiKey) return { ok: false, error: '没有配置搜索密钥' };

  const u = assertEndpoint(p.endpoint);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let res;
    if (p.kind === 'rss') {
      // 必应：GET + RSS 输出，不需要密钥，返回的是 XML
      u.searchParams.set('q', q);
      u.searchParams.set('format', 'rss');
      res = await fetch(u, { signal: ac.signal, headers: { 'User-Agent': RSS_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
    } else {
      res = await fetch(u, {
        method: 'POST',
        signal: ac.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query: q, count: Math.min(Math.max(1, count), 20), summary: false, freshness: 'noLimit' }),
      });
    }
    const text = await res.text();
    if (!res.ok) {
      log.warn('search', 'failed', { provider, status: res.status, body: text.slice(0, 200) });
      return { ok: false, error: `HTTP ${res.status}`, body: text.slice(0, 300) };
    }
    let results;
    if (p.kind === 'rss') {
      results = parseRss(text, count);
    } else {
      let data;
      try { data = JSON.parse(text); } catch { return { ok: false, error: '响应不是合法 JSON' }; }
      results = normalizeResults(data, count);
    }
    log.info('search', 'ok', { provider, query: q, results: results.length });
    return { ok: true, results };
  } catch (e) {
    const isAbort = e.name === 'AbortError';
    log.warn('search', 'error', { err: String(e.message) });
    return { ok: false, error: isAbort ? '搜索超时' : String(e.message) };
  } finally {
    clearTimeout(timer);
  }
}
