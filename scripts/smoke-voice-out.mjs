// 冒烟测试：语音输出的四档策略（纯函数 + 配额；不真的合成）
import * as vo from '../src/modules/voice-out.js';
import * as rate from '../src/modules/rateLimit.js';
import * as log from '../src/logger.js';

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', label, extra ?? ''); }
};

console.log('--- cfg（设置是人工填的，坏值要夹住）---');
const d = vo.cfg({});
check('默认是文字档', d.mode === 'text' && d.quality === 'normal', JSON.stringify(d));
check('默认护栏值', d.maxChars === 26 && d.maxMessages === 2 && d.perHour === 20, JSON.stringify(d));
check('没有设置也不炸', vo.cfg(null).mode === 'text' && vo.cfg(undefined).perHour === 20);
const bad = vo.cfg({ speak: { voice: { mode: 'sing', prob: 9, perHour: -5, maxChars: 1, maxMessages: 99, sid: 'x', quality: 'ultra' } } });
check('坏档位退回文字档', bad.mode === 'text', bad.mode);
check('概率夹到 0~1', bad.prob === 1, String(bad.prob));
check('每小时上限不为负', bad.perHour === 0, String(bad.perHour));
check('单条字数有下限', bad.maxChars === 4, String(bad.maxChars));
check('条数有上限', bad.maxMessages === 5, String(bad.maxMessages));
check('sid 坏值当 0', bad.sid === 0, String(bad.sid));
check('质量坏值退回默认', bad.quality === 'normal', bad.quality);
check('字符串数字也认', vo.cfg({ speak: { voice: { prob: '0.25', maxChars: '30' } } }).prob === 0.25);
check('停顿默认不补', d.pauseMs === 0);
check('停顿坏值夹到 0~1500', vo.cfg({ speak: { voice: { pauseMs: 99999 } } }).pauseMs === 1500 && vo.cfg({ speak: { voice: { pauseMs: -5 } } }).pauseMs === 0);
check('停顿读得出来', vo.cfg({ speak: { voice: { pauseMs: '300' } } }).pauseMs === 300);

console.log('--- stripMarker（记号出现在哪都剥掉）---');
const m1 = vo.stripMarker('[语音] 你好呀');
check('[语音] 被剥掉', m1.text === '你好呀' && m1.forced === true, JSON.stringify(m1));
check('全角【语音】也认', vo.stripMarker('【语音】你好').forced === true);
check('括号（语音）也认', vo.stripMarker('（语音）你好').text === '你好');
check('记号前有空格也行', vo.stripMarker('  [语音]  你好').text === '你好');
// 真实事故：模型把记号写在句子中间，只在开头匹配就会原样发到群里（2026-09-24 实测一次）
const m2 = vo.stripMarker('吉祥话我讲不好，就送大家一句：海浪会来。  [语音] 你那半份作业也继续一下。');
check('写在句子中间的也剥掉', !m2.text.includes('语音'), m2.text);
check('中间出现也算「模型要用语音」', m2.forced === true);
check('剥掉后不留多余空格', !/\s{2}/.test(m2.text) && !/\s[，。]/.test(m2.text), JSON.stringify(m2.text));
const m3 = vo.stripMarker('【语音】前面一个[语音]后面还有一个');
check('多个记号全剥掉', !m3.text.includes('语音'), m3.text);
// 真实事故 2：模型照抄提示词里 〔能力〕〔情形〕 那种写法，写了 〔语音〕 想用语音念诗，
// 结果记号没剥、整句当文字发进群（2026-09-24 晚，日志里 1 次）
const m4 = vo.stripMarker('〔语音〕君不见黄河之水天上来 奔流到海不复回');
check('六角括号 〔语音〕 也认', m4.forced === true && m4.text === '君不见黄河之水天上来 奔流到海不复回', JSON.stringify(m4));
check('半角括号 (语音) 也认', vo.stripMarker('(语音) 你好').forced === true);
// 「」是引号，中文正文里可能真的在引用「语音」这个词，所以故意不认它
check('书名号/引号里的不认（避免误伤正文）', vo.stripMarker('他说「语音」这两个字').text === '他说「语音」这两个字');
check('没有记号就原样返回', vo.stripMarker('随便一句话').forced === false);
check('空文本不炸', vo.stripMarker('').text === '' && vo.stripMarker(null).text === '');
check('连续调用结果一致（全局正则不能带状态）',
  vo.stripMarker('[语音] 甲').text === vo.stripMarker('[语音] 甲').text && vo.stripMarker('[语音] 甲').forced === true);

