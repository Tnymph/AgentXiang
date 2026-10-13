// 界面用的接口。每个 handler 只做一件事。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, TOOLS_DIR, TRANSCRIPT_DIR, pathInfo, savePaths } from '../paths.js';
import * as db from '../db.js';
import * as log from '../logger.js';
import * as secrets from '../secrets.js';
import * as history from '../history.js';
import * as persona from '../modules/persona.js';
import * as lists from '../modules/lists.js';
import * as fb from '../modules/fallback.js';
import * as pickup from '../modules/pickup.js';
import * as sch from '../modules/schedule.js';
import * as admins from '../modules/admins.js';
import * as impression from '../modules/impression.js';
import * as persons from '../modules/persons.js';
import * as clone from '../modules/clone.js';
import * as cmds from '../modules/commands.js';
import * as learning from '../modules/learning.js';
import * as asr from '../asr.js';
import * as sys from '../modules/system.js';
import * as searchMod from '../modules/search.js';
import * as mediaLearn from '../modules/media-learn.js';
import * as tts from '../modules/tts.js';
import * as forge from '../modules/voice-forge.js';
import * as voiceOut from '../modules/voice-out.js';
import * as voices from '../modules/voices.js';
import * as cosy from '../modules/cosyvoice.js';
import * as rvc from '../modules/rvc.js';
import * as llm from '../llm.js';
import { botSettings, saveBotSettings, loadGlobal, saveGlobal, defaultBotSettings } from '../config.js';
import { route } from './router.js';
import { exportLogBundle, listLogFiles } from '../logger.js';

let managerRef = null;
export function bindManager(m) { managerRef = m; }

/**
 * 机器人状态。有管理器就用实时状态；没有就退回库里的静态信息
 * （运行态一律标为未运行），这样脱离管理器也能查看与配置。
 */
function botStatus() {
  const g = loadGlobal();
  const decorate = (b, live) => {
    const settings = botSettings(b.id);
    return {
      id: b.id,
      name: b.name,
      qq: b.qq,
      enabledLocal: Number(b.enabled_local) === 1,
      running: !!live,
      connected: !!live?.client?.connected,
      selfId: live?.client?.selfId ?? null,
      nicknames: live?.worker?.nicknames ?? [],
      apiMode: settings.api.mode,
      hasApiKey: secrets.hasApiKey(b.id),
      apiKeyMasked: secrets.maskedApiKey(b.id),
      napcatWsUrl: settings.napcatWsUrl || '',
      effectiveWsUrl: settings.napcatWsUrl || g.napcat.wsUrl,
      napcatDir: settings.napcatDir || 'napcat',
    };
  };
  if (managerRef) {
    const live = new Map(managerRef.status().map((x) => [x.id, x]));
    return db.listBots().map((b) => decorate(b, managerRef.instances.get(b.id)));
  }
  return db.listBots().map((b) => decorate(b, null));
}

const asInt = (v) => Number.parseInt(String(v), 10);
const requireBot = (id) => {
  const bot = db.getBot(asInt(id));
  if (!bot) throw new Error('机器人不存在');
  return bot;
};

// ---------- 概览 ----------

route('GET', '/api/overview', async () => {
  const bots = botStatus();
  const usage = bots.map((b) => ({ id: b.id, ...llm.usageSummary(b.id) }));
  const napcat = loadGlobal().napcat;
  return {
    napcat: { wsUrl: napcat.wsUrl, hasToken: !!secrets.getAccessToken() },
    bots,
    usage,
    ui: loadGlobal().ui,
    listWarn: bots.map((b) => ({ id: b.id, unconfigured: lists.isUnconfigured(b.id) })),
  };
});

// ---------- 机器人 ----------

route('GET', '/api/bots', async () => botStatus());

route('POST', '/api/bots', async ({ body }) => {
  const name = String(body.name ?? '').trim();
  if (!name) throw new Error('名字不能为空');
  const qq = body.qq ? String(body.qq).trim() : '';
  if (qq && db.getBotByQq(qq)) throw new Error('已经有一个机器人用这个 QQ 号了');
  const id = db.createBot(name, qq || null);
  fb.seedDefaults(id);
  sch.ensureSlots(id, 3);
  if (body.napcatWsUrl) saveBotSettings(id, { napcatWsUrl: String(body.napcatWsUrl).trim() });
  log.info('web', 'bot created', { id, name, qq });
  return { id };
});

route('POST', '/api/bots/:id', async ({ params, body }) => {
  const bot = requireBot(params.id);
  if (body.name !== undefined) db.run('update bots set name = ?, updated_at = ? where id = ?', String(body.name), Date.now(), bot.id);
  if (body.qq !== undefined) db.run('update bots set qq = ?, updated_at = ? where id = ?', String(body.qq).trim() || null, Date.now(), bot.id);
  if (body.enabledLocal !== undefined) db.setBotEnabled(bot.id, !!body.enabledLocal);
  if (managerRef) await managerRef.restartOne(bot.id);
  return { ok: true };
});

