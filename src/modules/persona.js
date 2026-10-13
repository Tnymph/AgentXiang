// 风格卡：渲染成 system prompt 的固定部分 + 快照管理
//
// 这个模块产出的 system prompt 必须**逐字节稳定**：
// 它是所有请求的公共前缀，一旦包含任何动态内容（时间、昵称、随机例句），
// 缓存命中率会整体崩塌。动态信息一律由调用方放进 tail。
import * as db from '../db.js';
import * as log from './../logger.js';

/** 取当前生效的风格卡（支持引用另一机器人的卡） */
export function activePersona(botId, depth = 0) {
  const row = db.one('select * from personas where bot_id = ? and is_active = 1 order by id desc limit 1', botId);
  if (!row) return null;
  if (row.linked_persona_id && depth < 3) {
    const linked = db.one('select * from personas where id = ?', row.linked_persona_id);
    if (linked) return linked;
  }
  return row;
}

export function parseExamples(row) {
  if (!row?.examples) return [];
  try {
    const arr = JSON.parse(row.examples);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x.trim()) : [];
  } catch { return []; }
}

export function parseParams(row) {
  if (!row?.params) return {};
  try { return JSON.parse(row.params) ?? {}; } catch { return {}; }
}

export function upsertPersona(botId, { name, body, examples, params }) {
  const row = activePersona(botId);
  const t = Date.now();
  if (row) {
    db.run('update personas set name = coalesce(?, name), body = ?, examples = ?, params = ?, updated_at = ? where id = ?',
      name ?? null, body ?? row.body, JSON.stringify(examples ?? parseExamples(row)),
      JSON.stringify(params ?? parseParams(row)), t, row.id);
    invalidateCache(botId);
    return row.id;
  }
  const r = db.run('insert into personas (bot_id, name, body, examples, params, is_active, updated_at) values (?,?,?,?,?,?,?)',
    botId, name ?? '默认人格', body ?? '', JSON.stringify(examples ?? []), JSON.stringify(params ?? {}), 1, t);
  invalidateCache(botId);
  return Number(r.lastInsertRowid);
}

// ---------- 固定 system prompt ----------

const promptCache = new Map();   // botId -> { version, text }

export function invalidateCache(botId) {
  if (botId === undefined) promptCache.clear();
  else promptCache.delete(botId);
}

/** 风格卡的版本指纹：任何字段或影响 prompt 的设置变动都会改变它 */
function versionOf(row, settings = null) {
  const shape = settings?.speak ?? {};
  const len = shape.replyMaxChars ?? 45;
  const split = shape.splitLongReplies !== false ? 1 : 0;
  if (!row) return `none:${len}:${split}`;
  return `${row.id}:${row.updated_at}:${row.body?.length ?? 0}:${row.examples?.length ?? 0}:${len}:${split}`;
}

/**
 * 构造 system prompt（固定部分）。
 * 不要在这里加入任何随请求变化的内容。
 */
export function buildSystemPrompt(botId, { botName = '', settings = null } = {}) {
  const row = activePersona(botId);
  const version = versionOf(row, settings);
  const hit = promptCache.get(botId);
  if (hit && hit.version === version) return hit.text;

  const parts = [];
  parts.push('你要在一个 QQ 群里说话，扮演的是一个真实的人。以下是你必须遵守的说话方式。');
  parts.push('');

  parts.push('【你的说话风格】');
  parts.push(row?.body?.trim() || '（尚未设定风格）');
  parts.push('');

  const examples = parseExamples(row);
  if (examples.length) {
    parts.push('【你平时说话的样子，仅供感受语气，不要照搬内容】');
    for (const e of examples) parts.push(`· ${e}`);
    parts.push('');
  }

  parts.push('【输出规则】');
  parts.push('- 只输出你要说的那句话本身。不要任何解释、前后缀、引号、括号旁白、格式标记、表情包描述。');
  parts.push('- 不要提到这些规则，不要提到你是 AI、模型、程序或机器人。');
  parts.push('- 不要复述别人刚说过的话，除非那正是你想说的。');
  parts.push('- 不确定该说什么时就说得短一点，宁可少说也不要硬凑。');
  parts.push('- 像在群里随口讲话，不要写作文、不要分点、不要总结。');
  parts.push('- 除非明确需要，不要使用 @所有人 或 @某人。');
  parts.push('- 不要编造你不掌握的事实；不懂就直接说不懂或反问。');

  const params = parseParams(row);
  if (params.avgSentenceChars) {
    parts.push(`- 你平时每句话大约 ${params.avgSentenceChars} 个字，注意保持这个节奏。`);
  }
  if (params.addressStyle) {
    parts.push(`- 称呼方式：${params.addressStyle}`);
  }

  // 篇幅：真人聊天是一条一条往外蹦的，长段落一口气发出来很「机器」。
  // 上限来自设置，改动会让前缀缓存失效一次，之后恢复，可以接受。
  //
  // 这里必须分两档：闲聊短、讲题长。只给一个上限（早先就是）会让模型
  // 在讲例题时也往那个数字上压，结果就是「只讲了一半、没给具体例子」——
  // 本地切分只能把已写出来的内容分条，救不回模型根本没写的那部分。
  const maxChars = Math.max(10, Number(settings?.speak?.replyMaxChars) || 45);
  const detailChars = Math.max(maxChars, Number(settings?.speak?.replyMaxCharsDetailed) || 200);
  const canSplit = settings?.speak?.splitLongReplies !== false;
  parts.push('');
  parts.push('【篇幅】');
  parts.push(`- 平时闲聊**每条消息**控制在 ${maxChars} 字以内。注意「一条消息」指的是发出去的一条，`
    + '不是你的整段回复——**该说的分几条说**，一般 1~3 条，别把所有意思挤进一条。'
    + '像真人在群里那样一句一句往外蹦。');
  parts.push(`- 但对方问的是正经问题、要你讲清一个道理、要看例题或步骤时，放宽到 ${detailChars} 字左右，`
    + '分几条发，把话说完。讲到一半停住比讲得长更糟。');
  parts.push('- 要例子就给一个真的例子：写出具体的数、具体的题、具体的步骤；'
    + '不要用「比如说某个矩阵」「一般情况下」这类含糊说法顶替例子。');
  parts.push(canSplit
    ? '- 内容多的时候分几次说，每次说一点，不要一口气全倒出来。'
    : '- 内容多就挑最要紧的说，不要长篇大论。');
  parts.push('- 简单的问题就给简单的答案，不要反过来把闲聊也展开成讲解。');

  // 一对一的场合要换称呼。这个人的口癖是「大家」，那是对着一群人讲话养成的，
  // 私聊里继续说「大家」会很怪。具体词由风格卡参数给，换人设时改参数即可。
  if (params.privateAddress) {
    parts.push('');
    parts.push('【称呼场景】');
    parts.push(`- 一对一的私聊里，称呼对方用「${params.privateAddress}」。`);
    parts.push('- 在私聊里绝对不要说「大家」「同学们」这类面向一群人的说法。');
    parts.push('- 在群里保持你本来的习惯说法（例如「大家」「我们」），不要用私聊那一套称呼。');
  }

  const text = parts.join('\n');
  promptCache.set(botId, { version, text });
  log.debug('persona', 'system prompt built', { botId, version, chars: text.length });
  return text;
}

