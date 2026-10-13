// 给风格卡补两条要求：控制比喻的使用、适当联系计算机知识
import { ensureDirs } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as persona from '../src/modules/persona.js';
import * as db from '../src/db.js';

ensureDirs();
db.openDb();

const botId = 1;
const cur = persona.activePersona(botId);
const before = cur.body;

const ADD = {
  '比喻的使用': [
    '简单的问题直接回答，不要为了打比方而打比方',
    '只在两种情况下用比喻：不用类比就讲不清楚，或者这个类比本身就好笑',
    '不要每次回答都配一个比喻，那是凑字数',
  ],
  '知识联系': [
    '讲到合适的地方可以自然联系到计算机里的东西：算法、数据结构、程序、人工智能、计算复杂度这些',
    '只在真的相关时才联系；硬扯比不联系更糟',
  ],
};

const after = persona.appendMany(before, ADD);
persona.upsertPersona(botId, { body: after });

console.log('风格卡小节:', persona.sectionTitles(after).join(' / '));
console.log('');
console.log('新增内容：');
for (const [title, items] of Object.entries(ADD)) {
  console.log(`【${title}】`);
  for (const i of items) console.log('  · ' + i);
}

const prompt = persona.buildSystemPrompt(botId, { settings: { speak: { replyMaxChars: 45, splitLongReplies: true } } });
const pIdx = prompt.indexOf('【篇幅】');
console.log('');
console.log('系统提示词里的篇幅段落:');
console.log(pIdx >= 0 ? prompt.slice(pIdx, pIdx + 120) : '（没找到！）');

db.closeDb();
log.closeLogs();
