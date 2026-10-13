// 冒烟测试：/命令的格式规范（src/cmdline.js）
//
// 这个模块是全项目唯一规定「一条 /命令 长什么样」的地方，
// 所以边界要测全：@ 指名、别人的 @ 不算、前缀、参数切分、误判防护。
import { parseCommandLine } from '../src/cmdline.js';

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', label, extra ? '→ ' + extra : ''); }
};

// 测试用的「我们自己的机器人」
const BOTS = new Set(['10001', '20002']);
const isBot = (qq) => BOTS.has(String(qq));
const at = (qq, name) => ({ type: 'at', data: name ? { qq, name } : { qq } });
const txt = (text) => ({ type: 'text', data: { text } });
const parse = (segs) => parseCommandLine(segs, { isBot });

console.log('--- 基本形状 ---');
let c = parse([txt('/help')]);
check('光一个命令', c?.name === 'help', JSON.stringify(c));
check('没有指名时 responder 为空', c?.responder === null, JSON.stringify(c?.responder));
check('没有参数时 args 为空', Array.isArray(c?.args) && c.args.length === 0);

check('全角斜杠也认', parse([txt('／help')])?.name === 'help');
check('命令前的空白不影响', parse([txt('   /help')])?.name === 'help');
check('单独一个斜杠不算命令', parse([txt('/')]) === null);
check('只有空白不算命令', parse([txt('   ')]) === null);
check('空数组不算命令', parse([]) === null);
check('null 不炸', parse(null) === null);
check('普通文字不算命令', parse([txt('你好')]) === null);

console.log('--- @ 指名 ---');
c = parse([at('10001'), txt(' /help')]);
check('@机器人 + 命令：解析出来', c?.name === 'help', JSON.stringify(c));
check('@机器人 被记为指名', c?.targets?.[0] === '10001', JSON.stringify(c?.targets));
check('第一个指名就是执行者', c?.responder === '10001');

c = parse([at('10001'), at('20002'), txt('/spendtrend')]);
check('多个 @ 都记下来', c?.targets?.length === 2, JSON.stringify(c?.targets));
check('执行者是第一个', c?.responder === '10001');
check('@ 紧贴斜杠没空格也能认', parse([at('10001'), txt('/undo')])?.name === 'undo');
check('@ 与命令之间多空格也行', parse([at('10001'), txt('    /undo')])?.name === 'undo');

// 关键：@ 真人不是指名
c = parse([at('999999'), txt(' /help')]);
check('@ 真人：不算指名', c?.targets?.length === 0, JSON.stringify(c?.targets));
check('@ 真人：命令照样识别', c?.name === 'help');
check('@ 真人：responder 为空（不限定执行者）', c?.responder === null);

c = parse([at('999999'), at('10001'), txt(' /help')]);
check('@真人 + @机器人：只认机器人', c?.targets?.length === 1 && c.targets[0] === '10001',
  JSON.stringify(c?.targets));

check('@所有人 不算指名', parse([at('all'), txt(' /help')])?.targets.length === 0);

console.log('--- 命令之后的 @ 是参数 ---');
c = parse([txt('/spendtrend '), at('10001'), at('20002')]);
check('命令后的 @ 不进指名', c?.targets?.length === 0, JSON.stringify(c?.targets));
check('命令后的 @ 进参数', c?.args?.length === 2, JSON.stringify(c?.args));
check('参数里带 @ 名字（没有名字就用 QQ）',
  c?.args?.[0] === '@10001', JSON.stringify(c?.args));

c = parse([at('10001'), txt(' /spendtrend '), at('20002', '猪咪群友')]);
check('指名与参数同时存在：指名只算前面那个',
  c?.targets?.length === 1 && c.targets[0] === '10001', JSON.stringify(c?.targets));
check('指名与参数同时存在：参数只用后面的',
  c?.args?.length === 1 && c.args[0] === '@猪咪群友', JSON.stringify(c?.args));

console.log('--- 参数切分 ---');
c = parse([txt('/learn goodex')]);
check('子命令与参数分开', c?.name === 'learn' && c.args[0] === 'goodex', JSON.stringify(c));
c = parse([txt('/api  on  extra   words ')]);
check('多余空格不产生空参数', c?.args?.length === 3, JSON.stringify(c?.args));
check('argText 拼回一行', c?.argText === 'on extra words', JSON.stringify(c?.argText));
c = parse([txt('/learn  '), txt(' goodex ')]);
check('命令被拆成多个文本段也能拼起来', c?.name === 'learn' && c.args[0] === 'goodex', JSON.stringify(c));
check('raw 是命令原文', c?.raw === '/learn   goodex', JSON.stringify(c?.raw));

console.log('--- 不该被当成命令的情况 ---');
check('命令前有正文：不算命令', parse([txt('那个 /help 我看过了')]) === null);
check('命令前有正文（@ 之后再说话）：不算命令', parse([at('10001'), txt(' 你好')]) === null);
check('反斜杠不是命令', parse([txt('\\help')]) === null);
check('@ 之后的正文里带斜杠也不算', parse([at('10001'), txt(' 你看看 /help 那个')]) === null);

// 图片等在命令前出现不该影响判定（「先发张图再 @机器人 /help」）
check('命令前的图片不影响判定',
  parse([{ type: 'image', data: { url: 'x' } }, at('10001'), txt(' /help')])?.name === 'help');
check('命令前的语音不影响判定',
  parse([{ type: 'record', data: {} }, txt('/help')])?.name === 'help');
// 空文本段（NapCat 偶尔发）不该打断
check('空文本段被跳过',
  parse([txt(''), at('10001'), txt(' /help')])?.name === 'help');

console.log('--- 不传 isBot 时 ---');
const noBot = parseCommandLine([at('10001'), txt(' /help')]);
check('不传 isBot：没人被指名', noBot?.targets.length === 0, JSON.stringify(noBot?.targets));
check('不传 isBot：命令仍能识别（兼容旧行为）', noBot?.name === 'help');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
