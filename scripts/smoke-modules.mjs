// 冒烟测试：功能模块（时段 / 文本判定 / 名单 / 频控 / 默认回复 / 复读）
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, DATA_DIR } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as db from '../src/db.js';
import * as sch from '../src/modules/schedule.js';
import * as tm from '../src/textmatch.js';
import * as lists from '../src/modules/lists.js';
import * as rate from '../src/modules/rateLimit.js';
import * as fb from '../src/modules/fallback.js';
import * as echo from '../src/modules/repeatEcho.js';
import * as speaking from '../src/modules/speaking.js';
import * as forward from '../src/modules/forward.js';
import * as talk from '../src/modules/talk.js';
import * as jokes from '../src/modules/jokes.js';
import { defaultBotSettings } from '../src/config.js';

ensureDirs();
const TEST_DB = path.join(DATA_DIR, 'test.sqlite');
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.unlinkSync(f); } catch { /* 忽略 */ }
}
db.openDb(TEST_DB);

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', label, extra ? '→ ' + extra : ''); }
};

const botId = db.createBot('测试机', '10001');
const S = defaultBotSettings();

// ============ 时段 ============
console.log('--- 时段解析 ---');
check('parseHm 23:30', sch.parseHm('23:30') === 1410);
check('parseHm 00:00', sch.parseHm('00:00') === 0);
check('parseHm 24:00', sch.parseHm('24:00') === 1440);
check('parseHm 9:05', sch.parseHm('9:05') === 545);
check('parseHm 非法 25:00', sch.parseHm('25:00') === null);
check('parseHm 非法 12:60', sch.parseHm('12:60') === null);
check('parseHm 非法 abc', sch.parseHm('abc') === null);

check('parseRange 23:30-24:00', JSON.stringify(sch.parseRange('23:30-24:00')) === '{"start":1410,"end":1440}');
check('parseRange 跨零点', JSON.stringify(sch.parseRange('23:30-03:10')) === '{"start":1410,"end":190}');

console.log('--- 区间判定 ---');
const night = sch.parseRange('23:30-03:10');
check('23:45 在跨零点区间内', sch.isInRange(night, 23 * 60 + 45));
check('01:00 在跨零点区间内', sch.isInRange(night, 60));
check('03:05 在跨零点区间内', sch.isInRange(night, 185));
check('03:10 恰好在结束点外', !sch.isInRange(night, 190));
check('12:00 不在区间内', !sch.isInRange(night, 720));
check('22:00 不在区间内', !sch.isInRange(night, 1320));
const noon = sch.parseRange('12:00-14:00');
check('13:00 在普通区间内', sch.isInRange(noon, 780));
check('12:00 包含起点', sch.isInRange(noon, 720));
check('14:00 不含终点', !sch.isInRange(noon, 840));

console.log('--- API 三态 ---');
check('force_on 直接开', sch.isApiActive(botId, { api: { mode: 'force_on' } }).active);
check('force_off 直接关', !sch.isApiActive(botId, { api: { mode: 'force_off' } }).active);
sch.ensureSlots(botId, 3);
db.run('update schedules set ranges = ? where bot_id = ? and slot_no = 1',
  JSON.stringify(['00:00-24:00']), botId);
check('auto + 全天时段 = 开', sch.isApiActive(botId, { api: { mode: 'auto' }, schedule: { activeSlot: 1 } }).active);
db.run('update schedules set ranges = ? where bot_id = ? and slot_no = 2', JSON.stringify([]), botId);
db.run('update schedules set ranges = ? where bot_id = ? and slot_no = 3',
  JSON.stringify(['03:00-04:00']), botId);
check('auto + 空时段 = 关', !sch.isApiActive(botId, { api: { mode: 'auto' }, schedule: { activeSlot: 2 } }).active);
const at10 = new Date(2026, 0, 1, 10, 0);
check('auto + 未覆盖当前时刻 = 关',
  !sch.isApiActive(botId, { api: { mode: 'auto' }, schedule: { activeSlot: 3 } }, at10).active);

