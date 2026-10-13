// 冒烟测试：消息规范化
import { normalizeEvent, parseCommand, stripSelfMentions, accumulate, isMarkerOnly } from '../src/message.js';
import * as log from '../src/logger.js';

const SELF = '10001';
const NICK = ['小向', '张小向'];

// NapCat 收消息时 at 段**只有 qq，没有 name**（它源码里把 name 注释掉了）。
// 早先的测试数据都带 name，于是「@ 被写成 QQ 号码」这个 bug 一路绿灯上线了，
// 所以这里的用例必须按真实形状来：只给 qq，名字靠 resolveName 补。
const NAMES = { [SELF]: '小向', 999999: '路人', 888888: '张三' };
const resolve = (qq) => NAMES[qq] ?? null;
const AT_OPTS = { selfId: SELF, nicknames: NICK, resolveName: resolve };

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', label, extra); }
};

// --- 群消息：@ 机器人 + 文字 ---
const e1 = normalizeEvent({
  post_type: 'message', message_type: 'group', group_id: 555001, user_id: 20001,
  message_id: 9001, time: 1730000000,
  sender: { card: '张三', nickname: 'zs', role: 'member' },
  message: [
    { type: 'at', data: { qq: SELF } },
    { type: 'text', data: { text: ' 这道题怎么做' } },
  ],
}, AT_OPTS);

check('群消息 kind', e1.kind === 'group');
check('群消息 peerId', e1.peerId === '555001');
check('群消息 sessionKey', e1.sessionKey === 'group:555001');
check('群消息 atSelf', e1.atSelf === true);
check('群消息 senderName 用群名片', e1.senderName === '张三');
check('群消息 textClean 去掉@', e1.textClean === '这道题怎么做', JSON.stringify(e1.textClean));
check('群消息 非命令', e1.command === null);

// --- 私聊：叫名字也算被提及 ---
const e2 = normalizeEvent({
  post_type: 'message', message_type: 'private', user_id: 20002,
  message_id: 9002, time: 1730000001,
  sender: { nickname: '李四' },
  message: [{ type: 'text', data: { text: '张小向老师你好' } }],
}, AT_OPTS);
check('私聊 叫名字也算提及', e2.atSelf === true);
check('私聊 正文里的名字保留不改', e2.textClean === '张小向老师你好', JSON.stringify(e2.textClean));

// --- 图文混排 ---
const e3 = normalizeEvent({
  post_type: 'message', message_type: 'group', group_id: 555002, user_id: 20003,
  message_id: 9003, time: 1730000002, sender: {},
  message: [
    { type: 'text', data: { text: '看这个' } },
    { type: 'image', data: { url: 'https://example.com/a.jpg', file: 'a.jpg' } },
    { type: 'image', data: { url: 'https://example.com/b.jpg', file: 'b.jpg' } },
  ],
}, AT_OPTS);
check('图片数量', e3.images.length === 2);
check('图片 url', e3.images[0].url === 'https://example.com/a.jpg');
check('未提及机器人', e3.atSelf === false);

// --- 媒体消息要留下文字痕迹 ---
//
// 早先 image/record/forward/face 都不写占位，纯媒体消息在库里就是一条空记录：
// 聊天记录里一片空白，模型读历史也只见一行空行。
console.log('--- 媒体占位 ---');
const mImg = normalizeEvent({
  post_type: 'message', message_type: 'group', group_id: 555020, user_id: 20040,
  message_id: 9040, time: 1730000020, sender: {},
  message: [{ type: 'image', data: { url: 'https://example.com/x.jpg' } }],
}, AT_OPTS);
check('纯图：text 里有占位', mImg.text === '[图片]', JSON.stringify(mImg.text));
check('纯图：textClean 仍是空的（模型那侧靠 buildTail 说明）', mImg.textClean === '', JSON.stringify(mImg.textClean));

const mVoice = normalizeEvent({
  post_type: 'message', message_type: 'group', group_id: 555021, user_id: 20041,
  message_id: 9041, time: 1730000021, sender: {},
  message: [{ type: 'record', data: { file: 'v.silk' } }],
}, AT_OPTS);
check('纯语音：text 里有占位', mVoice.text === '[语音]', JSON.stringify(mVoice.text));

const mFwd = normalizeEvent({
  post_type: 'message', message_type: 'group', group_id: 555022, user_id: 20042,
  message_id: 9042, time: 1730000022, sender: {},
  message: [{ type: 'forward', data: { id: 'fwd-9' } }],
}, AT_OPTS);
check('纯转发：text 里有占位', mFwd.text === '[聊天记录]', JSON.stringify(mFwd.text));
check('纯转发：id 照旧拿到', mFwd.forwardIds[0] === 'fwd-9');

const mFace = normalizeEvent({
  post_type: 'message', message_type: 'group', group_id: 555023, user_id: 20043,
  message_id: 9043, time: 1730000023, sender: {},
  message: [{ type: 'face', data: { id: '14' } }],
}, AT_OPTS);
check('纯表情：text 里有占位', mFace.text === '[表情]', JSON.stringify(mFace.text));

