// 定时任务：历史清理、频控桶清理、缓存保温
import * as log from './logger.js';
import * as db from './db.js';
import * as history from './history.js';
import * as llm from './llm.js';
import * as secrets from './secrets.js';
import * as rate from './modules/rateLimit.js';
import { botSettings } from './config.js';

const timers = [];
let lastKeepAlive = new Map();   // botId -> ts

function every(ms, name, fn) {
  const t = setInterval(() => {
    try { fn(); } catch (e) { log.error('tasks', `${name} 执行失败`, String(e.message)); }
  }, ms);
  timers.push(t);
  return t;
}

/** 每小时：清理历史与计数桶 */
export function startHousekeeping() {
  every(3600_000, 'housekeeping', () => {
    for (const bot of db.listBots()) {
      const s = botSettings(bot.id);
      history.pruneHistory(bot.id, s);
    }
    const n = rate.prune();
    log.info('tasks', 'housekeeping done', { buckets: n });
  });
  log.info('tasks', 'housekeeping scheduled');
}

/**
 * 缓存保温：定期发一个只含公共前缀的极小请求。
 * 默认关闭；开启后也绝不在 QQ 里发任何东西，只在 API 层发。
 */
export function startKeepAlive() {
  every(60_000, 'keepalive', async () => {
    for (const bot of db.listBots()) {
      if (Number(bot.enabled_local) !== 1) continue;
      const s = botSettings(bot.id);
      if (!s.api?.keepAlive?.enabled) continue;

      const intervalMs = (s.api.keepAlive.intervalMin ?? 4) * 60_000;
      const last = lastKeepAlive.get(bot.id) ?? 0;
      if (Date.now() - last < intervalMs) continue;

      const apiKey = secrets.getApiKey(bot.id);
      if (!apiKey) continue;

      const { buildSystemPrompt } = await import('./modules/persona.js');
      lastKeepAlive.set(bot.id, Date.now());
      const r = await llm.chat({
        botId: bot.id, apiKey,
        baseUrl: s.api.baseUrl, model: s.api.model,
        scene: 'keepalive',
        // 必须传 settings：否则拼出来的前缀与聊天请求不一致，
        // 保温就是保了个别的缓存，白花钱。
        system: buildSystemPrompt(bot.id, { settings: s }),
        history: [], tail: '好',
        effort: 'low', maxTokens: 8,
      });
      log.debug('tasks', 'keepalive', { botId: bot.id, ok: r.ok, hit: r.usage?.cacheHit });
    }
  });
  log.info('tasks', 'keepalive checker scheduled');
}

/**
 * 印象自动提炼：定期把有新发言的人的档案更新一遍。
 * 默认开启；某人聊得少（不足 minMessages 句）会跳过，免得凭两句话编档案。
 */
export function startImpressionExtraction() {
  every(6 * 3600_000, 'impressions', async () => {
    const secrets = await import('./secrets.js');
    const llm = await import('./llm.js');
    const impression = await import('./modules/impression.js');

    for (const bot of db.listBots()) {
      if (Number(bot.enabled_local) !== 1) continue;
      const s = botSettings(bot.id);
      if (s.impression?.autoEnabled === false) continue;

      const apiKey = secrets.getApiKey(bot.id);
      if (!apiKey) continue;

      const targets = impression.needingExtraction(bot.id);
      if (targets.length === 0) continue;

      let done = 0;
      for (const pid of targets.slice(0, 20)) {
        const r = await impression.extractFor(bot.id, pid, {
          settings: s, apiKey, chatFn: llm.chat,
          baseUrl: s.api.baseUrl, model: s.api.model,
          maxChars: s.impression?.maxChars ?? 300,
        });
        if (r.ok) done++;
        else log.debug('tasks', 'impression skipped', { botId: bot.id, pid, reason: r.error });
      }
      log.info('tasks', 'impressions extracted', { botId: bot.id, done, total: targets.length });
    }
  });
  log.info('tasks', 'impression extraction scheduled');
}

export function stopAll() {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}