// ============ 文本判定 ============
console.log('--- 相同判定三档 ---');
check('strict 完全相同', tm.sameText('你好', '你好', 'strict'));
check('strict 尾随空格不算同', !tm.sameText('你好', '你好 ', 'strict'));
check('loose 尾随空格算同', tm.sameText('你好', '你好 ', 'loose'));
check('loose 大小写无关', tm.sameText('Hello', 'hello', 'loose'));
check('loose 全角半角归一', tm.sameText('ＡＢＣ', 'ABC', 'loose'));
check('loose 不可见字符忽略', tm.sameText('你\u200B好', '你好', 'loose'));
check('loose 标点仍算不同', !tm.sameText('真的吗', '真的吗！', 'loose'));
check('loosest 标点忽略', tm.sameText('真的吗', '真的吗！！！', 'loosest'));
check('loosest 空格忽略', tm.sameText('这 也 太', '这也太', 'loosest'));
check('loosest 不同内容仍不同', !tm.sameText('这也太真实了', '这太假了', 'loosest'));

// ============ 名单 ============
console.log('--- 名单 ---');
check('默认白名单', lists.getMode(botId, 'user', 'accept') === 'whitelist');
check('空白名单 => 不响应', !lists.canInteract(botId, { kind: 'private', senderQq: '20001' }).accept);
lists.addTarget(botId, 'user', 'accept', '20001');
check('加入白名单后放行', lists.canInteract(botId, { kind: 'private', senderQq: '20001' }).accept);
check('其他人仍被拒', !lists.canInteract(botId, { kind: 'private', senderQq: '20002' }).accept);

// 群维度
lists.addTarget(botId, 'user', 'accept', '20003');
check('群未加名单 => 拒', !lists.canInteract(botId, { kind: 'group', senderQq: '20003', groupId: '555001' }).accept);
lists.addTarget(botId, 'group', 'accept', '555001');
check('群加名单后放行', lists.canInteract(botId, { kind: 'group', senderQq: '20003', groupId: '555001' }).accept);

// 黑名单模式
lists.setMode(botId, 'user', 'reply', 'blacklist');
check('回复维度切黑名单', lists.getMode(botId, 'user', 'reply') === 'blacklist');
check('黑名单空 => 放行', lists.canInteract(botId, { kind: 'private', senderQq: '20001' }).reply);
lists.addTarget(botId, 'user', 'reply', '20001');
const r = lists.canInteract(botId, { kind: 'private', senderQq: '20001' });
check('黑名单命中 => 接受但回复被拒', r.accept === true && r.reply === false, JSON.stringify(r));

// ============ 频控 ============
console.log('--- 频控 ---');
rate.reset();
const RS = defaultBotSettings();
RS.rate = { repeat: { windowSec: 60, max: 1 }, unique: { windowSec: 3600, max: 3 }, global: { perMinute: 5, perHour: 100 } };
check('第一条允许', rate.allow(botId, RS, { personId: 1, text: '回复A' }).ok);
rate.rememberReply(botId, 1, '回复A');
check('重复内容第一次放行', rate.allow(botId, RS, { personId: 1, text: '回复A' }).ok);
const rep = rate.allow(botId, RS, { personId: 1, text: '回复A' });
check('同一窗口内重复内容第二次被挡', !rep.ok && rep.tier === 'repeat', JSON.stringify(rep));
check('换一句不重复的允许', rate.allow(botId, RS, { personId: 1, text: '回复B' }).ok);
check('另一人独立计数', rate.allow(botId, RS, { personId: 2, text: '回复C' }).ok);

rate.reset();
const RG = defaultBotSettings();
RG.rate = { repeat: { windowSec: 60, max: 99 }, unique: { windowSec: 3600, max: 99 }, global: { perMinute: 2, perHour: 100 } };
check('全局第1条', rate.allow(botId, RG, { personId: 10, text: 'a' }).ok);
check('全局第2条', rate.allow(botId, RG, { personId: 11, text: 'b' }).ok);
const g3 = rate.allow(botId, RG, { personId: 12, text: 'c' });
check('全局第3条被挡', !g3.ok && g3.tier === 'global', JSON.stringify(g3));

check('prune 不炸', typeof rate.prune() === 'number');

