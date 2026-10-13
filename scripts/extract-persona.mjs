// 风格卡提炼：把 68k 字转写稿提炼成一张风格卡
//
// 两阶段 map-reduce：
//   map    —— 每个分P 各自提炼一次（system prompt 完全固定，跨分P 共享缓存，实测命中约 90%）
//   reduce —— 合并成最终风格卡 + 精选例句 + 行为参数
//
// 中间产物落在 data/work/persona/ 下，可中断续跑。
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, TRANSCRIPT_DIR, SAMPLES_FILE, NOTES_FILE, DATA_DIR } from '../src/paths.js';
import { MAP_SYSTEM, REDUCE_SYSTEM } from '../src/prompts.js';
import * as log from '../src/logger.js';
import * as db from '../src/db.js';
import * as secrets from '../src/secrets.js';
import * as llm from '../src/llm.js';

ensureDirs();
db.openDb();

const WORK = path.join(DATA_DIR, 'work', 'persona');
fs.mkdirSync(WORK, { recursive: true });

const botId = db.getBot(1)?.id ?? db.createBot('主机器人', '10001');
const apiKey = secrets.getApiKey(botId);
if (!apiKey) { console.error('未配置 API Key'); process.exit(1); }

const settings = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' };
const MAP_BUDGET = 4096;
const REDUCE_BUDGET = 8192;

// ---------- 工具 ----------

/** 从可能带代码块标记的回复里抠出 JSON */
export function extractJson(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/^```(?:json)?|```$/gm, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

function readIfExists(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; } catch { return ''; }
}

