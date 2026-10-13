// 拿真实模型试「猪咪群友」的人格效果。
// 看完输出再决定卡片要不要改——卡片写得再漂亮，出来不像年轻人就是废的。
import { ensureDirs } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as persona from '../src/modules/persona.js';
import { botSettings } from '../src/config.js';
import * as db from '../src/db.js';
import * as secrets from '../src/secrets.js';
import { chat } from '../src/llm.js';

ensureDirs();
db.openDb();

const BOT = 2;
const bot = db.getBot(BOT);
const settings = botSettings(BOT);
const system = persona.buildSystemPrompt(BOT, { botName: bot?.name ?? '', settings });
const apiKey = secrets.getApiKey(BOT) ?? secrets.getApiKey();

if (!apiKey) {
  console.log('机器人 2 没配 API key，读不到就跳过。');
  db.closeDb();
  log.closeLogs();
  process.exit(0);
}

// 几条典型场景：问事、夸、吐槽、没头没尾的一句话、被要求解释
const CASES = [
  { label: '有人问「今天怎么没来上课」', user: '猫猫你今天咋没来上课' },
  { label: '有人发了张吃的图（图上只是文字）', user: '[图片] 我刚吃的这个好好吃' },
  { label: '有人夸它', user: '猪咪你好可爱啊' },
  { label: '有人吐槽作业', user: '这作业也太多了吧 我写不完了' },
  { label: '有人问一个正经问题', user: '线性代数的行列式到底怎么算啊 讲一下' },
  { label: '群里有人发了条冷场的话', user: '我今天洗了三双袜子' },
  { label: '有人 @ 它但不说话（空消息）', user: '@猪咪群友' },
];

for (const c of CASES) {
  const r = await chat({
    botId: BOT,
    apiKey,
    baseUrl: settings.api?.baseUrl,
    model: settings.api?.model,
    scene: 'chat',
    system,
    history: [],
    tail: c.user,
    effort: 'low',
    maxTokens: 2048,
  });
  const text = (r.text ?? '').trim();
  console.log('──────────────────────────────────────────');
  console.log('场景：' + c.label);
  console.log('对方：' + c.user);
  console.log('猪咪：' + (text || `（没输出 · finish=${r.finishReason} reasoning=${r.usage?.reasoning ?? 0}）`));
}

db.closeDb();
log.closeLogs();