// ============ 默认回复 ============
console.log('--- 默认回复 ---');
const seeded = fb.seedDefaults(botId);
check('铺了默认条目', seeded > 0, String(seeded));
check('重复调用不重复铺', fb.seedDefaults(botId) === 0);
check('能取到 api_off 回复', typeof fb.pickReply(botId, 'api_off') === 'string');
const list0 = fb.listFor(botId, 'video');
const fixedId = list0[0].id;
fb.updateReply(fixedId, { isFixed: true });
check('固定条目优先', fb.pickReply(botId, 'video') === list0[0].text);
fb.updateReply(fixedId, { enabled: false });
const others = fb.listFor(botId, 'video').filter((x) => Number(x.enabled) === 1);
check('禁用后不再选它', !others.some((x) => x.id === fixedId));
for (const x of fb.listFor(botId, 'video')) fb.updateReply(x.id, { enabled: false });
check('全部禁用 => 完全静默(null)', fb.pickReply(botId, 'video') === null);
check('冷却首次允许', fb.allowCooldown(botId, 1, S).ok);
check('冷却期内再问被挡', !fb.allowCooldown(botId, 1, S).ok);
check('换个人不受影响', fb.allowCooldown(botId, 2, S).ok);

// ============ 复读 ============
console.log('--- 复读 ---');
echo.reset();
// 不覆盖 matchMode，使用配置里的真实默认值
const E = defaultBotSettings();
E.repeatEcho = { ...E.repeatEcho, enabled: true, minPeople: 2, maxGapMessages: 3, windowMessages: 15, minLength: 2 };
check('默认档位是最宽松', E.repeatEcho.matchMode === 'loosest', E.repeatEcho.matchMode);

echo.noteMessage(botId, 'g1', { senderQq: 'A', text: '这也太真实了', isBot: false });
check('只有一个人说过 => 不触发', echo.detect(botId, 'g1', E) === null);
echo.noteMessage(botId, 'g1', { senderQq: 'B', text: '这也太真实了！', isBot: false });
const hit = echo.detect(botId, 'g1', E);
check('第二个人说相同内容（标点不同）=> 触发', hit !== null && hit.hit === true, JSON.stringify(hit));
check('只跟一次（再检测不触发）', echo.detect(botId, 'g1', E) === null);

// 档位对复读的影响：宽松档不忽略标点，真实场景会漏
echo.reset();
const EStrict = { ...E, repeatEcho: { ...E.repeatEcho, matchMode: 'loose' } };
echo.noteMessage(botId, 'g1s', { senderQq: 'A', text: '真实场景测试', isBot: false });
echo.noteMessage(botId, 'g1s', { senderQq: 'B', text: '真实场景测试！', isBot: false });
check('宽松档下标点不同 => 漏检（说明为何默认改最宽松）', echo.detect(botId, 'g1s', EStrict) === null);
echo.reset();
echo.noteMessage(botId, 'g1t', { senderQq: 'A', text: '真实场景测试', isBot: false });
echo.noteMessage(botId, 'g1t', { senderQq: 'B', text: '真实场景测试！', isBot: false });
check('最宽松档下同样输入 => 命中', echo.detect(botId, 'g1t', E)?.hit === true);

echo.reset();
echo.noteMessage(botId, 'g2', { senderQq: 'A', text: '好', isBot: false });
echo.noteMessage(botId, 'g2', { senderQq: 'B', text: '好', isBot: false });
check('太短不触发', echo.detect(botId, 'g2', E) === null);

echo.reset();
echo.noteMessage(botId, 'g2b', { senderQq: 'A', text: '😀😀😀', isBot: false });
echo.noteMessage(botId, 'g2b', { senderQq: 'B', text: '😀😀😀', isBot: false });
check('纯表情不触发', echo.detect(botId, 'g2b', E) === null);

echo.reset();
echo.noteMessage(botId, 'g3', { senderQq: 'A', text: '这个很有意思', isBot: false });
echo.noteMessage(botId, 'g3', { senderQq: 'A', text: '这个很有意思', isBot: false });
check('同一个人说两次不触发', echo.detect(botId, 'g3', E) === null);

echo.reset();
echo.noteMessage(botId, 'g4', { senderQq: '10001', text: '我自己的话', isBot: true });
echo.noteMessage(botId, 'g4', { senderQq: 'B', text: '我自己的话', isBot: false });
check('机器人自己的发言不参与', echo.detect(botId, 'g4', E) === null);

echo.reset();
echo.noteMessage(botId, 'g5', { senderQq: 'A', text: '间距测试', isBot: false });
for (const t of ['x1', 'x2', 'x3', 'x4', 'x5']) {
  echo.noteMessage(botId, 'g5', { senderQq: 'C', text: t, isBot: false });
}
echo.noteMessage(botId, 'g5', { senderQq: 'B', text: '间距测试', isBot: false });
check('隔太远不触发', echo.detect(botId, 'g5', E) === null);

