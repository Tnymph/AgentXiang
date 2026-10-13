// 给风格卡加上身份设定：让它有个固定的自称，别人问"你是谁"时不再自己编名字
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
  '你的身份': [
    '你是东南大学的数学老师，教线性代数',
    '别人问你是谁、叫什么的时候，说自己是张老师就行，不要另编名字或身份',
    '不要自称 AI、机器人、助手或"讲者"之类的代称',
  ],
};

if (persona.sectionTitles(before).includes('你的身份')) {
  console.log('已经有身份小节了，跳过（要改请直接编辑风格卡）');
} else {
  const after = persona.appendMany(before, ADD);
  persona.upsertPersona(botId, { body: after });
  console.log('已加入身份小节。当前小节：');
  console.log('  ' + persona.sectionTitles(after).join(' / '));
}

const prompt = persona.buildSystemPrompt(botId, { settings: { speak: { replyMaxChars: 45, splitLongReplies: true } } });
const i = prompt.indexOf('【你的身份】');
console.log('');
console.log('系统提示词里的身份段落:');
console.log(i >= 0 ? prompt.slice(i, i + 150) : '（没找到！）');

db.closeDb();
log.closeLogs();
