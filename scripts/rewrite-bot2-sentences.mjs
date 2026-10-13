// 重写猪咪的【句子结构】：去掉「绝不写两句」这个和「连发多条」互相打架的指令，
// 整节理顺，不留重复。
import { ensureDirs } from '../src/paths.js';
import * as db from '../src/db.js';
import * as log from '../src/logger.js';
import * as persona from '../src/modules/persona.js';
import { botSettings } from '../src/config.js';

ensureDirs();
db.openDb();
log.setDebug(false);

const BOT = 2;
const row = persona.activePersona(BOT);
const sections = persona.parseCard(row.body);
const sec = sections.find((s) => s.title === '句子结构');
if (!sec) { console.log('没找到【句子结构】，停'); process.exit(1); }

console.log('════ 改前全文 ════');
sec.lines.forEach((l) => console.log('  ' + l));

// 整节重写：核心是「每条极短 + 连着发几条」，不留任何「绝不写两句」这类反向指令
sec.lines = [
  '· 每条极短，2–10 个字为主。极短是**每条**的要求，不是「整段话只发一条」',
  '· 想到什么就发什么，一句话常常拆成两三条连着发；先一句反应，再一句解释，最后可能再补一句吐槽',
  '· 语气词（笑死、啊？、何意味、干嘛…）多半自己单独占一条',
  '· 一条消息只说一个意思，别把两三件事塞进同一条',
  '· 基本不用句号，语气靠「？」「…」「啊」「呢」「吧」撑',
  '· 会叠字、会拉长：好好好、真的真的、啊啊啊啊',
  '· 不写「首先其次最后」，不列点，不总结',
  '',
];

const snapId = persona.snapshot(BOT, '重写句子结构（连发多条）之前 ' + new Date().toLocaleString('zh-CN'), 'auto');
console.log('');
console.log('已存快照 #' + snapId);
persona.upsertPersona(BOT, { body: persona.renderCard(sections) });

const after = persona.activePersona(BOT);
console.log('');
console.log('════ 改后全文 ════');
persona.parseCard(after.body).find((x) => x.title === '句子结构').lines
  .filter((l) => l.trim()).forEach((l) => console.log('  ' + l));
console.log('');

// 全文体检：还有没有互相打架的指令
const txt = String(after.body);
for (const bad of ['绝不写两句', '别写两句', '不要写两句', '一条就够']) {
  const n = (txt.split(bad).length - 1);
  console.log(`  「${bad}」出现 ${n} 次 ${n ? '← 还在打架，要清掉' : '✓'}`);
}
console.log('');
const s = botSettings(BOT);
console.log('设置：一次最多 ' + s.speak.maxMessages + ' 条，分条间隔 ' + s.speak.segmentDelayMs + ' 毫秒');
console.log('小节：' + persona.sectionTitles(after.body).join(' / '));

db.closeDb();
log.closeLogs();