echo.reset();
const E3 = { ...E, repeatEcho: { ...E.repeatEcho, minPeople: 3 } };
echo.noteMessage(botId, 'g6', { senderQq: 'A', text: '三点触发', isBot: false });
echo.noteMessage(botId, 'g6', { senderQq: 'B', text: '三点触发', isBot: false });
check('要求3人时2人不够', echo.detect(botId, 'g6', E3) === null);
echo.noteMessage(botId, 'g6', { senderQq: 'C', text: '三点触发', isBot: false });
check('第3人出现后触发', echo.detect(botId, 'g6', E3)?.hit === true);

echo.reset();
const EC = { ...E, repeatEcho: { ...E.repeatEcho, perGroup: { g7: { minPeople: 3 } } } };
echo.noteMessage(botId, 'g7', { senderQq: 'A', text: '群覆盖测试', isBot: false });
echo.noteMessage(botId, 'g7', { senderQq: 'B', text: '群覆盖测试', isBot: false });
check('按群覆盖生效（该群要求3人）', echo.detect(botId, 'g7', EC) === null);
check('另一群仍用全局（2人）', (() => {
  echo.noteMessage(botId, 'g8', { senderQq: 'A', text: '群覆盖测试', isBot: false });
  echo.noteMessage(botId, 'g8', { senderQq: 'B', text: '群覆盖测试', isBot: false });
  return echo.detect(botId, 'g8', EC)?.hit === true;
})());

// ============ 回复切分与篇幅 ============
console.log('--- 回复切分（按句子）---');
const sp = speaking.splitReply;

check('空字符串返回空数组', sp('').length === 0);
check('单句原样返回', JSON.stringify(sp('你好啊')) === JSON.stringify(['你好啊']));
check('两句默认拆成两条', sp('第一句。第二句。').length === 2, JSON.stringify(sp('第一句。第二句。')));
check('三句默认拆成三条', sp('甲。乙。丙。').length === 3);
check('拆完不丢内容', sp('甲。乙。丙。').join('') === '甲。乙。丙。');

check('放宽到 3 句/条 就不拆', sp('甲。乙。丙。', { maxSentences: 3 }).length === 1);
check('放宽到 2 句/条 拆两条', sp('甲。乙。丙。', { maxSentences: 2 }).length === 2);
check('2 句/条 时每条约两句', sp('甲。乙。丙。丁。', { maxSentences: 2, maxMessages: 5 }).every((x) => speaking.splitSentences(x).length <= 2));

check('条数上限会拦下来', sp('一。二。三。四。五。六。', { maxSentences: 1, maxMessages: 2 }).length === 2);
check('被压缩后内容仍不丢', sp('一。二。三。四。五。六。', { maxSentences: 1, maxMessages: 2 }).join('') === '一。二。三。四。五。六。');

check('感叹号也断句', sp('太好了！真的很棒！').length === 2);
check('问号也断句', sp('这是什么呢？我也不知道。').length === 2);
check('分号也断句', sp('甲；乙。').length === 2);
check('无标点的长句算一句', sp('一'.repeat(200)).length === 1);
check('切句结果没有空白项', speaking.splitSentences('甲。  乙。').length === 2);

// 用户要的那种：模型返回一长串句子，本地拆成多条，每条装「几句话」
const seven = '一。二。三。四。五。六。七。';
const grouped = sp(seven, { maxSentences: 3, maxMessages: 5 });
check('7 句、每条 3 句 → 拆成 3 条', grouped.length === 3, JSON.stringify(grouped));
check('每组不超过 3 句', grouped.every((x) => speaking.splitSentences(x).length <= 3), JSON.stringify(grouped));
check('分出来的条数正好按 ceil(7/3)', grouped.length === Math.ceil(7 / 3), String(grouped.length));
check('每条装几句也是 3 句', sp(seven, { maxSentences: 3, maxMessages: 5 })[0] === '一。二。三。');
check('按 2 句一组就拆 4 条', sp(seven, { maxSentences: 2, maxMessages: 5 }).length === 4,
  JSON.stringify(sp(seven, { maxSentences: 2, maxMessages: 5 })));
check('一条一句就拆 7 条', sp(seven, { maxSentences: 1, maxMessages: 99 }).length === 7);
check('分组后总内容不丢', grouped.join('') === seven, grouped.join(''));