console.log('--- decide（这一条到底发不发语音）---');
const V = { ...vo.DEFAULTS };
check('文字档永远不发', vo.decide({ cfg: { ...V, mode: 'text' }, text: '你好' }).voice === false);
check('语音档就发', vo.decide({ cfg: { ...V, mode: 'voice' }, text: '你好' }).voice === true);
check('讲题时语音档也退回文字', vo.decide({ cfg: { ...V, mode: 'voice' }, text: '你好', detailed: true }).voice === false);
check('空话不发', vo.decide({ cfg: { ...V, mode: 'voice' }, text: '   ' }).voice === false);
const p = { ...V, mode: 'prob', prob: 0.3 };
check('概率命中就发', vo.decide({ cfg: p, text: '你好', random: () => 0.1 }).voice === true);
check('概率没命中就不发', vo.decide({ cfg: p, text: '你好', random: () => 0.9 }).voice === false);
const ai = { ...V, mode: 'ai' };
check('ai 档模型写了记号才发', vo.decide({ cfg: ai, text: '你好', forced: true }).voice === true);
check('ai 档没记号就不发', vo.decide({ cfg: ai, text: '你好' }).voice === false);
check('理由写进 why（排查用）', vo.decide({ cfg: ai, text: '你好' }).why.includes('模型'), vo.decide({ cfg: ai, text: '你好' }).why);

console.log('--- qualityFor（高质量慢 3 倍，只给讲题）---');
check('默认档就是默认档', vo.qualityFor({ quality: 'normal' }, { detailed: true }) === 'normal');
check('指定高质量就一直高质量', vo.qualityFor({ quality: 'high' }, {}) === 'high');
check('auto：讲题用高质量', vo.qualityFor({ quality: 'auto' }, { detailed: true }) === 'high');
check('auto：闲聊用默认档', vo.qualityFor({ quality: 'auto' }, { detailed: false }) === 'normal');

console.log('--- plan（按语音条长度切，太长就不发语音）---');
const cfg26 = { ...V, maxChars: 26, maxMessages: 2 };
check('短句一条', vo.plan('你好呀', cfg26).parts.length === 1);
check('两句短的也能塞进一条', vo.plan('你好呀。今天天气不错。', cfg26).parts.length === 1);
const many = '第一句大概有这么长的一串字符在这里。第二句大概也有这么长的一串字符。第三句又是一串字符在这里呢。第四句还是这么长的一串字符。第五句依旧这么长的一串字符。';
const pl = vo.plan(many, cfg26);
check('超长直接放弃语音', pl.ok === false && pl.why.includes('太长'), JSON.stringify(pl));
check('放宽条数就能发', vo.plan(many, { ...cfg26, maxMessages: 6 }).ok === true, JSON.stringify(vo.plan(many, { ...cfg26, maxMessages: 6 })));
// 模型自己点名要用语音（写了 [语音]）时多给额度：群里让人「朗读」一段诗是明确要求
check('模型点名时额度更宽', vo.plan(many, { ...cfg26, maxMessages: 2, maxMessagesForced: 6 }, { forced: true }).ok === true);
check('没点名就按普通额度', vo.plan(many, { ...cfg26, maxMessages: 2, maxMessagesForced: 6 }).ok === false);
check('点名的理由写进 why（排查用）', vo.plan('一二三。四五六。', cfg26, { forced: true }).why.includes('点名'), vo.plan('一二三。四五六。', cfg26, { forced: true }).why);
check('点名也有上限（不能无限条）', vo.plan(many, { ...cfg26, maxMessagesForced: 2 }, { forced: true }).ok === false);
check('空文本不给发', vo.plan('  ', cfg26).ok === false);

