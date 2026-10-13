// 冒烟测试：手动语料（学习用的第三类素材）
// 用 999xxx 的测试机器人，不碰真实的号。
import fs from 'node:fs';
import path from 'node:path';
import * as db from '../src/db.js';
import * as learning from '../src/modules/learning.js';
import * as log from '../src/logger.js';

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', label, extra ?? ''); }
};

db.openDb();
const BOT = 999003;

// 清干净，保证可重复跑
for (const n of learning.listNotes(BOT)) learning.deleteNote(BOT, n.id);
check('起始是空的', learning.listNotes(BOT).length === 0);

console.log('--- 增删查 ---');
const id1 = learning.addNote(BOT, { text: '  这条是手动加的，前后有空白  ' });
check('加一条返回 id', Number.isInteger(id1) && id1 > 0, String(id1));
learning.addNote(BOT, { text: '引用来的那条', source: 'quoted', who: '张三' });
const list = learning.listNotes(BOT);
check('能列出来', list.length === 2, String(list.length));
check('前后空白被去掉', list.some((n) => n.text === '这条是手动加的，前后有空白'), JSON.stringify(list.map((n) => n.text)));
check('引用来源和说话人被记住', list.some((n) => n.source === 'quoted' && n.who === '张三'));
check('最新在前', list[0].text === '引用来的那条');

let threw = false;
try { learning.addNote(BOT, { text: '   ' }); } catch { threw = true; }
check('空语料会被拒', threw);

learning.deleteNote(BOT, id1);
check('删掉之后只剩一条', learning.listNotes(BOT).length === 1);
learnedOk: {
  // 删别人的 id 不应该动到本机器人
  learning.deleteNote(BOT + 1, 1);
  check('删不存在的 id 不出错', learning.listNotes(BOT).length === 1);
}

console.log('--- 超长截断 ---');
const idLong = learning.addNote(BOT, { text: 'x'.repeat(9000) });
const longNote = learning.listNotes(BOT).find((n) => n.id === idLong);
check('单条截断到 4000 字', longNote.text.length === 4000, String(longNote.text.length));
learning.deleteNote(BOT, idLong);

console.log('--- 进到素材统计与学习条件里 ---');
const stats = learning.sourceStats(BOT);
check('sourceStats 里有 notes 计数', stats.notes?.count === 1, JSON.stringify(stats.notes));
const ready = learning.readiness(BOT, { learning: { sourceA: false, sourceB: false } });
check('只有手动语料也能开始学习', ready.ok === true, JSON.stringify(ready));

const notes = learning.collectNotes(BOT);
check('collectNotes 带出正文和说话人', notes.length === 1 && notes[0].who === '张三', JSON.stringify(notes));

console.log('--- /learn quote：引用别人消息收进语料（含识图）---');
const { captureQuote } = await import('../src/modules/commands.js');
const secrets = await import('../src/secrets.js');
const hadKey = secrets.hasApiKey(BOT);
secrets.setApiKey(BOT, 'test-key-not-real');   // 只为让识图这条路走通，假密钥，测试结束就清掉

// get_msg 真实返回的形状：消息对象 + message_type + sender.user_id（没有 post_type）
const quoteMsg = (message, senderName = '张三') => ({
  message_id: 9001,
  message_type: 'group',
  group_id: 10001,
  time: Math.floor(Date.now() / 1000),
  message,
  sender: { user_id: 10002, nickname: senderName, card: senderName },
});

const mkCtx = (over = {}) => ({
  botId: BOT, sessionId: 1, quoteId: 'q1', peerId: 10001,
  settings: { api: { vision: { enabled: true } } },
  client: { getMsg: async () => quoteMsg([{ type: 'text', data: { text: '这句话我觉得很好' } }]) },
  prepareImages: async () => ({ images: [{ url: 'http://example.com/a.jpg' }] }),
  chatFn: async () => ({ ok: true, text: '图里写着：你好呀' }),
  send: async () => 'out1',
  ...over,
});

// 纯文字
let r1 = await captureQuote(mkCtx());
check('引用文字消息能收下', r1.effect?.noteId > 0, JSON.stringify(r1));
check('文字内容进到语料里', learning.listNotes(BOT).some((n) => n.text === '这句话我觉得很好'));
check('说话人被记下来', learning.listNotes(BOT)[0]?.who === '张三', JSON.stringify(learning.listNotes(BOT)[0]));

// 图片 + 识图
const imgCtx = mkCtx({
  client: { getMsg: async () => quoteMsg([{ type: 'image', data: { file: 'x.jpg' } }], '李四') },
});
const r2 = await captureQuote(imgCtx);
const imgNote = learning.listNotes(BOT).find((n) => n.who === '李四');
check('引用图片能收下', r2.effect?.noteId > 0, JSON.stringify(r2));
check('图里的文字进了语料', String(imgNote?.text ?? '').includes('图里写着：你好呀'), String(imgNote?.text ?? '').slice(0, 80));
check('标明了来源是图片', String(imgNote?.text ?? '').includes('图片'), String(imgNote?.text ?? '').slice(0, 60));