// 不带句号、一行一句的写法不能被黏成一行。
// 切句时标点和换行都被吃掉了，早先直接 join('') 会得到「笑死我了这也太抽象了」。
const lines = '笑死我了\n这也太抽象了吧\n你从哪找的\n绷不住了\n行了别发了';
const glued = sp(lines, { maxSentences: 3, maxMessages: 5 });
check('缺标点的多行：按 3 句拆 2 条', glued.length === 2, JSON.stringify(glued));
check('缺标点的多行：组内没被黏成一行', glued[0].includes('\n'), JSON.stringify(glued[0]));
check('缺标点的多行：3 句各占一行',
  glued[0] === '笑死我了\n这也太抽象了吧\n你从哪找的', JSON.stringify(glued[0]));
check('缺标点的多行：内容不丢', glued.join('').replace(/\n/g, '') === lines.replace(/\n/g, ''),
  JSON.stringify(glued));
// 有标点的照旧（不该凭空多出换行）
check('带句号的不补换行', sp('甲。乙。丙。', { maxSentences: 3, maxMessages: 5 })[0] === '甲。乙。丙。');
check('带句号的多条也不补换行',
  sp('甲。乙。丙。丁。', { maxSentences: 3, maxMessages: 5 })[0] === '甲。乙。丙。');

console.log('--- 两档句子上限 ---');
const SLIM = { speak: { maxSentences: 1, maxSentencesDetailed: 3 } };
check('日常闲聊：一条 1 句', speaking.pickSentenceLimit('在吗', SLIM).maxSentences === 1);
check('日常闲聊不判为详细', speaking.pickSentenceLimit('在吗', SLIM).detailed === false);
check('讲解类放宽到 3 句', speaking.pickSentenceLimit('什么是矩阵', SLIM).maxSentences === 3);
check('命中词被记录', speaking.pickSentenceLimit('什么是矩阵', SLIM).matched === '矩阵');
check('「证明」算详细', speaking.pickSentenceLimit('帮我证明一下', SLIM).detailed === true);
check('自定义关键词生效',
  speaking.pickSentenceLimit('讲讲这个', { speak: { detailedKeywords: ['讲讲'], maxSentencesDetailed: 5 } }).maxSentences === 5);
check('关键词为空时用内置清单',
  speaking.pickSentenceLimit('什么是行列式', { speak: { detailedKeywords: [] } }).detailed === true);

console.log('--- 篇幅设置 ---');
const shape = speaking.replyShape({
  speak: {
    replyMaxChars: 30, splitLongReplies: false, maxMessages: 9, segmentDelayMs: 100,
    maxSentences: 2, maxSentencesDetailed: 4,
  },
});
check('读取自定义字数上限', shape.maxChars === 30);
check('读取切分开关', shape.split === false);
check('条数被夹到上限 8', shape.maxMessages === 8, String(shape.maxMessages));
check('日常句数', shape.maxSentences === 2);
check('讲解句数', shape.maxSentencesDetailed === 4);
const d = speaking.replyShape({});
check('默认：日常 1 句', d.maxSentences === 1);
check('默认：讲解 3 句', d.maxSentencesDetailed === 3);
check('默认：最多 3 条', d.maxMessages === 3);
check('默认字数上限 45', d.maxChars === 45);

// 分条间隔：早先写成 `Number(x) ?? 350`，而 Number(undefined) 是 NaN、NaN 判假，
// 于是「默认 350 毫秒」从来没生效过——几条消息一直是零间隔连发。
check('默认分条间隔 350 毫秒', d.segmentDelayMs === 350, String(d.segmentDelayMs));
check('没设这个字段时也是 350', speaking.replyShape({ speak: {} }).segmentDelayMs === 350,
  String(speaking.replyShape({ speak: {} }).segmentDelayMs));
check('垃圾值回落到 350', speaking.replyShape({ speak: { segmentDelayMs: 'abc' } }).segmentDelayMs === 350,
  String(speaking.replyShape({ speak: { segmentDelayMs: 'abc' } }).segmentDelayMs));
check('显式设了就听设置', shape.segmentDelayMs === 100, String(shape.segmentDelayMs));
check('设 0 就是真的不等', speaking.replyShape({ speak: { segmentDelayMs: 0 } }).segmentDelayMs === 0);
check('负数夹到 0', speaking.replyShape({ speak: { segmentDelayMs: -5 } }).segmentDelayMs === 0);
check('超过 3000 被夹住', speaking.replyShape({ speak: { segmentDelayMs: 9999 } }).segmentDelayMs === 3000);

