// 验证身份设定：问「你是谁」时说的是不是卡片里写的那个身份
//
// 直接读生产库里的卡片（bot 1）拼出 system prompt，再问真实模型。
// 只读卡片、只调模型，不改任何数据。
import { ensureDirs } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as llm from '../src/llm.js';
import * as persona from '../src/modules/persona.js';
import * as db from '../src/db.js';
import * as secrets from '../src/secrets.js';

ensureDirs();
db.openDb();
log.setDebug(false);

const settings = (await (await fetch('http://127.0.0.1:6188/api/bots/1/settings')).json()).settings;
const apiKey = secrets.getApiKey(1);
if (!apiKey) { console.log('没有密钥'); process.exit(1); }

// 先把卡片里【你的身份】那一节原样打出来，好对照模型的回答
const card = persona.activePersona(1);
const sec = persona.parseCard(card.body ?? '').find((s) => s.title === '你的身份');
console.log('════ 卡片里【你的身份】现在写的是 ════');
console.log(sec ? sec.lines.filter((l) => l.trim()).map((l) => '  ' + l).join('\n') : '  （没有这一节）');
console.log('');

const system = persona.buildSystemPrompt(1, { settings });

const questions = [
  '你是哪位',
  '介绍一下你自己',
  '你是张小向吗',
  '老师你叫什么名字',
  '你是哪个学校的',
  '你是AI吗',
];

// 不该再出现的自称。
// 注意区分「否认」和「自称」：问「你是张小向吗」时它答「我不是张小向」，
// 那正是我们要的答案，不能算问题。只有肯定地自称才算。
const NAME = '(张老师|张小向|小张)';
const CLAIM = new RegExp(`(我是|我?叫)\\s*${NAME}`);
const DENY = new RegExp(`(不是|不叫|并非)\\s*${NAME}`);
const badClaim = (t) => CLAIM.test(t) && !DENY.test(t);
// 期望出现的身份
const GOOD = /东南大学|高代|高等代数/;

console.log('════ 真实模型实测 ════');
let badName = 0, noGood = 0, selfAi = 0, invented = 0;
for (const q of questions) {
  const tail = `〔现在在群里〕说话的人是「跳蝻」。\n\n〔他说〕${q}`;
  const r = await llm.chat({
    botId: 1, apiKey,
    baseUrl: settings.api.baseUrl, model: settings.api.model,
    scene: 'chat', system, history: [], tail,
    effort: 'low', maxTokens: llm.DEFAULT_MAX_TOKENS,
  });
  const t = (r.text ?? '').trim();
  const hasBad = badClaim(t);
  const denied = DENY.test(t);
  // 问到身份时才要求出现学校；问「你是AI吗」不必硬塞学校名
  const needGood = /东南大学|高代|高等代数/.test(q) || /你是哪位|介绍一下你自己|叫什么/.test(q);
  const hasGood = GOOD.test(t);
  const isAi = /(我是|作为).{0,4}(AI|人工智能|机器人|助手|模型)/.test(t);
  const inv = /讲者/.test(t);

  if (hasBad) badName++;
  if (needGood && !hasGood) noGood++;
  if (isAi) selfAi++;
  if (inv) invented++;

  console.log(`Q: ${q}`);
  console.log(`A: ${t}`);
  console.log(`   肯定自称旧名字? ${hasBad ? '是 ✗' : '否 ✓'}${denied ? '（本题它明确否认了旧名字，正合预期）' : ''}` +
    `   提到东南大学/高代? ${hasGood ? '是 ✓' : (needGood ? '没有 ✗' : '没提（本题不要求）')}` +
    `   自称AI? ${isAi ? '是 ✗' : '否 ✓'}` +
    `   编「讲者」? ${inv ? '是 ✗' : '否 ✓'}`);
  console.log('');
}

console.log('════ 判定 ════');
console.log(`  出现旧名字（张老师/张小向）的：${badName} / ${questions.length}  ${badName ? '✗' : '✓'}`);
console.log(`  该说身份却没说的：${noGood}  ${noGood ? '✗' : '✓'}`);
console.log(`  自称 AI 的：${selfAi}  ${selfAi ? '✗' : '✓'}`);
console.log(`  又编「讲者」的：${invented}  ${invented ? '✗' : '✓'}`);
console.log('');
console.log(badName === 0 && noGood === 0 ? '结论：身份已按卡片走，不再自称旧名字。' : '结论：还有问题，见上面标 ✗ 的行。');
console.log('注意：群里若还有旧历史（它以前说过「我是张老师」），模型可能顺着历史继续那样说，');
console.log('      那属于历史残留，等旧消息滑出记忆窗口就会消失。');

db.closeDb();
log.closeLogs();