console.log('--- fileUrl（NapCat 只认 file:/// 加正斜杠）---');
const u = vo.fileUrl('C:\\Users\\a b\\x.wav');
check('Windows 路径转成 file:///', u === 'file:///C:/Users/a b/x.wav', u);
check('不含反斜杠', !u.includes('\\'));
const rel = vo.fileUrl('data/tmp/x.wav');
check('相对路径会补成绝对', rel.startsWith('file:///') && rel.endsWith('/data/tmp/x.wav'), rel);
// path.resolve 在 Windows 上会把 /tmp/t.wav 落到当前盘，Linux 上原样保留 —— 按各平台真实行为断言
if (process.platform === 'win32') {
  const drive = process.cwd().slice(0, 2);
  check('Windows 上 posix 风格绝对路径落到当前盘', vo.fileUrl('/tmp/t.wav') === `file:///${drive}/tmp/t.wav`, vo.fileUrl('/tmp/t.wav'));
} else {
  check('Linux 上原样保留', vo.fileUrl('/tmp/t.wav') === 'file:///tmp/t.wav', vo.fileUrl('/tmp/t.wav'));
}

console.log('--- 配额（每小时语音条数上限）---');
rate.reset();
const BOT = 999777;
const c2 = { ...V, perHour: 2 };
check('第一次能占', vo.take(BOT, c2).ok === true);
check('第二次能占', vo.take(BOT, c2).ok === true);
const third = vo.take(BOT, c2);
check('第三次被挡', third.ok === false && third.reason.includes('上限'), JSON.stringify(third));
check('peek 看到已用 2 条', vo.peek(BOT, c2).used === 2 && vo.peek(BOT, c2).remaining === 0, JSON.stringify(vo.peek(BOT, c2)));
check('上限 0 = 关着', vo.take(BOT, { ...c2, perHour: 0 }).ok === false);
rate.reset();
check('重置后又能占', vo.take(BOT, c2).ok === true && vo.peek(BOT, c2).used === 1);

console.log('--- canAfford（发之前先看够不够，够才发语音）---');
rate.reset();
check('一条回复要 2 条、配额够', vo.canAfford(BOT, { ...c2, perHour: 5 }, 2).ok === true);
check('剩 1 条却要发 2 条：不给发', vo.canAfford(BOT, { ...c2, perHour: 1 }, 2).ok === false, JSON.stringify(vo.canAfford(BOT, { ...c2, perHour: 1 }, 2)));
check('预检不消费配额', rate.peek(`voice:${BOT}:h`, 3600_000) === 0);
vo.take(BOT, { ...c2, perHour: 2 });
check('用掉 1 条后剩 1 条只能发 1 条', vo.canAfford(BOT, c2, 1).ok === true && vo.canAfford(BOT, c2, 2).ok === false);
check('上限 0 时永远不够', vo.canAfford(BOT, { ...c2, perHour: 0 }, 1).ok === false);
rate.reset();

console.log('--- speak（合成封装；这两条都不该走到真合成）---');
check('空文本直接拒', (await vo.speak('  ', { cfg: c2, botId: BOT })).stage === 'text');
const noQuota = await vo.speak('你好', { cfg: { ...c2, perHour: 0 }, botId: BOT });
check('没配额时在合成前就退', noQuota.ok === false && noQuota.stage === 'quota', JSON.stringify(noQuota));

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
log.closeLogs();