// ---------- 主动模式粗筛 ----------
//
// 图片和合并转发没有文字，但它们是内容。早先的长度判断只看文字，
// 于是主动模式下发一张图永远过不了粗筛——机器人一声不吭，看起来像坏了。
console.log('--- 主动模式粗筛 ---');
const PF = defaultBotSettings();
PF.speak.defaultGroupMode = 'active';
PF.speak.active = { perGroupPerHour: 300, minGapSec: 1, minMessageLength: 2, randomRate: 0.8 };
const allow = (msg, opts) => speaking.prefilter(msg, PF, { random: () => 0, ...opts });
const deny = (msg, opts) => speaking.prefilter(msg, PF, { random: () => 0.99, ...opts });

check('纯图片：放行（这就是那个 bug）',
  allow({ textClean: '', images: [{ url: 'x' }] }).pass === true,
  JSON.stringify(allow({ textClean: '', images: [{ url: 'x' }] })));
check('纯图片：带 [图片] 标记也放行', allow({ textClean: '[图片]', images: [{ url: 'x' }] }).pass === true);
check('图片 + 文字：放行', allow({ textClean: '这啥', images: [{ url: 'x' }] }).pass === true);
check('纯合并转发：放行',
  allow({ textClean: '', forwardIds: ['f1'] }).pass === true,
  JSON.stringify(allow({ textClean: '', forwardIds: ['f1'] })));
check('真·空消息：仍拦下', deny({ textClean: '', images: [] }).reason === '空消息');
check('空消息无图无转发：拦下', deny({}).reason === '空消息');
// 文字类判断照旧
check('文字太短：拦下', deny({ textClean: '嗯', images: [] }).reason.startsWith('太短'));
check('纯标点：拦下', deny({ textClean: '？？？', images: [] }).reason === '纯标点或表情');
check('命令：拦下', deny({ textClean: '/help' }).pass === false);
check('正常文字：放行', allow({ textClean: '这期神了', images: [] }).pass === true);
// minMessageLength 仍然管文字
const PF2 = { speak: { active: { minMessageLength: 5, randomRate: 1 } } };
check('minMessageLength 对文字生效',
  speaking.prefilter({ textClean: '三个字', images: [] }, PF2, { random: () => 0 }).pass === false);
check('minMessageLength 不拦图片',
  speaking.prefilter({ textClean: '', images: [{ url: 'x' }] }, PF2, { random: () => 0 }).pass === true);
// 图/转发不走随机闸门：进来就是有事要问，再赌一次随机的表现就是「发图它不理」
// （2026-09-24 实测：群里四条图全停在「粗筛:随机未命中」，用户报的就是这个）
check('有图时不走随机闸门',
  speaking.prefilter({ textClean: '', images: [{ url: 'x' }] }, PF, { random: () => 0.99 }).pass === true);
check('转发同理',
  speaking.prefilter({ textClean: '', forwardIds: ['f1'] }, PF, { random: () => 0.99 }).pass === true);
check('纯文字仍然受随机闸门管',
  speaking.prefilter({ textClean: '今天天气不错', images: [] }, PF, { random: () => 0.99 }).pass === false);

// ---------- 合并转发里的图片 ----------
//
// 转发的文本里只写「[图片]」，图里有什么模型一概不知。
// 这里管的是「把哪些图送去识别」：条数封顶、总数如实报、地址取不到就不假装有。
console.log('--- 合并转发：收集图片 ---');
const node = (segs) => ({ sender: { nickname: '张三' }, message: segs });
const imgSeg = (url) => ({ type: 'image', data: url ? { url } : {} });

const nodes5 = [node([{ type: 'text', data: { text: '看这个' } }]), ...[1, 2, 3, 4, 5].map((n) => node([imgSeg(`http://x/${n}.jpg`)]))];

let c = forward.collectForwardImages(nodes5, 3);
check('按上限截断', c.list.length === 3, String(c.list.length));
check('总数是实际张数', c.total === 5, String(c.total));
check('按出现顺序取', c.list[0] === 'http://x/1.jpg' && c.list[2] === 'http://x/3.jpg', JSON.stringify(c.list));

c = forward.collectForwardImages(nodes5, 8);
check('不足上限就全读', c.list.length === 5, String(c.list.length));
check('全读时总数不变', c.total === 5, String(c.total));

// 0 = 一张都不读（设置里就是这么写的），不是「不限量」
c = forward.collectForwardImages(nodes5, 0);
check('上限 0 表示一张都不读', c.list.length === 0, String(c.list.length));
check('上限 0 时总数照报', c.total === 5, String(c.total));

