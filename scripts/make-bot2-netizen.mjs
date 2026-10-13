// 把「猪咪群友」调得更像网友：会接梗、会玩梗、会自嘲、说话更碎更跳。
// 同时给它开上网感素材（只对它开），并放宽篇幅到能讲完一个段子。
import { ensureDirs } from '../src/paths.js';
import * as db from '../src/db.js';
import * as log from '../src/logger.js';
import * as persona from '../src/modules/persona.js';
import { botSettings, saveBotSettings } from '../src/config.js';

ensureDirs();
db.openDb();
log.setDebug(false);

const BOT = 2;
const row = persona.activePersona(BOT);
const sections = persona.parseCard(row.body);

const upsert = (title, lines) => {
  const at = sections.findIndex((s) => s.title === title);
  if (at >= 0) sections[at].lines = lines;
  else sections.push({ title, lines });
};

// 在「不会有的说法」之前插入「网友感」这一节
upsert('网友感', [
  '· 你在网上泡大的，说话是「刷」出来的，不是「想」出来的：看到什么先来个反应，再补理由',
  '· 会接梗、会玩梗、会顺着别人甩的梗往下滚一两句，接不住就说接不住，别硬接',
  '· 别人说好笑的，你的第一反应是「哈哈哈哈哈」「笑死」「绷不住了」「草」，而不是分析它为什么好笑',
  '· 爱自嘲、爱摆烂、爱抽象：「我不行」「我废了」「这什么玩意」「典」「唐」「何意味」',
  '· 会直接下判断：「这玩意儿不行」「这个真的好看」「土」「绝了」，不端着',
  '· 也会突然认真一句，但马上又自己拆台（「不过说真的…算了当我没说」）',
  '· 不用教科书式的话夸人，说「可以可以」「有点东西」「牛的」就够了',
  '',
]);

// 网上刷到的东西可以拿出来说，但要有分寸
upsert('网上刷到的', [
  '· 你平时在网上刷各种东西，有时候会说「今天刷到个好笑的」然后讲出来',
  '· 讲的时候用你自己的话讲，别念出处、别说「网上说」',
  '· 只讲真的觉得好笑的；不好笑就别讲，也别硬凑一个梗',
  '· 段子讲完不用等反应，接一句自己的吐槽更自然',
  '',
]);

const snapId = persona.snapshot(BOT, '调成网友风格之前 ' + new Date().toLocaleString('zh-CN'), 'auto');
console.log('已存快照 #' + snapId);
persona.upsertPersona(BOT, { body: persona.renderCard(sections) });

// 它要能讲完一个段子，所以讲解档放长一点；闲聊仍然很短
saveBotSettings(BOT, {
  api: {
    // 只给猪咪开：会从一言抓「抖机灵 / 来自网络」当素材
    webJokes: { enabled: true, randomRate: 0, timeoutMs: 9000 },
  },
  speak: {
    replyMaxChars: 20,             // 闲聊还是极短
    replyMaxCharsDetailed: 120,    // 讲个段子/说件事的时候允许说完整
    maxSentencesDetailed: 3,
  },
});

const after = persona.activePersona(BOT);
console.log('');
console.log('小节：' + persona.sectionTitles(after.body).join(' / '));
const s = botSettings(BOT);
console.log('篇幅：闲聊 ' + s.speak.replyMaxChars + ' 字 / 讲事情 ' + s.speak.replyMaxCharsDetailed + ' 字');
console.log('网感素材：' + JSON.stringify(s.api.webJokes));
console.log('');
const sec = persona.parseCard(after.body).find((x) => x.title === '网友感');
console.log('【网友感】写成了：');
console.log(sec.lines.filter((l) => l.trim()).map((l) => '  ' + l).join('\n'));

db.closeDb();
log.closeLogs();
