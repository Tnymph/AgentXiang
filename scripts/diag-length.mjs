// 诊断「专业问题答不完整」：篇幅设置、提示词里的篇幅段落、以及切分会不会丢内容
import { ensureDirs } from '../src/paths.js';
import * as db from '../src/db.js';
import * as log from '../src/logger.js';
import * as persona from '../src/modules/persona.js';
import * as speaking from '../src/modules/speaking.js';
import { botSettings } from '../src/config.js';

ensureDirs();
db.openDb();
log.setDebug(false);

for (const bot of db.listBots()) {
  const s = botSettings(bot.id);
  const sp = s.speak ?? {};
  console.log('════ 机器人 #' + bot.id + ' ' + bot.name + ' 的篇幅设置 ════');
  console.log('  replyMaxChars（提示词里的字数目标）  ' + sp.replyMaxChars);
  console.log('  maxSentences（日常每条最多几句）      ' + sp.maxSentences);
  console.log('  maxSentencesDetailed（讲解最多几句）  ' + sp.maxSentencesDetailed);
  console.log('  maxMessages（一次最多发几条）         ' + sp.maxMessages);
  console.log('  splitLongReplies（超长是否拆条）      ' + (sp.splitLongReplies !== false));
  console.log('  讲解关键词（自定义）                 ' + JSON.stringify(sp.detailedKeywords ?? '(用内置)'));
  console.log('');
}

console.log('════ 提示词里实际写的篇幅要求（机器人 1）════');
const s1 = botSettings(1);
const prompt = persona.buildSystemPrompt(1, { botName: '客服小向', settings: s1 });
const lines = prompt.split('\n');
const i = lines.findIndex((l) => l.includes('【篇幅】'));
console.log(lines.slice(i, i + 6).map((l) => '  ' + l).join('\n'));

console.log('');
console.log('════ 切分会不会丢内容 ════');
// 造一段「完整讲解」看它被切成几条、内容有没有丢
const long = '我们来看一个具体的例子。设 A 是一个三阶方阵，第一行是 1 2 3，第二行是 4 5 6，第三行是 7 8 10。' +
  '我们先算它的行列式，按第一行展开，得到 1×(5×10−6×8) − 2×(4×10−6×7) + 3×(4×8−5×7)。' +
  '算出来是 1×2 − 2×(−2) + 3×(−3) = 2 + 4 − 9 = −3。因为行列式不是零，所以这个矩阵可逆。' +
  '接下来我们求它的逆矩阵，用伴随矩阵法，先把每个元素的代数余子式写出来。';
console.log('  原文 ' + long.length + ' 字');
const shape = speaking.replyShape(s1);
const parts = speaking.splitReply(long, {
  maxSentences: shape.maxSentencesDetailed, maxMessages: shape.maxMessages, maxChars: shape.maxChars,
});
console.log('  讲解档切成了 ' + parts.length + ' 条：');
let total = 0;
parts.forEach((p, k) => { total += p.length; console.log(`    [${k + 1}] (${p.length} 字) ${p.slice(0, 60)}…`); });
console.log('  切分后合计 ' + total + ' 字（原文 ' + long.length + ' 字）→ ' + (total >= long.length * 0.95 ? '没丢内容 ✓' : '⚠️ 丢了内容'));
console.log('');
console.log('  注意：提示词里的「一次发言控制在 ' + (s1.speak?.replyMaxChars) + ' 字以内」是模型看到的硬指标，');
console.log('  它会让模型主动把讲解压到那个长度——切分只是把已写出来的内容分条，救不回没写的部分。');

db.closeDb();
log.closeLogs();