route('POST', '/api/bots/:id/restart', async ({ params }) => {
  const bot = requireBot(params.id);
  if (managerRef) await managerRef.restartOne(bot.id);
  return { ok: true };
});

route('DELETE', '/api/bots/:id', async ({ params }) => {
  const bot = requireBot(params.id);
  if (managerRef) await managerRef.stopOne(bot.id);
  for (const t of ['messages', 'sessions', 'persons', 'person_qqs', 'impressions', 'personas',
    'persona_snapshots', 'marks', 'list_entries', 'admins', 'schedules', 'fallback_replies',
    'command_log', 'api_usage']) {
    db.run(`delete from ${t} where bot_id = ?`, bot.id);
  }
  db.run('delete from bots where id = ?', bot.id);
  log.warn('web', 'bot deleted', { id: bot.id, name: bot.name });
  return { ok: true };
});

// ---------- 密钥 ----------

route('POST', '/api/bots/:id/key', async ({ params, body }) => {
  const bot = requireBot(params.id);
  const key = String(body.key ?? '').trim();
  if (!key) throw new Error('密钥不能为空');
  secrets.setApiKey(bot.id, key);
  return { ok: true, masked: secrets.maskedApiKey(bot.id) };
});

route('POST', '/api/bots/:id/key/reset', async ({ params }) => {
  const bot = requireBot(params.id);
  secrets.resetApiKey(bot.id);
  return { ok: true };
});

route('POST', '/api/napcat/token', async ({ body }) => {
  secrets.setAccessToken(String(body.token ?? ''));
  return { ok: true };
});

// ---------- 设置 ----------

route('GET', '/api/bots/:id/settings', async ({ params }) => {
  const bot = requireBot(params.id);
  return { settings: botSettings(bot.id), defaults: defaultBotSettings() };
});

route('POST', '/api/bots/:id/settings', async ({ params, body }) => {
  const bot = requireBot(params.id);
  const next = saveBotSettings(bot.id, body.patch ?? body);
  return { ok: true, settings: next };
});

route('GET', '/api/global', async () => loadGlobal());
route('POST', '/api/global', async ({ body }) => saveGlobal(body.patch ?? body));

// ---------- 时段 ----------

route('GET', '/api/bots/:id/schedules', async ({ params }) => {
  const bot = requireBot(params.id);
  sch.ensureSlots(bot.id, 3);
  const settings = botSettings(bot.id);
  const slots = sch.listSlots(bot.id).map((s) => ({
    slotNo: s.slot_no, name: s.name, ranges: sch.parseRanges(s.ranges),
    isActive: Number(s.is_active) === 1,
  }));
  const status = sch.isApiActive(bot.id, settings);
  return { slots, activeSlot: settings.schedule.activeSlot, status, apiMode: settings.api.mode };
});

route('POST', '/api/bots/:id/schedules', async ({ params, body }) => {
  const bot = requireBot(params.id);
  if (Array.isArray(body.slots)) {
    for (const s of body.slots) {
      // 界面读回来的区间是「当天第几分钟」的数字，手输的是 "23:30" 这种字符串，
      // 两种都要认——之前只认字符串，导致从界面保存一次就把时段清空了。
      const ranges = (s.ranges ?? []).map((r) => {
        if (typeof r === 'string') return sch.parseRange(r);
        const start = typeof r.start === 'number' ? r.start : sch.parseHm(r.start);
        const end = typeof r.end === 'number' ? r.end : sch.parseHm(r.end);
        if (start === null || end === null || !Number.isFinite(start) || !Number.isFinite(end)) return null;
        return { start, end };
      }).filter(Boolean);
      db.run('update schedules set name = ?, ranges = ? where bot_id = ? and slot_no = ?',
        String(s.name ?? `方案${s.slotNo}`), JSON.stringify(ranges), bot.id, asInt(s.slotNo));
    }
  }
  if (body.activeSlot !== undefined) {
    const slotNo = asInt(body.activeSlot);
    saveBotSettings(bot.id, { schedule: { activeSlot: slotNo } });
    sch.switchSlot(bot.id, slotNo);
  }
  return { ok: true };
});

// ---------- 名单 ----------

route('GET', '/api/bots/:id/lists', async ({ params }) => {
  const bot = requireBot(params.id);
  const out = {};
  for (const scope of lists.SCOPES) {
    out[scope] = {};
    for (const dir of lists.DIRECTIONS) {
      out[scope][dir] = {
        mode: lists.getMode(bot.id, scope, dir),
        targets: [...lists.getTargets(bot.id, scope, dir)].filter((t) => t !== '__mode__'),
        configured: lists.isConfigured(bot.id, scope, dir),
      };
    }
  }
  return out;
});

