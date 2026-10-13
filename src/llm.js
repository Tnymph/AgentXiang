// DeepSeek 客户端
//
// 缓存友好是硬要求，所以这个模块对调用方只开一个口子：
//   system  —— 一字不变的公共前缀（人设 + 风格卡 + 规则 + 例句），永远排在消息序列最前
//   history —— 顺序追加的历史
//   tail    —— 每次都变的东西（时间、昵称、印象、本轮消息），只允许放在最后
// 模块内部绝不往 system 里插任何动态内容，否则整个账号的缓存命中率会崩。
import * as log from './logger.js';
import * as db from './db.js';
import { randomInt } from 'node:crypto';
import { assertEndpoint } from './net.js';

// ---------- 并发闸门（同一个 key 下的所有请求共享账号级并发） ----------

let inFlight = 0;
const waiters = [];

function acquire(limit) {
  if (inFlight < limit) { inFlight++; return Promise.resolve(); }
  return new Promise((resolve) => waiters.push(resolve));
}

function release() {
  inFlight--;
  const next = waiters.shift();
  if (next) { inFlight++; next(); }
}

// ---------- 定价（用于界面上的省钱估算，可在设置里覆盖） ----------

export function defaultPricing() {
  return {
    // 单位：元 / 百万 token（按官方报价换算，请以账单页为准）
    inputMiss: 1.10,
    inputHit: 0.022,
    output: 4.40,
  };
}

/** 估算一次调用花了多少钱，以及缓存命中共省下多少钱 */
export function estimateCost(u, pricing = defaultPricing()) {
  const hit = Number(u.cacheHit ?? 0);
  const miss = Number(u.cacheMiss ?? u.prompt ?? 0);
  const out = Number(u.completion ?? 0);
  const M = 1_000_000;
  const spent = (miss * pricing.inputMiss + hit * pricing.inputHit + out * pricing.output) / M;
  const saved = (hit * (pricing.inputMiss - pricing.inputHit)) / M;
  return { spent, saved, noCacheCost: spent + saved };
}

// ---------- 思考档位 ----------

/**
 * effortMode: low | high | auto
 * auto 规则（来自确认书第八节）：
 *   生成回复 / 复读判断 / 图片理解 → low；提炼类（风格、印象、摘要）→ high
 *
 * 实测（2026-09-23，deepseek-flash）：
 *   - 正确字段名是 reasoning_effort；写成 effort 会被静默忽略
 *   - 服务端默认档 = high（不传参数时思考 token 数与 high 基本一致）
 *   - low 比默认档省约 39% 输出 token，且答案更直接
 *   - 重要：completion_tokens = 思考 + 可见输出，所以 max_tokens 必须同时覆盖两者。
 *     只留几十个 token 会被思考吃光，返回空字符串。
 */
const HIGH_TASKS = new Set(['learn', 'impression', 'summary']);
const EFFORT_PARAM = 'reasoning_effort';

export function pickEffort(effortMode, scene) {
  if (effortMode === 'low') return 'low';
  if (effortMode === 'high') return 'high';
  return HIGH_TASKS.has(scene) ? 'high' : 'low';
}

/**
 * 对话回复的 token 上限。
 *
 * 这个值必须给足：completion_tokens = 思考 + 可见输出，两者共享同一份预算。
 * 提示词越长、任务越绕，思考花的 token 越多。实测踩过两次坑：
 * 上限 512、提示词 1631 token 时，512 个 token 全被思考吃光，回复是空字符串。
 * 注意这是「上限」不是「目标」，给大不会多花钱，只会在需要时才用。
 */
export const DEFAULT_MAX_TOKENS = 2048;

/** 撞到上限时的重试预算 */
export const RETRY_MAX_TOKENS = 6144;

// ---------- 消息组装 ----------

/** 视觉消息：把图片拼进用户消息内容 */
export function withImages(text, images, detail = 'low') {
  if (!images || images.length === 0) return text;
  const parts = [{ type: 'text', text: text || '' }];
  for (const img of images) {
    parts.push({ type: 'image_url', image_url: { url: img, detail } });
  }
  return parts;
}