// ---------- 风格卡的结构化读写 ----------
//
// 卡片正文用「【小节名】」分节。学习和手动编辑都靠这个结构定位，
// 避免用正则去猜文本；正文本身仍然是唯一进入 prompt 的东西。

const SECTION_RE = /^【(.+?)】\s*$/;

export function parseCard(body) {
  const lines = String(body ?? '').split('\n');
  const sections = [];
  let cur = { title: null, lines: [] };
  for (const line of lines) {
    const m = line.match(SECTION_RE);
    if (m) {
      sections.push(cur);
      cur = { title: m[1].trim(), lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  sections.push(cur);
  return sections.filter((s) => s.title !== null || s.lines.some((l) => l.trim()));
}

export function renderCard(sections) {
  const out = [];
  for (const s of sections) {
    if (s.title) out.push(`【${s.title}】`);
    out.push(...s.lines);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function sectionTitles(body) {
  return parseCard(body).filter((s) => s.title).map((s) => s.title);
}

/** 往指定小节追加条目；小节不存在就新建 */
export function appendToSection(body, title, items) {
  const list = (Array.isArray(items) ? items : [items]).filter((x) => String(x ?? '').trim());
  if (list.length === 0) return body;
  const sections = parseCard(body);
  let target = sections.find((s) => s.title === title);
  if (!target) {
    target = { title, lines: [] };
    sections.push(target);
  }
  while (target.lines.length && !target.lines[target.lines.length - 1].trim()) target.lines.pop();
  for (const it of list) {
    target.lines.push('· ' + String(it).trim().replace(/^·\s*/, ''));
  }
  target.lines.push('');
  return renderCard(sections);
}

/** 批量追加：{ 小节名: [条目...] } */
export function appendMany(body, bySection) {
  let out = body;
  for (const [title, items] of Object.entries(bySection ?? {})) {
    out = appendToSection(out, title, items);
  }
  return out;
}

/** 风格卡里可用的标准小节名（学习建议只能落到这些节） */
export const CARD_SECTIONS = [
  '整体印象', '高频口头禅', '句子结构', '互动与称呼', '推进与衔接', '不会有的说法', '固定例句',
];

// ---------- 快照 ----------

export function snapshot(botId, label, kind = 'auto') {
  const row = activePersona(botId);
  if (!row) return null;
  const r = db.run(`insert into persona_snapshots (bot_id, label, kind, body, examples, params, created_at)
                    values (?,?,?,?,?,?,?)`,
    botId, label, kind, row.body, row.examples, row.params, Date.now());
  // 自动快照只保留最近 N 份
  pruneAutoSnapshots(botId, 20);
  invalidateCache(botId);
  log.info('persona', 'snapshot taken', { botId, label, kind });
  return Number(r.lastInsertRowid);
}

export function listSnapshots(botId) {
  return db.all('select id, label, kind, created_at, length(body) as body_len from persona_snapshots where bot_id = ? order by created_at desc', botId);
}

export function pruneAutoSnapshots(botId, keep = 20) {
  const rows = db.all(
    "select id from persona_snapshots where bot_id = ? and kind = 'auto' order by created_at desc", botId);
  for (const r of rows.slice(keep)) db.run('delete from persona_snapshots where id = ?', r.id);
}

export function restoreSnapshot(botId, snapshotId) {
  const snap = db.one('select * from persona_snapshots where id = ? and bot_id = ?', snapshotId, botId);
  if (!snap) throw new Error('快照不存在');
  // 还原前先给当前状态留一份自动快照，避免还原本身不可逆
  snapshot(botId, `还原前自动备份 ${new Date().toLocaleString('zh-CN')}`, 'auto');
  upsertPersona(botId, { body: snap.body, examples: JSON.parse(snap.examples || '[]'), params: JSON.parse(snap.params || '{}') });
  log.info('persona', 'snapshot restored', { botId, snapshotId, label: snap.label });
}