// 没有地址的图：总数要算，列表里不能有（不然会拿个空串去下载）
c = forward.collectForwardImages([node([imgSeg(null), imgSeg('http://x/a.jpg')])], 8);
check('没地址的图计入总数', c.total === 2, String(c.total));
check('没地址的图不进待读列表', c.list.length === 1 && c.list[0] === 'http://x/a.jpg', JSON.stringify(c.list));

// 本机路径（NapCat 有时给这种）也算可用地址
c = forward.collectForwardImages([node([imgSeg('/tmp/a.png')])], 8);
check('本机绝对路径可用', c.list[0] === '/tmp/a.png', JSON.stringify(c.list));
// file 字段兜底
c = forward.collectForwardImages([node([{ type: 'image', data: { file: 'file:///tmp/b.png' } }])], 8);
check('file 字段作兜底', c.list[0] === 'file:///tmp/b.png', JSON.stringify(c.list));

// 空输入不能炸
check('没有节点时返回空', forward.collectForwardImages([], 8).total === 0);
check('传 null 不炸', forward.collectForwardImages(null, 8).list.length === 0);

const flat = forward.flattenForward({ messages: nodes5 }, { maxImages: 3 });
check('flattenForward 也带出图片', flat.images.length === 3 && flat.imageTotal === 5,
  JSON.stringify({ n: flat.images.length, t: flat.imageTotal }));
check('flattenForward 文本里仍有占位', (flat.text.match(/\[图片\]/g) ?? []).length === 5,
  String((flat.text.match(/\[图片\]/g) ?? []).length));
check('flattenForward 保留发送者', flat.text.includes('张三：'), flat.text.slice(0, 60));
check('空转发返回 ok:false', forward.flattenForward({ messages: [] }).ok === false);
check('空转发也返回图片字段（便于调用方不判空）',
  Array.isArray(forward.flattenForward({ messages: [] }).images));

// ---------- AI 互聊的节奏控制 ----------
//
// 这个功能的危险处是无限循环：A 说 → B 接 → A 再接……所以除了开关，
// 更重要的是「间隔」和「连续上限」两道闸门真的生效。
console.log('--- AI 互聊：配置与节奏 ---');
const dTalk = talk.talkConfig({});
check('默认是关的', dTalk.enabled === false);
check('默认间隔 1500 毫秒', dTalk.minGapMs === 1500, String(dTalk.minGapMs));
check('默认连续上限 6 条', dTalk.maxChain === 6, String(dTalk.maxChain));

check('读得出开着的状态', talk.talkConfig({ talk: { enabled: true } }).enabled === true);
check('间隔可以改', talk.talkConfig({ talk: { minGapMs: 3000 } }).minGapMs === 3000);
check('连续上限可以改', talk.talkConfig({ talk: { maxChain: 2 } }).maxChain === 2);
// 边界：0 或负数会被夹回合理值，不然「上限 0」会让功能完全失效、「间隔 -1」会变成不等待
check('连续上限最小 1', talk.talkConfig({ talk: { maxChain: 0 } }).maxChain === 1);
check('连续上限负数也夹到 1', talk.talkConfig({ talk: { maxChain: -5 } }).maxChain === 1);
check('间隔负数夹到 0', talk.talkConfig({ talk: { minGapMs: -100 } }).minGapMs === 0);
check('间隔非数字回落到默认',
  talk.talkConfig({ talk: { minGapMs: 'abc' } }).minGapMs === 1500,
  String(talk.talkConfig({ talk: { minGapMs: 'abc' } }).minGapMs));
check('enabled 只认 true', talk.talkConfig({ talk: { enabled: 'yes' } }).enabled === false);

// 节奏：第一次不等，紧接着第二次必须等够
talk.resetGaps();
let t0 = Date.now();
const w1 = await talk.waitForGap('test:g1', 120);
const dt1 = Date.now() - t0;
check('第一次发言不等待', w1 === 0 && dt1 < 60, `waited=${w1} dt=${dt1}`);
t0 = Date.now();
const w2 = await talk.waitForGap('test:g1', 120);
const dt2 = Date.now() - t0;
check('紧接着第二次会等满间隔', w2 >= 100 && dt2 >= 100, `waited=${w2} dt=${dt2}`);
t0 = Date.now();
await talk.waitForGap('test:g1', 40);
const dt3 = Date.now() - t0;
check('间隔短就等得少', dt3 >= 30 && dt3 < 110, `dt=${dt3}`);
check('间隔为 0 时完全不等待',
  (await talk.waitForGap('test:g2', 0)) === 0);