route('POST', '/api/bots/:id/lists', async ({ params, body }) => {
  const bot = requireBot(params.id);
  const { scope, direction, target } = body;
  if (body.mode) {
    lists.setMode(bot.id, scope, direction, body.mode);
  } else if (body.remove) {
    lists.removeTarget(bot.id, scope, direction, String(target));
  } else {
    const t = String(target ?? '').trim();
    if (!t) throw new Error('目标不能为空');
    lists.addTarget(bot.id, scope, direction, t);
  }
  return { ok: true };
});

// ---------- 默认回复 ----------

route('GET', '/api/bots/:id/fallback', async ({ params }) => {
  const bot = requireBot(params.id);
  fb.seedDefaults(bot.id);
  const scenes = {};
  for (const s of fb.SCENES) {
    scenes[s] = { label: fb.SCENE_LABEL[s], items: fb.listFor(bot.id, s) };
  }
  return { scenes, scenesOrder: fb.SCENES };
});

route('POST', '/api/bots/:id/fallback', async ({ params, body }) => {
  const bot = requireBot(params.id);
  if (body.remove) { fb.removeReply(asInt(body.remove)); return { ok: true }; }
  if (body.id) {
    fb.updateReply(asInt(body.id), {
      text: body.text, enabled: body.enabled, isFixed: body.isFixed,
    });
    return { ok: true };
  }
  fb.addReply(bot.id, String(body.scene), String(body.text ?? ''));
  return { ok: true };
});

// ---------- 接话 ----------
// 规则在库里（每个机器人一套）；命中判据、冷却、每小时的量都在 pickup.js 里。
route('GET', '/api/bots/:id/pickup', async ({ params }) => {
  const bot = requireBot(params.id);
  const settings = botSettings(bot.id);
  return {
    rules: pickup.listRules(bot.id),
    cfg: pickup.cfg(settings),
    annoyed: pickup.annoyedCfg(settings),
    annoyedDefaultWhen: pickup.ANNOYED_DEFAULT_WHEN,
    hourlyUsed: pickup.hourlyCount(bot.id),
    matches: pickup.MATCHES.map((m) => ({ id: m, label: pickup.MATCH_LABEL[m] })),
    modes: pickup.MODES.map((m) => ({ id: m, label: pickup.MODE_LABEL[m] })),
  };
});

route('POST', '/api/bots/:id/pickup', async ({ params, body }) => {
  const bot = requireBot(params.id);
  if (body.clear) return { ok: true, removed: pickup.clearRules(bot.id) };
  if (body.remove) { pickup.removeRule(asInt(body.remove)); return { ok: true }; }
  if (body.batch !== undefined) {
    const r = pickup.addRules(bot.id, body.batch, {
      match: body.match, reply: body.reply, mode: body.mode, cooldownSec: body.cooldownSec,
    });
    return { ok: true, added: r.added, skipped: r.skipped };
  }
  if (body.id) {
    pickup.updateRule(asInt(body.id), {
      pattern: body.pattern, match: body.match, reply: body.reply,
      mode: body.mode, cooldownSec: body.cooldownSec, enabled: body.enabled,
    });
    return { ok: true };
  }
  const id = pickup.addRule(bot.id, {
    pattern: body.pattern, match: body.match, reply: body.reply,
    mode: body.mode, cooldownSec: body.cooldownSec,
  });
  return { ok: true, id };
});

// ---------- 风格卡 ----------

route('GET', '/api/bots/:id/persona', async ({ params }) => {
  const bot = requireBot(params.id);
  const row = persona.activePersona(bot.id);
  return {
    name: row?.name ?? '',
    body: row?.body ?? '',
    examples: persona.parseExamples(row),
    params: persona.parseParams(row),
    updatedAt: row?.updated_at ?? null,
  };
});

route('POST', '/api/bots/:id/persona', async ({ params, body }) => {
  const bot = requireBot(params.id);
  if (body.snapshotLabel) {
    persona.snapshot(bot.id, String(body.snapshotLabel), 'base');
  }
  if (body.body !== undefined || body.examples !== undefined || body.params !== undefined) {
    persona.upsertPersona(bot.id, {
      body: body.body, examples: body.examples, params: body.params,
    });
  }
  return { ok: true };
});

route('GET', '/api/bots/:id/snapshots', async ({ params }) => {
  const bot = requireBot(params.id);
  return persona.listSnapshots(bot.id);
});