// 识图关着
const offCtx = mkCtx({
  settings: { api: { vision: { enabled: false } } },
  client: { getMsg: async () => quoteMsg([{ type: 'image', data: { file: 'x.jpg' } }]) },
});
const r3 = await captureQuote(offCtx);
check('识图关着时给出提示而不是静默', !!r3.error && r3.error.includes('识别图片'), JSON.stringify(r3));

// 识图失败（模型没返回）
const failCtx = mkCtx({
  chatFn: async () => ({ ok: false, error: '模型调用失败' }),
  client: { getMsg: async () => quoteMsg([{ type: 'image', data: { file: 'x.jpg' } }]) },
});
const r4 = await captureQuote(failCtx);
check('识图失败时如实报错', !!r4.error, JSON.stringify(r4));

// 只有表情
const faceCtx = mkCtx({
  client: { getMsg: async () => quoteMsg([{ type: 'face', data: { id: '1' } }]) },
});
const r5 = await captureQuote(faceCtx);
check('只有表情时明确拒绝', !!r5.error && r5.error.includes('表情'), JSON.stringify(r5));

// 没有引用
const r6 = await captureQuote(mkCtx({ quoteId: '' }));
check('没引用时提示要用引用', !!r6.error && r6.error.includes('引用'), JSON.stringify(r6));

// 取不到那条
const r7 = await captureQuote(mkCtx({ client: { getMsg: async () => { throw new Error('消息不存在'); } } }));
check('取不到时给出原因', !!r7.error && r7.error.includes('取不到'), JSON.stringify(r7));

if (!hadKey) secrets.resetApiKey(BOT);
check('测试用的假密钥已清掉', secrets.hasApiKey(BOT) === hadKey);

console.log('--- 停顿节奏与素材文本（语音/视频那条路）---');
const { pauseStats, buildMaterialText, listMedia } = await import('../src/modules/media-learn.js');
const st1 = pauseStats([0, 0.2, 0.4, 0.6, 1.6, 1.8, 2.0]);      // 中间停了 1 秒
check('算得出停顿', st1.ok && st1.pauseCount === 1 && st1.maxPause === 1, JSON.stringify(st1));
check('算得出平均字间隔', st1.avgGap === 0.33, String(st1.avgGap));
check('几乎不停顿的情况', pauseStats([0, 0.1, 0.2, 0.3, 0.4]).pauseCount === 0);
check('时间戳太少就说不出来', pauseStats([0, 0.1]).ok === false && pauseStats([]).ok === false);
check('语速分档', pauseStats([0, 0.1, 0.2, 0.3]).pace === '偏快' && pauseStats([0, 0.5, 1.0, 1.5]).pace === '偏慢');

const materialText = buildMaterialText({
  text: '这也太离谱了吧', emotion: 'HAPPY', event: 'Laughter',
  stats: { ok: true, avgGap: 0.12, maxPause: 0.6, pauseCount: 1, pace: '偏快' }, fileName: '张三.m4a',
});
check('素材里有原文', materialText.includes('这也太离谱了吧'));
check('素材里带语气', materialText.includes('开心'), materialText);
check('素材里带笑声', materialText.includes('笑声'), materialText);
check('素材里带语速和停顿', materialText.includes('偏快') && materialText.includes('停顿'), materialText);
check('标明了来自语音和文件名', materialText.includes('来自语音') && materialText.includes('张三.m4a'));
check('没文字就返回空', buildMaterialText({ text: '' }) === '');
check('中性语气不啰嗦', !buildMaterialText({ text: '嗯', emotion: 'NEUTRAL', event: 'Speech' }).includes('NEUTRAL'));

console.log('--- 目录扫描 ---');
const tmpDir = path.join(process.env.TEMP, 'ax-media-test');
fs.mkdirSync(tmpDir, { recursive: true });
for (const f of ['a.mp3', 'b.mp4', 'c.txt']) fs.writeFileSync(path.join(tmpDir, f), 'x');
const found = listMedia(tmpDir);
check('只挑出音视频', found.length === 2 && found.every((f) => f.kind !== 'other'), JSON.stringify(found.map((f) => f.name)));
check('视频和音频分得开', found.some((f) => f.kind === 'video') && found.some((f) => f.kind === 'audio'));
check('不存在的目录返回空', listMedia(path.join(tmpDir, 'nope')).length === 0);
fs.rmSync(tmpDir, { recursive: true, force: true });

// 清干净，不给下次留东西
for (const n of learning.listNotes(BOT)) learning.deleteNote(BOT, n.id);
check('收尾清空', learning.listNotes(BOT).length === 0);

db.closeDb();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
log.closeLogs();
