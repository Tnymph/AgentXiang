// 按用户的说法调整：一条消息装「几句话」，整串输出再被本地拆成多条。
// 之前设成 1 句一条，是理解偏了。
import { ensureDirs } from '../src/paths.js';
import * as db from '../src/db.js';
import * as log from '../src/logger.js';
import * as persona from '../src/modules/persona.js';
import * as speaking from '../src/modules/speaking.js';
import { botSettings, saveBotSettings } from '../src/config.js';

ensureDirs();
db.openDb();
log.setDebug(false);

const BOT = 2;
const before = botSettings(BOT).speak;
console.log('════ 改前 ════');
console.log('  日常每条最多几句 ' + before.maxSentences + ' / 一次最多发几条 ' + before.maxMessages
  + ' / 字数目标 ' + before.replyMaxChars + ' / 分条间隔 ' + before.segmentDelayMs);

// ① 每条装几句话：1 → 3
saveBotSettings(BOT, {
  speak: {
    maxSentences: 3,
    replyMaxChars: 30,      // 3 句短句大约就是这个长度
    maxMessages: 4,
    segmentDelayMs: 500,
  },
});

const after = botSettings(BOT).speak;
console.log('');
console.log('════ 改后 ════');
console.log('  日常每条最多几句 ' + after.maxSentences + ' / 一次最多发几条 ' + after.maxMessages
  + ' / 字数目标 ' + after.replyMaxChars + ' / 分条间隔 ' + after.segmentDelayMs);

// ② 卡片里那句「一句话常常拆成两三条」是我上一轮写的，措辞会让人以为要一条一句，
//    改成「别压成一条又长又闷的消息」——一条装几句交给设置管。
const row = persona.activePersona(BOT);
const sections = persona.parseCard(row.body);
const sec = sections.find((s) => s.title === '句子结构');
let touched = 0;
sec.lines = sec.lines.map((l) => {
  if (/一句话常常拆成两三条连着发/.test(l)) {
    touched++;
    return '· 想到什么就发什么，一条消息说一个意思；别把话都压成一条又长又闷的消息';
  }
  return l;
});
if (touched) {
  persona.snapshot(BOT, '措辞修正之前 ' + new Date().toLocaleString('zh-CN'), 'auto');
  persona.upsertPersona(BOT, { body: persona.renderCard(sections) });
}
console.log('');
console.log('卡片措辞修正了 ' + touched + ' 处');
const after2 = persona.activePersona(BOT);
console.log('现在【句子结构】里相关的两行：');
persona.parseCard(after2.body).find((x) => x.title === '句子结构').lines
  .filter((l) => /连着发|一个意思|压成/.test(l)).forEach((l) => console.log('  ' + l));

// ③ 切分演示：7 句会怎么分
console.log('');
console.log('════ 切分演示（模型写 7 句）════');
const seven = '笑死我了。这也太抽象了吧。你从哪找的这玩意儿。'
  + '我上周也遇到一个。比这个还离谱。真的绷不住。行了别发了。';
const shape = speaking.replyShape(botSettings(BOT));
const limit = speaking.pickSentenceLimit('在吗', botSettings(BOT));
const parts = speaking.splitReply(seven, { maxSentences: limit.maxSentences, maxMessages: shape.maxMessages });
console.log('  句子数：' + speaking.splitSentences(seven).length
  + '   每条最多 ' + limit.maxSentences + ' 句   最多 ' + shape.maxMessages + ' 条');
parts.forEach((p, k) => console.log(`  [${k + 1}] (${speaking.splitSentences(p).length} 句) ${p}`));
console.log('  → 共 ' + parts.length + ' 条，间隔 ' + shape.segmentDelayMs + ' 毫秒');

db.closeDb();
log.closeLogs();