// 占位不能当成「他说的话」喂给印象提炼
check('isMarkerOnly：纯占位为真', isMarkerOnly('[图片]') === true);
check('isMarkerOnly：多个占位为真', isMarkerOnly('[图片][语音]') === true);
check('isMarkerOnly：带人话为假', isMarkerOnly('[图片] 好可爱') === false);
check('isMarkerOnly：普通文字为假', isMarkerOnly('你好') === false);
check('isMarkerOnly：空串为假', isMarkerOnly('') === false);
check('isMarkerOnly：方括号但不闭合为假', isMarkerOnly('[图片') === false);

// --- 纯视频：进 unsupported，便于走兜底 ---
const e4 = normalizeEvent({
  post_type: 'message', message_type: 'group', group_id: 555003, user_id: 20004,
  message_id: 9004, time: 1730000003, sender: {},
  message: [{ type: 'video', data: { url: 'x' } }],
}, AT_OPTS);
check('视频进 unsupported', e4.unsupported.includes('video'));
check('视频占位进文本', e4.text.includes('[视频]'));

// --- 图文混排（带文字）应能区分「纯视频」与「带文字的视频」---
const e5 = normalizeEvent({
  post_type: 'message', message_type: 'group', group_id: 555004, user_id: 20005,
  message_id: 9005, time: 1730000004, sender: {},
  message: [
    { type: 'at', data: { qq: SELF } },
    { type: 'text', data: { text: '这个搞笑不' } },
    { type: 'video', data: {} },
  ],
}, AT_OPTS);
check('带文字的视频：有正文', e5.textClean === '这个搞笑不', JSON.stringify(e5.textClean));
check('带文字的视频：也标记 unsupported', e5.unsupported.includes('video'));

// --- 引用 + 合并转发 ---
const e6 = normalizeEvent({
  post_type: 'message', message_type: 'group', group_id: 555005, user_id: 20006,
  message_id: 9006, time: 1730000005, sender: {},
  message: [
    { type: 'reply', data: { id: '777' } },
    { type: 'forward', data: { id: 'fwd-1' } },
  ],
}, AT_OPTS);
check('引用 id', e6.replyId === '777');
check('合并转发 id', e6.forwardIds[0] === 'fwd-1');

// --- 命令解析 ---
check('/learn goodex 解析', parseCommand('/learn goodex')?.name === 'learn');
check('/learn goodex 参数', parseCommand('/learn goodex')?.args[0] === 'goodex');
check('/VoiceOn 大小写无关的原始名', parseCommand('/VoiceOn')?.name === 'VoiceOn');
check('全角斜杠', parseCommand('／help')?.name === 'help');
check('非命令', parseCommand('你好') === null);
check('单独斜杠', parseCommand('/') === null);

// --- 命令必须能从「带 @ 」的文本里识别出来 ---
const e7 = normalizeEvent({
  post_type: 'message', message_type: 'group', group_id: 555006, user_id: 20007,
  message_id: 9007, time: 1730000006, sender: {},
  message: [
    { type: 'at', data: { qq: SELF } },
    { type: 'text', data: { text: ' /learn badex' } },
  ],
}, AT_OPTS);
check('带 @ 的命令能被识别', e7.command?.name === 'learn', JSON.stringify(e7.command));
check('带 @ 的命令参数正确', e7.command?.args?.[0] === 'badex');
check('带 @ 的命令正文被剥干净', e7.textClean === '/learn badex', JSON.stringify(e7.textClean));

const e8 = normalizeEvent({
  post_type: 'message', message_type: 'group', group_id: 555007, user_id: 20008,
  message_id: 9008, time: 1730000007, sender: {},
  message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: ' 你好' } }],
}, AT_OPTS);
check('带 @ 的普通问候不误判为命令', e8.command === null);

// @ 与命令之间没有空格
const e9 = normalizeEvent({
  post_type: 'message', message_type: 'group', group_id: 555008, user_id: 20009,
  message_id: 9009, time: 1730000008, sender: {},
  message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: '/undo' } }],
}, AT_OPTS);
check('@ 与命令之间没空格也能识别', e9.command?.name === 'undo', JSON.stringify(e9.command));

// @ 了别人之后再跟命令（群里常见）
const e10 = normalizeEvent({
  post_type: 'message', message_type: 'group', group_id: 555009, user_id: 20010,
  message_id: 9010, time: 1730000009, sender: {},
  message: [
    { type: 'at', data: { qq: 999999 } },
    { type: 'text', data: { text: ' /help' } },
  ],
}, AT_OPTS);
check('@了别人再跟命令也能识别', e10.command?.name === 'help', JSON.stringify(e10.command));