/** 构造请求体（纯函数，便于单测） */
export function buildPayload({ model, system, history, tail, effort, maxTokens, temperature, tools }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  for (const m of history ?? []) messages.push(m);
  if (tail !== undefined && tail !== null) messages.push({ role: 'user', content: tail });
  const payload = {
    model,
    messages,
    max_tokens: maxTokens ?? 1024,
    temperature: temperature ?? 1.0,
    stream: false,
  };
  if (effort) payload[EFFORT_PARAM] = effort;
  // 工具定义（目前只有联网搜索）。传了就给模型自己决定要不要调。
  if (Array.isArray(tools) && tools.length) payload.tools = tools;
  return payload;
}

// ---------- 请求 ----------

function parseUsage(u) {
  if (!u) return { prompt: 0, cacheHit: 0, cacheMiss: 0, completion: 0, reasoning: 0 };
  const hit = Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0);
  const miss = Number(u.prompt_cache_miss_tokens ?? Math.max(0, (u.prompt_tokens ?? 0) - hit));
  return {
    prompt: Number(u.prompt_tokens ?? 0),
    cacheHit: hit,
    cacheMiss: miss,
    completion: Number(u.completion_tokens ?? 0),
    reasoning: Number(u.completion_tokens_details?.reasoning_tokens ?? 0),
  };
}

function recordUsage(botId, scene, usage) {
  const day = new Date().toISOString().slice(0, 10);
  try {
    db.run(`insert into api_usage
      (bot_id, day, scene, prompt_tokens, cache_hit_tokens, cache_miss_tokens, completion_tokens, reasoning_tokens, calls, created_at)
      values (?,?,?,?,?,?,?,?,?,?)`,
      botId, day, scene, usage.prompt, usage.cacheHit, usage.cacheMiss, usage.completion, usage.reasoning, 1, Date.now());
  } catch (e) {
    log.warn('llm', 'usage 写入失败', String(e.message));
  }
  log.usage({ bot: botId, scene, ...usage, cost: estimateCost(usage).spent.toFixed(6) });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function backoffMs(attempt, retryAfterSec) {
  if (retryAfterSec) return Math.min(retryAfterSec * 1000, 60000);
  const base = Math.min(1000 * 2 ** attempt, 30000);
  // 抖动用于错开并发重试，本不需要密码学强度；用 CSPRNG 是为了让静态扫描保持干净
  return base + randomInt(0, 500);
}

/**
 * 发一次对话请求。
 * 返回 { ok, text, usage, cost, error }
 */
export async function chat({
  botId, apiKey, baseUrl, model, scene = 'chat',
  system, history, tail, effort, maxTokens, temperature, tools,
  timeoutMs = 60000, maxConcurrency = 4, maxRetries = 4,
}) {
  if (!apiKey) return { ok: false, error: '未配置 API Key' };

  const base = assertEndpoint(baseUrl);
  const url = new URL('chat/completions', base.href.endsWith('/') ? base.href : base.href + '/');
  const chosenEffort = effort ?? 'low';
  const payload = buildPayload({ model, system, history, tail, effort: chosenEffort, maxTokens, temperature, tools });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await acquire(maxConcurrency);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after') ?? 0);
        const wait = backoffMs(attempt, retryAfter);
        log.warn('llm', 'retry', { status: res.status, attempt, waitMs: wait, scene });
        await sleep(wait);
        continue;
      }

      const bodyText = await res.text();
      if (!res.ok) {
        log.error('llm', 'request failed', { status: res.status, scene, body: bodyText.slice(0, 300) });
        return { ok: false, error: `HTTP ${res.status}`, body: bodyText.slice(0, 500) };
      }

      let data;
      try { data = JSON.parse(bodyText); } catch { return { ok: false, error: '响应不是合法 JSON' }; }
      const message = data.choices?.[0]?.message ?? {};
      const text = message.content ?? '';
      const usage = parseUsage(data.usage);
      const cost = estimateCost(usage);
      recordUsage(botId, scene, usage);
      log.debug('llm', 'ok', { scene, effort: chosenEffort, hit: usage.cacheHit, miss: usage.cacheMiss, out: usage.completion });
      return {
        ok: true, text, usage, cost,
        finishReason: data.choices?.[0]?.finish_reason,
        // 模型要求调工具时给这里。调用方负责执行、把结果作为 role:'tool' 消息再发一轮。
        toolCalls: message.tool_calls ?? null,
      };
    } catch (e) {
      const isAbort = e.name === 'AbortError';
      if (attempt === maxRetries) {
        log.error('llm', 'request error', { scene, err: String(e.message) });
        return { ok: false, error: isAbort ? '请求超时' : String(e.message) };
      }
      const wait = backoffMs(attempt);
      log.warn('llm', 'error, retrying', { scene, attempt, waitMs: wait, err: String(e.message) });
      await sleep(wait);
    } finally {
      clearTimeout(timer);
      release();
    }
  }
  return { ok: false, error: '重试次数用尽' };
}