route('POST', '/api/bots/:id/snapshots', async ({ params, body }) => {
  const bot = requireBot(params.id);
  if (body.restore) { persona.restoreSnapshot(bot.id, asInt(body.restore)); return { ok: true }; }
  persona.snapshot(bot.id, String(body.label ?? '手动快照'), 'base');
  return { ok: true };
});

// ---------- 印象 ----------

route('GET', '/api/bots/:id/impressions', async ({ params }) => {
  const bot = requireBot(params.id);
  // 列出所有跟它说过话的人，而不仅是「已经有印象的」。
  // 只列有印象的会让页面看起来一片空白——印象要提炼过才会有。
  const rows = db.all(`
    select p.id as person_id, i.facts, i.feelings, i.manual, i.updated_at,
           count(m.id) as msg_count, max(m.ts) as last_ts
    from persons p
    left join impressions i on i.person_id = p.id and i.bot_id = p.bot_id
    left join messages m on m.person_id = p.id and m.bot_id = p.bot_id and m.role = 'user'
    where p.bot_id = ?
    group by p.id
    order by last_ts desc, p.id`, bot.id);

  return rows.map((r) => {
    const qqs = db.getPersonQqs(bot.id, r.person_id);
    const last = db.one(
      'select sender_name, text from messages where bot_id = ? and person_id = ? order by ts desc limit 1',
      bot.id, r.person_id);
    return {
      personId: r.person_id,
      qqs,
      facts: r.facts ?? '',
      feelings: r.feelings ?? '',
      manual: r.manual ?? '',
      updatedAt: r.updated_at ?? null,
      msgCount: Number(r.msg_count ?? 0),
      lastTs: r.last_ts ?? null,
      lastName: last?.sender_name ?? '',
      lastText: last?.text ?? '',
    };
  });
});

route('POST', '/api/bots/:id/impressions/extract', async ({ params, body }) => {
  const bot = requireBot(params.id);
  const settings = botSettings(bot.id);
  const apiKey = secrets.getApiKey(bot.id);
  if (!apiKey) throw new Error('还没配置 API 密钥');

  const target = body.personId ? [asInt(body.personId)] : db
    .all('select id from persons where bot_id = ? order by id', bot.id)
    .map((r) => r.id);

  const results = [];
  for (const pid of target) {
    const r = await impression.extractFor(bot.id, pid, {
      settings, apiKey,
      chatFn: llm.chat,
      baseUrl: settings.api.baseUrl, model: settings.api.model,
      maxChars: settings.impression?.maxChars ?? 300,
    });
    results.push({ personId: pid, ...r });
  }
  return { done: results.filter((x) => x.ok).length, total: results.length, results };
});

route('POST', '/api/bots/:id/impressions', async ({ params, body }) => {
  const bot = requireBot(params.id);
  const pid = asInt(body.personId);
  if (body.remove) { impression.remove(bot.id, pid); return { ok: true }; }
  if (body.manual !== undefined) impression.setManual(bot.id, pid, String(body.manual));
  return { ok: true };
});

// ---------- 大小号绑定 ----------

route('POST', '/api/bots/:id/bind', async ({ params, body }) => {
  const bot = requireBot(params.id);
  const qqA = String(body.qqA ?? '').trim();
  const qqB = String(body.qqB ?? '').trim();
  if (!qqA || !qqB) throw new Error('两个 QQ 号都要填');
  return persons.bind(bot.id, qqA, qqB);
});

route('POST', '/api/bots/:id/unbind', async ({ params, body }) => {
  const bot = requireBot(params.id);
  const qq = String(body.qq ?? '').trim();
  if (!qq) throw new Error('要填 QQ 号');
  return persons.unbind(bot.id, qq);
});

// ---------- 管理员与命令 ----------

route('GET', '/api/bots/:id/admins', async ({ params }) => {
  const bot = requireBot(params.id);
  return { admins: admins.listAdmins(bot.id) };
});

route('POST', '/api/bots/:id/admins', async ({ params, body }) => {
  const bot = requireBot(params.id);
  const qq = String(body.qq ?? '').trim();
  if (body.remove) admins.removeAdmin(bot.id, qq);
  else if (qq) admins.addAdmin(bot.id, qq);
  return { ok: true, admins: admins.listAdmins(bot.id) };
});

route('GET', '/api/commands', async () => cmds.commandSummaries());

// ---------- 聊天记录与标记 ----------