function meaningfulLines(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

async function askJson({ scene, system, tail, maxTokens }) {
  // 思考 token 与可见输出共享 max_tokens 预算。预算不足时会被思考吃光、
  // 返回空 content（实测 max_tokens=1200 时 reasoning 也正好 1200，content 为空）。
  // 所以必须检测截断并自动扩容重试。
  let budget = maxTokens;
  for (let round = 0; round < 3; round++) {
    const r = await llm.chat({
      botId, apiKey, ...settings, scene,
      system, history: [], tail,
      effort: llm.pickEffort('auto', scene),
      maxTokens: budget,
      temperature: 0.3,
    });
    if (!r.ok) return { ok: false, error: r.error, body: r.body };

    const empty = !r.text || r.text.trim().length === 0;
    const truncated = r.finishReason === 'length';
    if (empty || truncated) {
      log.warn('persona', '输出被吃光或截断，扩容重试', {
        budget, finish: r.finishReason, reasoning: r.usage?.reasoning, empty,
      });
      budget *= 2;
      continue;
    }
    const json = extractJson(r.text);
    if (!json) return { ok: false, error: 'JSON 解析失败', raw: r.text.slice(0, 500) };
    return { ok: true, json, usage: r.usage };
  }
  return { ok: false, error: '扩容重试后仍失败' };
}

// ---------- 输入 ----------

const parts = fs.readdirSync(TRANSCRIPT_DIR).filter((f) => /^p\d+\.fixed\.txt$/.test(f)).sort();
const samples = meaningfulLines(readIfExists(SAMPLES_FILE));
const notes = meaningfulLines(readIfExists(NOTES_FILE));

log.info('persona', 'start', { parts: parts.length, samples: samples.length, notes: notes.length });

// ---------- 阶段 1：map ----------

const maps = [];
let totalHit = 0, totalMiss = 0;

for (const f of parts) {
  const name = f.replace('.fixed.txt', '');
  const cacheFile = path.join(WORK, `${name}.json`);
  if (fs.existsSync(cacheFile)) {
    try {
      maps.push(JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
      log.info('persona', 'map cached', { name });
      continue;
    } catch { /* 缓存损坏则重做 */ }
  }

  const text = fs.readFileSync(path.join(TRANSCRIPT_DIR, f), 'utf8');
  const r = await askJson({ scene: 'learn', system: MAP_SYSTEM, tail: `以下是转写稿：\n\n${text}`, maxTokens: MAP_BUDGET });
  if (!r.ok) {
    log.error('persona', 'map failed', { name, err: r.error, body: r.body });
    continue;
  }
  totalHit += r.usage?.cacheHit ?? 0;
  totalMiss += r.usage?.cacheMiss ?? 0;
  const rec = { part: name, ...r.json };
  fs.writeFileSync(cacheFile, JSON.stringify(rec, null, 2), 'utf8');
  maps.push(rec);
  log.info('persona', 'map done', {
    name, tics: rec.verbal_tics?.length ?? 0, quotes: rec.quotes?.length ?? 0,
    hit: r.usage?.cacheHit ?? 0, reasoning: r.usage?.reasoning ?? 0,
  });
}

console.log(`\nmap 阶段完成：${maps.length}/${parts.length} 个分P`);
if (totalHit + totalMiss > 0) {
  console.log(`本次新增调用的前缀缓存命中率：${totalHit}/${totalHit + totalMiss} = ${(totalHit / (totalHit + totalMiss) * 100).toFixed(1)}%`);
}

// ---------- 阶段 2：reduce ----------

const payload = {
  分段分析报告: maps,
  文字样本_带原始标点: samples,
  用户补充的风格说明: notes,
};

const red = await askJson({
  scene: 'learn',
  system: REDUCE_SYSTEM,
  tail:
    '补充说明：素材里「文字样本_带原始标点」是**带原始标点**的（其余来自语音转写、没有标点）。' +
    '所以关于「标点使用习惯」的判断，请只依据那部分文字样本，不要从语音转写里推断。\n\n' +
    JSON.stringify(payload),
  maxTokens: REDUCE_BUDGET,
});

if (!red.ok) {
  log.error('persona', 'reduce failed', { err: red.error, body: red.body, raw: red.raw });
  console.error('reduce 阶段失败：', red.error);
  process.exit(1);
}

fs.writeFileSync(path.join(WORK, 'final.json'), JSON.stringify(red.json, null, 2), 'utf8');

// ---------- 组装风格卡正文 ----------

export function renderPersonaCard(j) {
  const L = [];
  const section = (title, arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return;
    L.push(`【${title}】`);
    for (const x of arr) L.push(`· ${x}`);
    L.push('');
  };
  if (j.summary) { L.push('【整体印象】'); L.push(String(j.summary)); L.push(''); }
  section('高频口头禅', j.verbal_tics);
  section('句子结构', j.sentence_style);
  section('互动与称呼', j.interaction);
  section('推进与衔接', j.discourse_moves);
  section('不会有的说法', j.avoid);
  return L.join('\n').trim();
}

const body = renderPersonaCard(red.json);
const examples = Array.isArray(red.json.examples) ? red.json.examples : [];
const params = red.json.params ?? {};

// ---------- 落库 ----------

const existing = db.one('select * from personas where bot_id = ? and is_active = 1', botId);
const t = Date.now();
if (existing) {
  db.run('update personas set body = ?, examples = ?, params = ?, updated_at = ? where id = ?',
    body, JSON.stringify(examples), JSON.stringify(params), t, existing.id);
} else {
  db.run('insert into personas (bot_id, name, body, examples, params, is_active, updated_at) values (?,?,?,?,?,?,?)',
    botId, '默认人格', body, JSON.stringify(examples), JSON.stringify(params), 1, t);
}

console.log('\n========== 风格卡正文 ==========');
console.log(body);
console.log('\n========== 精选例句 ==========');
examples.forEach((e, i) => console.log(`${i + 1}. ${e}`));
console.log('\n========== 行为参数 ==========');
console.log(JSON.stringify(params, null, 2));
console.log('\n========== 当日 API 用量 ==========');
console.log(JSON.stringify(llm.usageSummary(botId), null, 2));

db.closeDb();
log.closeLogs();