// 计时按 key 共享：所以同一个群里几个机器人之间是互相排队的
talk.resetGaps();
await talk.waitForGap('test:g3', 120);
t0 = Date.now();
await talk.waitForGap('test:g3', 120);
check('同一个 key 共享计时（跨机器人排队）', Date.now() - t0 >= 100, String(Date.now() - t0));
t0 = Date.now();
await talk.waitForGap('test:g4', 120);
check('不同 key 互不影响（不同群各排各的）', Date.now() - t0 < 60, String(Date.now() - t0));

check('gapRemaining 能预判还要等多久',
  (() => { talk.resetGaps(); return talk.gapRemaining('test:g5', 200) === 0; })());
talk.resetGaps();
await talk.waitForGap('test:g5', 300);
check('占位之后 gapRemaining 是正数', talk.gapRemaining('test:g5', 300) > 0,
  String(talk.gapRemaining('test:g5', 300)));
talk.resetGaps();
check('reset 之后不用等', talk.gapRemaining('test:g5', 300) === 0);

// ---------- 网上素材（段子/网感语录）----------
console.log('--- 网上素材 ---');
// 关键词判断：本地粗判，不花模型调用
check('认得出「讲个段子」', jokes.looksLikeAsking('讲个段子') === true);
check('认得出「来个笑话」', jokes.looksLikeAsking('来个笑话') === true);
check('认得出「有什么好玩的」', jokes.looksLikeAsking('有什么好玩的') === true);
check('认得出「整活」', jokes.looksLikeAsking('整活') === true);
check('认得出「来个乐子」', jokes.looksLikeAsking('来个乐子') === true);
// 不该乱认
check('普通闲聊不误判', jokes.looksLikeAsking('今天上课讲什么') === false);
check('问数学题不误判', jokes.looksLikeAsking('行列式怎么算') === false);
// 「讲个题」不能被当成「讲个段子」——光有动词不算，要有名词
check('「讲个题」不误判', jokes.looksLikeAsking('给我讲个题') === false);
check('「来个例子」不误判', jokes.looksLikeAsking('来个例子') === false);
// 感叹不是请求：那是他在笑，不是在要段子
check('「笑死我了」不算要段子', jokes.looksLikeAsking('刚才那个笑死我了') === false);
check('「好搞笑」不算要段子', jokes.looksLikeAsking('这图好搞笑') === false);
check('空消息不误判', jokes.looksLikeAsking('') === false);
check('纯标点不误判', jokes.looksLikeAsking('？？？') === false);

// 解析：接口返回的字段名要对得上（一言是 hitokoto / from）
check('源是配好的列表', Array.isArray(jokes.SOURCES) && jokes.SOURCES.length >= 2, JSON.stringify(jokes.SOURCES));
check('每个源都是 https', jokes.SOURCES.every((s) => s.url.startsWith('https://')), JSON.stringify(jokes.SOURCES));
check('主源是一言', jokes.SOURCES[0].url.includes('hitokoto'), jokes.SOURCES[0].url);

// 全部源都取不到时：返回失败而不是抛错，也不是空字符串
jokes.resetJokes();
const badRes = await jokes.fetchOne({
  timeoutMs: 2000, force: true,
  sources: [{ name: '不存在的源', url: 'https://this-host-should-not-exist.invalid/x' }],
});
check('取不到时返回 ok:false', badRes.ok === false, JSON.stringify(badRes));
check('取不到时给出原因', typeof badRes.reason === 'string' && badRes.reason.length > 0, String(badRes.reason));

// 节流：刚抓过就不再打接口（这里用一个必然失败的源，靠节流不会真去请求）
jokes.resetJokes();
await jokes.fetchOne({ timeoutMs: 1000, force: true, sources: [{ name: 'x', url: 'https://a.invalid/' }] });
const t0j = Date.now();
const cached = await jokes.fetchOne({ timeoutMs: 1000, sources: [{ name: 'x', url: 'https://a.invalid/' }] });
check('失败后短时间内不再打接口（节流生效）', cached.ok === false && Date.now() - t0j < 200,
  `dt=${Date.now() - t0j}`);
jokes.resetJokes();

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
db.closeDb();
log.closeLogs();
