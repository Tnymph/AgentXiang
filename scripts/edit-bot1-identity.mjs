// 改机器人 1 的【你的身份】：去掉名字，只留「东南大学高代教授」
//
// 先自动存一份快照（风格卡接口不会自动存），再精确替换那一节，
// 正文以外的东西（例句、行为参数）一概不碰。
import { ensureDirs } from '../src/paths.js';
import * as db from '../src/db.js';
import * as log from '../src/logger.js';
import * as persona from '../src/modules/persona.js';
import { botSettings } from '../src/config.js';

ensureDirs();
db.openDb();
log.setDebug(false);

const BOT = 1;
const SECTION = '你的身份';

// 先看印象里那条提到「张老师」的（那是机器人对某个人的记忆，别改错地方）
console.log('════ 印象里提到「张老师」的记录 ════');
for (const r of db.all(
  `select i.person_id, i.facts, i.feelings from impressions i where i.bot_id = ?`, BOT)) {
  const all = `${r.facts}\n${r.feelings}`;
  if (/张老师/.test(all)) {
    console.log(`  person_id=${r.person_id}`);
    console.log(`    facts:    ${r.facts}`);
    console.log(`    feelings: ${r.feelings}`);
  }
}
console.log('  （这是「机器人对某人的记忆」，不是自我介绍，这次不动）');
console.log('');

const row = persona.activePersona(BOT);
const sections = persona.parseCard(row.body);
const target = sections.find((s) => s.title === SECTION);
if (!target) { console.log('没找到【' + SECTION + '】小节，停止'); process.exit(1); }

console.log('════ 改前 ════');
console.log(target.lines.map((l) => '  ' + l).join('\n'));
console.log('');

const NEW_LINES = [
  '· 你是东南大学教高等代数的教授',
  '· 别人问你是谁、叫什么的时候，就说自己是东南大学教高等代数的教授；不要编名字，也不要另编身份',
  '· 不要自称 AI、机器人、助手或"讲者"之类的代称',
  '',
];

// 快照 → 改
const snapId = persona.snapshot(BOT, '改【你的身份】之前 ' + new Date().toLocaleString('zh-CN'), 'auto');
console.log('已存快照 #' + snapId + '（万一不满意可回退）');
console.log('');

target.lines = NEW_LINES;
const nextBody = persona.renderCard(sections);

// 只传 body：例句与行为参数保持原样（upsertPersona 里 undefined 会沿用旧值）
persona.upsertPersona(BOT, { body: nextBody });

const after = persona.activePersona(BOT);
const afterSection = persona.parseCard(after.body).find((s) => s.title === SECTION);
console.log('════ 改后 ════');
console.log(afterSection.lines.map((l) => '  ' + l).join('\n'));
console.log('');

console.log('════ 没被碰坏的东西 ════');
console.log('  小节数量：' + persona.sectionTitles(after.body).length + '（改前 ' + persona.sectionTitles(row.body).length + '）');
console.log('  例句条数：' + persona.parseExamples(after).length + '（改前 ' + persona.parseExamples(row).length + '）');
console.log('  行为参数：' + JSON.stringify(persona.parseParams(after)));
console.log('  别名（触发用，没动）：' + JSON.stringify(botSettings(BOT).speak?.aliases ?? []));
console.log('');

console.log('════ 全文里还剩没剩名字 ════');
const txt = String(after.body);
console.log('  正文里「张小向」：' + (txt.match(/张小向/g) ?? []).length + ' 处');
console.log('  正文里「张老师」：' + (txt.match(/张老师/g) ?? []).length + ' 处');
console.log('  正文里「小向」：' + (txt.match(/小向/g) ?? []).length + ' 处');
console.log('');

console.log('════ 实际送进模型的指令（相关那几行）════');
const prompt = persona.buildSystemPrompt(BOT, { botName: '客服小向', settings: botSettings(BOT) });
prompt.split('\n').filter((l) => /身份|教授|老师|名字/.test(l)).forEach((l) => console.log('  ' + l));

db.closeDb();
log.closeLogs();