route('GET', '/api/bots/:id/messages', async ({ params, query }) => {
  const bot = requireBot(params.id);
  const limit = Math.min(500, asInt(query.limit ?? 100) || 100);
  const rows = db.all(
    `select m.*, s.kind, s.peer_id from messages m
     join sessions s on s.id = m.session_id
     where m.bot_id = ? order by m.ts desc, m.id desc limit ?`, bot.id, limit);
  const marks = new Map(db.all('select message_id, kind from marks where bot_id = ?', bot.id)
    .map((r) => [r.message_id, r.kind]));
  return rows.reverse().map((r) => ({
    id: r.id, msgId: r.msg_id, role: r.role, text: r.text, flags: r.flags, ts: r.ts,
    kind: r.kind, peerId: r.peer_id, senderName: r.sender_name, senderQq: r.sender_qq,
    mark: marks.get(r.id) ?? null,
    // 图片：给了地址，聊天记录才能把图显示出来
    media: history.parseMedia(r),
  }));
});

// 图片只认「库里那条消息记过的那个地址」。
// 客户端传进来的是消息 id 和序号，**不传路径**——否则这个接口等于任意文件读取。
const IMAGE_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
};

function readStoredImage(url, maxBytes = 12 * 1024 * 1024) {
  const s = String(url ?? '').trim();
  let p = '';
  if (s.startsWith('file://')) {
    try { p = fileURLToPath(s); } catch { return null; }
  } else if (path.isAbsolute(s)) {
    p = s;
  } else {
    return null;      // http(s) 的图交给浏览器自己去取，不必当代理
  }
  const mime = IMAGE_MIME[path.extname(p).toLowerCase()];
  if (!mime) return null;               // 只发图片，别的一律不发
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > maxBytes) return null;
    return { buffer: fs.readFileSync(p), mime };
  } catch {
    return null;                        // NapCat 缓存被清掉了之类
  }
}

route('GET', '/api/bots/:id/message-image', async ({ params, query }) => {
  const bot = requireBot(params.id);
  const mid = asInt(query.msgId);
  if (!mid) throw new Error('缺少 msgId');
  const row = db.one('select media from messages where id = ? and bot_id = ?', mid, bot.id);
  if (!row) throw new Error('没有这条消息');
  const list = history.parseMedia(row);
  const item = list[Math.max(0, asInt(query.i) || 0)];
  if (!item) throw new Error('这条消息没有图片');
  const img = readStoredImage(item.url);
  if (!img) throw new Error('图片取不到了（NapCat 缓存可能已清理）');
  return { __raw: { status: 200, contentType: img.mime, buffer: img.buffer } };
});

route('POST', '/api/bots/:id/mark', async ({ params, body }) => {
  const bot = requireBot(params.id);
  const mid = asInt(body.messageId);
  const kind = String(body.kind ?? '');
  if (!['good', 'bad', 'none'].includes(kind)) throw new Error('标记类型不合法');
  if (kind === 'none') db.run('delete from marks where bot_id = ? and message_id = ?', bot.id, mid);
  else db.run('insert or replace into marks (bot_id, message_id, kind, note, created_at) values (?,?,?,?,?)',
    bot.id, mid, kind, '', Date.now());
  return { ok: true };
});

// ---------- 学习 ----------

route('GET', '/api/bots/:id/learning', async ({ params }) => {
  const bot = requireBot(params.id);
  const settings = botSettings(bot.id);
  return {
    readiness: learning.readiness(bot.id, settings),
    settings: settings.learning,
    runs: learning.listRuns(bot.id, 20),
  };
});

route('POST', '/api/bots/:id/learning/run', async ({ params }) => {
  const bot = requireBot(params.id);
  const settings = botSettings(bot.id);
  const apiKey = secrets.getApiKey(bot.id);
  if (!apiKey) throw new Error('还没配置 API 密钥');
  const r = await learning.runLearning({
    botId: bot.id, settings, apiKey,
    baseUrl: settings.api.baseUrl, model: settings.api.model,
  });
  if (!r.ok) throw new Error(r.error);
  return r;
});

route('POST', '/api/bots/:id/learning/apply', async ({ params, body }) => {
  const bot = requireBot(params.id);
  return learning.applyRun(bot.id, asInt(body.runId), body.acceptedIds ?? []);
});

route('POST', '/api/bots/:id/learning/discard', async ({ params, body }) => {
  const bot = requireBot(params.id);
  return learning.discardRun(bot.id, asInt(body.runId));
});

// ---------- NapCat 登录二维码 ----------
//
// 每个机器人可以用自己的 NapCat 目录（多号时必须有各自的实例），
// 所以二维码路径要按机器人去解析，不能写死第一个目录的名字。

const probeCache = { value: null };

/** 只允许 .tools 下的目录名，防止把路径拼到别处去 */
function qrPathFor(botId) {
  const dir = String(botSettings(botId).napcatDir || 'napcat');
  if (dir !== path.basename(dir) || dir.includes('..')) throw new Error('NapCat 目录名不合法');
  return path.join(TOOLS_DIR, dir, 'cache', 'qrcode.png');
}