/** 拉取当日用量汇总（界面用） */
export function usageSummary(botId, day = new Date().toISOString().slice(0, 10)) {
  const row = db.one(`select
      sum(calls) as calls,
      sum(prompt_tokens) as prompt,
      sum(cache_hit_tokens) as hit,
      sum(cache_miss_tokens) as miss,
      sum(completion_tokens) as completion,
      sum(reasoning_tokens) as reasoning
    from api_usage where bot_id = ? and day = ?`, botId, day);
  const u = {
    calls: Number(row?.calls ?? 0),
    prompt: Number(row?.prompt ?? 0),
    cacheHit: Number(row?.hit ?? 0),
    cacheMiss: Number(row?.miss ?? 0),
    completion: Number(row?.completion ?? 0),
    reasoning: Number(row?.reasoning ?? 0),
  };
  const hitRate = u.prompt > 0 ? u.cacheHit / u.prompt : 0;
  return { ...u, hitRate, cost: estimateCost(u) };
}

/**
 * 花费趋势：今天 vs 历史日均。
 *
 * 「历史日均」按**有数据的天**平均，不按自然日——机器人没开的日子不该把均值拉低，
 * 那看着像"花费降了"，其实是没跑。返回值里带 samples，好让调用方把依据说清楚。
 *
 * @param {number[]} botIds 要统计的机器人；空数组 = 全部
 * @param {object} opts { historyDays 最多回看多少天, today }
 */
export function spendTrend(botIds = [], { historyDays = 14, today = new Date().toISOString().slice(0, 10) } = {}) {
  const ids = (botIds ?? []).filter((x) => Number.isInteger(x) && x > 0);
  const all = db.all('select id from bots order by id');
  const use = ids.length ? ids : all.map((b) => b.id);
  if (!use.length) return { today: 0, todayCalls: 0, avg: 0, samples: 0, perBot: [], days: [] };

  const marks = use.map(() => '?').join(',');
  const rows = db.all(
    `select day, bot_id,
            sum(calls) as calls, sum(cache_hit_tokens) as hit,
            sum(cache_miss_tokens) as miss, sum(completion_tokens) as completion
     from api_usage where bot_id in (${marks}) group by day, bot_id`,
    ...use);

  const byDay = new Map();       // day -> { spent, calls }
  const byBot = new Map();       // botId -> { spent, calls, todaySpent }
  for (const r of rows) {
    const spent = estimateCost({ cacheHit: r.hit, cacheMiss: r.miss, completion: r.completion }).spent;
    const d = byDay.get(r.day) ?? { day: r.day, spent: 0, calls: 0 };
    d.spent += spent;
    d.calls += Number(r.calls ?? 0);
    byDay.set(r.day, d);

    const b = byBot.get(r.bot_id) ?? { botId: r.bot_id, spent: 0, calls: 0, todaySpent: 0 };
    b.spent += spent;
    b.calls += Number(r.calls ?? 0);
    if (r.day === today) b.todaySpent += spent;
    byBot.set(r.bot_id, b);
  }

  const todayRow = byDay.get(today) ?? { spent: 0, calls: 0 };
  const history = [...byDay.values()]
    .filter((d) => d.day < today)
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .slice(0, historyDays);
  const avg = history.length ? history.reduce((a, d) => a + d.spent, 0) / history.length : 0;

  const names = new Map(db.all('select id, name from bots').map((b) => [b.id, b.name]));
  const perBot = [...byBot.values()]
    .map((b) => ({ ...b, name: names.get(b.botId) ?? `#${b.botId}` }))
    .sort((a, b) => b.todaySpent - a.todaySpent);

  return {
    today: todayRow.spent,
    todayCalls: todayRow.calls,
    avg,
    samples: history.length,
    days: history,
    perBot,
    botIds: use,
  };
}
