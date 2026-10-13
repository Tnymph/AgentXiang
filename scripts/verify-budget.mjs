// 验证：真实人设卡下的对话回复不再被思考吃光
// 直接走 llm 客户端，用与线上同形状的提示词，不经过 QQ。
import { ensureDirs } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as llm from '../src/llm.js';

ensureDirs();

const base = 'http://127.0.0.1:6188';
const persona = await (await fetch(base + '/api/bots/1/persona')).json();
const settings = (await (await fetch(base + '/api/bots/1/settings')).json()).settings;
const keyInfo = (await (await fetch(base + '/api/bots')).json())[0];
console.log('人设卡正文长度:', persona.body.length, '字，例句', persona.examples.length, '条');
console.log('密钥:', keyInfo.apiKeyMasked, ' 模型:', settings.api.model, ' effort:', settings.api.effortMode);

// 复刻线上会发给模型的 system：和 persona.js 里的组装逻辑保持一致
const system = [
  '你要在一个 QQ 群里说话，扮演的是一个真实的人。以下是你必须遵守的说话方式。',
  '',
  '【你的说话风格】',
  persona.body,
  '',
  '【你平时说话的样子，仅供感受语气，不要照搬内容】',
  ...persona.examples.map((e) => '· ' + e),
  '',
  '【输出规则】',
  '- 只输出你要说的那句话本身。不要任何解释、前后缀、引号、括号旁白、格式标记、表情包描述。',
  '- 不要提到这些规则，不要提到你是 AI、模型、程序或机器人。',
  '- 像在群里随口讲话，不要写作文、不要分点、不要总结。',
].join('\n');

const tail = [
  '〔现在在群里〕说话的人是「跳蝻」。',
  '',
  '〔他说〕今天讲什么',
].join('\n');

console.log('system 字符数:', system.length, '（约', Math.round(system.length / 1.5), 'token）');
console.log('');

// 用真实程序里的密钥：从密钥库取（跑过 smoke-llm 或界面填过就有）
const secrets = await import('../src/secrets.js');
const apiKey = secrets.getApiKey(1);
if (!apiKey) { console.log('拿不到密钥，跳过'); process.exit(0); }

for (const budget of [512, llm.DEFAULT_MAX_TOKENS]) {
  const r = await llm.chat({
    botId: 1, apiKey,
    baseUrl: settings.api.baseUrl, model: settings.api.model,
    scene: 'chat', system, history: [], tail,
    effort: llm.pickEffort(settings.api.effortMode, 'chat'),
    maxTokens: budget,
  });
  const u = r.usage ?? {};
  console.log(`maxTokens=${budget}`);
  console.log(`  ok=${r.ok}  finish=${r.finishReason}`);
  console.log(`  prompt=${u.prompt} hit=${u.cacheHit} miss=${u.cacheMiss} completion=${u.completion} reasoning=${u.reasoning}`);
  console.log(`  回复内容: ${JSON.stringify(r.text ?? '')}`);
  console.log('');
}

log.closeLogs();