route('GET', '/api/bots/:id/qrcode', async ({ params }) => {
  const bot = requireBot(params.id);
  const p = qrPathFor(bot.id);
  if (!fs.existsSync(p)) {
    return { __status: 404, error: `还没有二维码。先启动这个号对应的 NapCat（目录 .tools\\${botSettings(bot.id).napcatDir || 'napcat'}）。` };
  }
  return { __raw: { buffer: fs.readFileSync(p), contentType: 'image/png' } };
});

route('GET', '/api/bots/:id/qrcode-info', async ({ params }) => {
  const bot = requireBot(params.id);
  const p = qrPathFor(bot.id);
  if (!fs.existsSync(p)) return { exists: false };
  const st = fs.statSync(p);
  return { exists: true, mtime: st.mtimeMs, ageSec: Math.round((Date.now() - st.mtimeMs) / 1000) };
});

route('GET', '/api/asr/status', async () => ({
  target: asr.describeTarget({}),
  lastProbe: probeCache.value,
  hint: '识别服务由 scripts\\asr-server.cmd 启动',
}));

route('POST', '/api/asr/probe', async () => {
  const target = asr.describeTarget({});
  const r = await asr.probe(target);
  probeCache.value = { ok: r.ok, error: r.error ?? '', at: Date.now() };
  return { ok: r.ok, error: r.error ?? '', target };
});

// ---------- 运行控制（启停本机进程） ----------
// 这两个接口会真的启动/停止进程，所以额外要求一个自定义请求头。浏览器对带自定义头的
// 跨域请求会先发预检、预检不过就不会真的发请求，于是「随便打开一个网页」没法偷偷
// 把机器人的进程关掉。同源页面走 app.js 的 api()，它统一带这个头。
function assertLocalPage(req) {
  if (String(req?.headers?.['x-agentxiang'] ?? '') !== '1') throw new Error('缺少本机页面的请求头，拒绝执行');
}

route('GET', '/api/system', async () => sys.status());
route('POST', '/api/system/:key/:action', async ({ params, req }) => {
  assertLocalPage(req);
  return sys.act(params.key, params.action);
});

// ---------- 路径（存放位置可以换） ----------
// 四个根目录 + QQ 程序位置；写进项目根的 paths.json，整个重启程序后生效。
// 换目录不会自动搬数据，提示语交给界面说。
const PATH_KEYS = ['toolsDir', 'dataDir', 'styleDir', 'inboxDir', 'qqExe'];

route('GET', '/api/paths', async () => pathInfo());
route('POST', '/api/paths', async ({ body, req }) => {
  assertLocalPage(req);
  const patch = {};
  for (const k of PATH_KEYS) if (body && k in body) patch[k] = body[k];
  if (Object.keys(patch).length === 0) throw new Error('没有要改的项');
  const r = savePaths(patch);
  if (!r.ok) return { __status: 400, error: r.error };
  return { ok: true, ...pathInfo() };
});

// ---------- 联网搜索 ----------
// 密钥是全局一份（不属于任何机器人），存在加密的 __global 槽位里，界面只拿掩码。
route('GET', '/api/search/status', async () => ({
  hasKey: secrets.hasSearchKey(),
  maskedKey: secrets.maskedSearchKey(),
  providers: Object.fromEntries(Object.entries(searchMod.PROVIDERS).map(([k, v]) => [k, {
    label: v.label, applyUrl: v.applyUrl, quota: v.quota,
  }])),
}));

route('POST', '/api/search/key', async ({ body }) => {
  const k = String(body.key ?? '').trim();
  if (!k) throw new Error('请填写搜索密钥');
  secrets.setSearchKey(k);
  return { ok: true, maskedKey: secrets.maskedSearchKey() };
});

route('POST', '/api/search/key/reset', async () => {
  secrets.resetSearchKey();
  return { ok: true };
});

// ---------- 手动语料（学习用） ----------
route('GET', '/api/bots/:id/notes', async ({ params }) => {
  const bot = requireBot(params.id);
  return { notes: learning.listNotes(bot.id) };
});

route('POST', '/api/bots/:id/notes', async ({ params, body }) => {
  const bot = requireBot(params.id);
  const text = String(body.text ?? '').trim();
  if (!text) throw new Error('语料是空的');
  learning.addNote(bot.id, { text, source: 'manual', who: String(body.who ?? '').trim() });
  return { ok: true, notes: learning.listNotes(bot.id) };
});

route('DELETE', '/api/bots/:id/notes/:noteId', async ({ params }) => {
  const bot = requireBot(params.id);
  learning.deleteNote(bot.id, params.noteId);
  return { ok: true, notes: learning.listNotes(bot.id) };
});