// ---------- @ 的显示名（真实形状：at 段没有 name）----------
//
// NapCat 只给 qq，所以名字必须由我们解析。核心要求：**绝不能让 QQ 号码
// 出现在正文里** —— 模型会把那串数字当内容，甚至照抄回来说「@123456789」。

// @ 别人：用解析出来的名字，正文里不能有数字
const at1 = normalizeEvent({
  post_type: 'message', message_type: 'group', group_id: 555010, user_id: 20020,
  message_id: 9020, time: 1730000011, sender: { card: '张三' },
  message: [
    { type: 'at', data: { qq: 888888 } },
    { type: 'text', data: { text: ' 你看这个' } },
  ],
}, AT_OPTS);
check('@别人：正文用名字', at1.text.includes('@张三'), JSON.stringify(at1.text));
check('@别人：正文里没有QQ号', !at1.text.includes('888888'), JSON.stringify(at1.text));
check('@别人：不算提及机器人', at1.atSelf === false);
check('@别人：atTokens 能对上', at1.atTokens[0]?.qq === '888888' && at1.atTokens[0]?.token === '@张三',
  JSON.stringify(at1.atTokens));
// 别人的 @ 必须留在正文里：那是「在跟谁说话」的线索，模型和聊天记录都要用
check('@别人：textClean 保留别人的@', at1.textClean === '@张三 你看这个', JSON.stringify(at1.textClean));

// 正文里手打的 @（不是真的 at 段）不该被吃掉
const atLit = normalizeEvent({
  post_type: 'message', message_type: 'private', user_id: 20030,
  message_id: 9030, time: 1730000016, sender: { nickname: '李四' },
  message: [{ type: 'text', data: { text: '邮箱是 a@b.com 你记一下' } }],
}, AT_OPTS);
check('正文里的 @ 保留', atLit.textClean === '邮箱是 a@b.com 你记一下', JSON.stringify(atLit.textClean));

// 解析不出名字：中性占位，仍然不能出现 QQ 号
const at2 = normalizeEvent({
  post_type: 'message', message_type: 'group', group_id: 555011, user_id: 20021,
  message_id: 9021, time: 1730000012, sender: {},
  message: [{ type: 'at', data: { qq: 777777 } }, { type: 'text', data: { text: ' 在吗' } }],
}, AT_OPTS);
check('解析不出名字：用中性占位', at2.text.includes('@某人'), JSON.stringify(at2.text));
check('解析不出名字：正文里没有QQ号', !at2.text.includes('777777'), JSON.stringify(at2.text));

// 完全不传 resolveName 也要安全（比如转发消息里的 @）
const at3 = normalizeEvent({
  post_type: 'message', message_type: 'group', group_id: 555012, user_id: 20022,
  message_id: 9022, time: 1730000013, sender: {},
  message: [{ type: 'at', data: { qq: 666666 } }],
}, { selfId: SELF, nicknames: NICK });
check('没有解析器时也不吐QQ号', !at3.text.includes('666666'), JSON.stringify(at3.text));
check('没有解析器时用中性占位', at3.text.includes('@某人'), JSON.stringify(at3.text));

// 群里显示的是群名片，和登录昵称不是一个词——也必须剥干净
const at4 = normalizeEvent({
  post_type: 'message', message_type: 'group', group_id: 555013, user_id: 20023,
  message_id: 9023, time: 1730000014, sender: {},
  message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: ' 在吗' } }],
}, { selfId: SELF, nicknames: NICK, resolveName: (qq) => (String(qq) === SELF ? '客服小向' : null) });
check('群名片≠昵称：自己的@也剥得掉', at4.textClean === '在吗', JSON.stringify(at4.textClean));
check('群名片≠昵称：仍算被提及', at4.atSelf === true);

// @所有人
const at5 = normalizeEvent({
  post_type: 'message', message_type: 'group', group_id: 555014, user_id: 20024,
  message_id: 9024, time: 1730000015, sender: {},
  message: [{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: ' 通知一下' } }],
}, AT_OPTS);
check('@所有人：atAll 为真', at5.atAll === true);
check('@所有人：算被提及', at5.atSelf === true);
check('@所有人：正文不留残留', at5.textClean === '通知一下', JSON.stringify(at5.textClean));

// 反斜杠不是命令
const e11 = normalizeEvent({
  post_type: 'message', message_type: 'private', user_id: 20011,
  message_id: 9011, time: 1730000010, sender: {},
  message: [{ type: 'text', data: { text: '\\help' } }],
}, AT_OPTS);
check('反斜杠不算命令', e11.command === null);

// --- 无 message_id / 非消息事件 ---
check('非 message 事件返回 null', normalizeEvent({ post_type: 'notice' }) === null);
check('空消息返回 null', normalizeEvent(null) === null);

// --- 工具函数 ---
const acc = accumulate([{ type: 'text', data: { text: 'abc' } }, { type: 'unknown_thing', data: {} }]);
check('未知类型进 unsupported', acc.unsupported.has('unknown_thing'));

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
log.closeLogs();
