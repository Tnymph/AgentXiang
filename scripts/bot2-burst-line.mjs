// 在猪咪自己的卡片里写清「一次通常分几条发」——共用提示词不该为它写死条数，
// 卡片才是每个机器人各自风格的家。
import { ensureDirs } from '../src/paths.js';
import * as db from '../src/db.js';
import * as log from '../src/logger.js';
import * as persona from '../src/modules/persona.js';
import * as speaking from '../src/modules/speaking.js';
import { botSettings } from '../src/config.js';

ensureDirs();
db.openDb();
log.setDebug(false);

const BOT = 2;
const row = persona.activePersona(BOT);
const sections = persona.parseCard(row.body);
const sec = sections.find((s) => s.title === '句子结构');

const LINE = '· 一次回复**通常分成 2~3 条**发出去，每条一两句，不要一条消息把所有话说完';

sec.lines = sec.lines.filter((l) => !/通常分成 2/.test(l));
// 插在「想到什么就发什么」那条后面
const at = sec.lines.findIndex((l) => /想到什么就发什么/.test(l));
sec.lines.splice(at >= 0 ? at + 1 : 0, 0, LINE);

persona.snapshot(BOT, '加「通常分 2~3 条」之前 ' + new Date().toLocaleString('zh-CN'), 'auto');
persona.upsertPersona(BOT, { body: persona.renderCard(sections) });

const after = persona.activePersona(BOT);
console.log('【句子结构】现在：');
persona.parseCard(after.body).find((x) => x.title === '句子结构').lines
  .filter((l) => l.trim()).forEach((l) => console.log('  ' + l));
console.log('');

const s = botSettings(BOT);
const shape = speaking.replyShape(s);
const limit = speaking.pickSentenceLimit('在吗', s);
console.log('本地拆分规则：每条最多 ' + limit.maxSentences + ' 句 / 最多 ' + shape.maxMessages
  + ' 条 / 间隔 ' + shape.segmentDelayMs + 'ms');
console.log('  模型写 3 句 → 1 条；写 6 句 → 2 条；写 9 句 → 3 条');
const demo = '笑死我了\n这也太抽象了\n你从哪找的\n我上周也遇到一个\n比这个还离谱\n真的绷不住';
const parts = speaking.splitReply(demo, { maxSentences: limit.maxSentences, maxMessages: shape.maxMessages });
console.log('  演示（6 句）：→ ' + parts.length + ' 条');
parts.forEach((p, i) => console.log(`    [${i + 1}] ${JSON.stringify(p)}`));

db.closeDb();
log.closeLogs();