// ---------- 语音/视频语料 ----------
// 文件放进 data/learn-media/，这里扫描 → ffmpeg 抽音轨 → 本地识别（不花模型钱）
// → 文字 + 情绪 + 事件 + 逐字时间戳（用来算停顿）→ 合成一条素材。
route('GET', '/api/bots/:id/media', async () => ({
  dir: mediaLearn.MEDIA_DIR,
  files: mediaLearn.listMedia().map((f) => ({ name: f.name, size: f.size, mtime: f.mtime, kind: f.kind })),
}));

route('POST', '/api/bots/:id/media/ingest', async ({ params }) => {
  const bot = requireBot(params.id);
  const out = await mediaLearn.ingestAll({ botId: bot.id, settings: botSettings(bot.id) });
  return { ok: true, dir: out.dir, results: out.results, notes: learning.listNotes(bot.id) };
});

// ---------- 音色（共享资源：不属于任何单个机器人） ----------
// 音色就是 .tools/tts/<名字>/ 目录本身，所以这里不查库、直接扫盘。
route('GET', '/api/voices', async ({ query }) => {
  const cosyStatus = await cosy.probe(botSettings(1));
  const rvcStatus = await rvc.probe(botSettings(1));
  return {
    voices: voices.listAll(),
    qualities: Object.entries(tts.QUALITY).map(([k, v]) => ({ id: k, label: v.label })),
    dir: tts.TTS_DIR,
    // 三个引擎：变声（RVC，最像但要多过一道）→ CosyVoice2（常驻服务）→ sherpa（老的，本地程序 + 参考音频提示）
    engines: [
      { id: 'rvc', label: '变声 RVC（先标准音色读、再换音色）' },
      { id: 'cosyvoice', label: 'CosyVoice2' },
      { id: 'zipvoice', label: 'ZipVoice 克隆（旧）' },
      { id: 'vits', label: '固定音色模型（旧）' },
    ],
    cosy: {
      dir: cosy.COSY_VOICE_DIR,
      prefix: cosy.VOICE_PREFIX,
      ...cosyStatus,
    },
    rvc: {
      dir: rvc.RVC_VOICE_DIR,
      prefix: rvc.VOICE_PREFIX,
      ...rvcStatus,
    },
    // 变声音色能选的声源（都是 CosyVoice 音色：变声只换音色，读音靠它）
    rvcSources: rvc.listSourceCandidates(),
    // 造音色时要照着抄的模板、以及带时间戳的转录在哪（相对项目根，方便直接粘进输入框）
    template: forge.findTemplate()?.id ?? null,
    transcriptDir: path.relative(ROOT, TRANSCRIPT_DIR),
    audioDir: 'style-samples/audio',
    refLimits: { min: forge.MIN_REF_SEC, max: forge.MAX_REF_SEC, def: forge.DEFAULT_REF_SEC },
    // 带上 botId 就顺带回报这个机器人本小时的语音条数（界面上要显示还有多少条）
    quota: query?.botId ? voiceOut.peek(asInt(query.botId), voiceOut.cfg(botSettings(asInt(query.botId)))) : null,
  };
});

// 试听：给一句话，返回合成的 wav（原始字节，前端直接丢给 <audio>）
// 引擎由音色决定：cosy: 前缀走 CosyVoice2 服务，其余走 sherpa
route('POST', '/api/voices/:id/say', async ({ params, body }) => {
  const text = String(body.text ?? '').trim() || '这是一段试听。';
  const pauseMs = Math.max(0, Math.min(1500, Number(body.pauseMs) || 0));
  const speed = Math.max(0, Math.min(1.5, Number(body.speed) || 0));
  const r = await voices.synthesizeAny(text.slice(0, 60), {
    voiceId: params.id,
    quality: body.quality === 'high' ? 'high' : 'normal',
    pauseMs,
    speed,
    settings: botSettings(1),
    outPath: path.join(tts.OUT_DIR, `preview-${Date.now()}.wav`),
  });
  if (!r.ok) throw new Error(r.error);
  const buf = fs.readFileSync(r.path);
  fs.rmSync(r.path, { force: true });   // 已经读进内存了，删掉不占地方
  return { __raw: { status: 200, contentType: 'audio/wav', buffer: buf } };
});

// 变声参数得靠耳朵调：音高/索引比例/声源直接写回音色目录里的 voice.json
// （saveMeta 自己会校验「这个音色存在、参数在范围内」，不是变声音色就找不到目录）
route('POST', '/api/voices/:id/meta', async ({ params, body }) => {
  const r = rvc.saveMeta(params.id, {
    pitch: body.pitch,
    indexRate: body.indexRate,
    protect: body.protect,
    sourceVoice: body.sourceVoice,
  });
  if (!r.ok) throw new Error(r.error);
  return { ok: true, voice: r.voice };
});

// 造音色之前先看一眼「会用哪段文字」：参考文字与录音对不上，合成会吐字发糊，
// 所以这一步要能单独看到结果，别等造完了才发现。
route('POST', '/api/voices/ref-text', async ({ body }) => {
  const src = forge.resolveAudio(body.audioPath);
  if (!src.ok) throw new Error(src.error);
  const startSec = Number(body.startSec) || 0;
  const durSec = Number(body.durSec) || forge.DEFAULT_REF_SEC;
  const t = forge.readTranscriptText(src.path, startSec, durSec);
  return {
    ok: true,
    file: path.relative(ROOT, t.file),
    found: t.found,
    text: t.text,
    // 有转录时会按整行对齐：实际切的窗口可能和你要的不一样，这里一并回报
    rows: t.rows ?? 0,
    willUse: { startSec: t.start ?? startSec, durSec: t.dur ?? durSec },
    asked: { startSec, durSec, endSec: Number((startSec + durSec).toFixed(3)) },
  };
});

// 造音色：给一段参考录音（+ 与它对应的文字）
//   engine=cosyvoice → 登记到 .tools/cosy-voices/<名字>/（只要音频+文字，秒完）
//   其他（默认）    → 老路子，复制 ZipVoice 模板再造一个 sherpa 音色目录
route('POST', '/api/voices', async ({ body }) => {
  const name = String(body.name ?? '').trim();
  const engine = String(body.engine ?? '').trim();
  if (engine === 'cosyvoice') {
    const r = await cosy.addVoice({
      name,
      refAudioPath: body.audioPath,
      text: body.text,
      startSec: body.startSec,
      durSec: body.durSec,
    });
    if (!r.ok) throw new Error(r.error);
    return { ok: true, id: r.voice?.id ?? `cosy:${name}`, voice: r.voice, refText: r.voice?.refText ?? '', engine: 'cosyvoice' };
  }
  if (String(body.fromVoice ?? '').trim()) {
    return forge.createFromVoice({ name, fromVoice: body.fromVoice });
  }
  const r = await forge.createFromAudio({
    name,
    audioPath: body.audioPath,
    startSec: body.startSec,
    durSec: body.durSec,
    text: body.text,
  });
  return {
    ok: true, id: r.voice?.id ?? name, voice: r.voice, refText: r.refText, refFrom: r.refFrom,
    dir: r.dir, sizes: r.sizeMB,
    // 核对结果要回给界面：参考文字与录音对不上会克隆出「糊」的声音，而文件和命令都不报错
    refCheck: r.refCheck,
  };
});

// ---------- 从另一个机器人复制配置 ----------

route('GET', '/api/copyable', async () => clone.COPYABLE);

route('POST', '/api/bots/:id/copy-from', async ({ params, body }) => {
  const to = requireBot(params.id);
  const from = asInt(body.fromBotId);
  const r = clone.copyConfig(from, to.id, body.parts ?? []);
  if (!r.ok) throw new Error(r.error);
  return r;
});

// ---------- 用量 ----------

route('GET', '/api/bots/:id/usage', async ({ params, query }) => {
  const bot = requireBot(params.id);
  const day = query.day || new Date().toISOString().slice(0, 10);
  const byScene = db.all(
    `select scene, sum(calls) as calls, sum(prompt_tokens) as prompt,
            sum(cache_hit_tokens) as hit, sum(cache_miss_tokens) as miss,
            sum(completion_tokens) as completion
     from api_usage where bot_id = ? and day = ? group by scene order by calls desc`, bot.id, day);
  const days = db.all(
    `select day, sum(calls) as calls, sum(cache_hit_tokens) as hit, sum(cache_miss_tokens) as miss,
            sum(completion_tokens) as completion
     from api_usage where bot_id = ? group by day order by day desc limit 14`, bot.id);
  return { day, summary: llm.usageSummary(bot.id, day), byScene, days };
});

// ---------- 日志 ----------

route('GET', '/api/logs', async ({ query }) => {
  const files = listLogFiles(30);                    // [{ name, full }]，路径已校验过
  const names = files.map((f) => f.name);
  const want = names.includes(query.file)
    ? query.file
    : names.filter((n) => n.startsWith('system-')).pop() ?? names[0] ?? '';
  if (!want) return { files: names, file: '', lines: [] };

  const entry = files.find((f) => f.name === want);
  const text = fs.readFileSync(entry.full, 'utf8');
  const n = Math.min(500, asInt(query.lines ?? 200) || 200);
  return { files: names, file: want, lines: text.split('\n').slice(-n) };
});

route('POST', '/api/logs/export', async () => {
  const file = exportLogBundle(30);
  return { ok: true, file };
});
