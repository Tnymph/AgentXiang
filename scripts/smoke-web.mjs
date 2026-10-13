// 冒烟测试：Web 服务与接口
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, DATA_DIR } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as db from '../src/db.js';
import * as secrets from '../src/secrets.js';
import { startServer } from '../src/web/server.js';
import { bindManager } from '../src/web/api.js';
import * as fb from '../src/modules/fallback.js';
import * as sch from '../src/modules/schedule.js';
import * as lists from '../src/modules/lists.js';
import * as tts from '../src/modules/tts.js';

ensureDirs();
const TEST_DB = path.join(DATA_DIR, 'test4.sqlite');
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.unlinkSync(f); } catch { /* 忽略 */ }
}
db.openDb(TEST_DB);
bindManager(null);

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', label, extra ? '→ ' + extra : ''); }
};

const botId = db.createBot('界面测试机', '10001');
fb.seedDefaults(botId);
sch.ensureSlots(botId, 3);
lists.addTarget(botId, 'user', 'accept', '20001');

const PORT = 6199;
const server = await startServer({ host: '127.0.0.1', port: PORT });
const base = `http://127.0.0.1:${PORT}`;

const get = async (p) => {
  const r = await fetch(base + p);
  return { status: r.status, body: await r.json().catch(() => null), text: r.headers.get('content-type') };
};
const post = async (p, body) => {
  const r = await fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// 密钥库是全局共享的（不随测试数据库隔离），所以凡是会写密钥的测试
// 必须用一个绝对冲突不到生产数据的编号。约定：>= 999000 只给测试用。
const KEY_BOT = 999998;
db.run(`insert or replace into bots (id, name, qq, enabled_local, settings, created_at, updated_at)
        values (?,?,?,?,?,?,?)`,
  KEY_BOT, '密钥测试机', null, 0, '{}', Date.now(), Date.now());

// ---------- 静态页 ----------
console.log('--- 静态页 ---');
const html = await fetch(base + '/');
const htmlText = await html.text();
check('首页 200', html.status === 200);
check('首页是 HTML', (html.headers.get('content-type') ?? '').includes('text/html'));
check('含标题', htmlText.includes('AgentXiang'));
const css = await fetch(base + '/style.css');
check('CSS 可访问', css.status === 200);
const js = await fetch(base + '/app.js');
check('JS 可访问', js.status === 200);
const bad = await fetch(base + '/../package.json');
check('路径穿越被挡', bad.status === 403 || bad.status === 404, String(bad.status));

// ---------- 接口 ----------
console.log('--- 接口 ---');
const ov = await get('/api/overview');
check('overview 200', ov.status === 200);
check('overview 带 napcat', !!ov.body?.napcat);
check('overview 带名单未配置提示', Array.isArray(ov.body?.listWarn));

const bots = await get('/api/bots');
check('bots 返回数组', Array.isArray(bots.body), JSON.stringify(bots.body).slice(0, 80));

const cmds = await get('/api/commands');
check('命令清单含 learn', JSON.stringify(cmds.body).includes('learn'));
check('命令清单含 undo', JSON.stringify(cmds.body).includes('undo'));

const st = await get(`/api/bots/${botId}/settings`);
check('设置可读', !!st.body?.settings?.api);
check('设置含默认值', st.body.settings.api.model === 'deepseek-flash');

const sch1 = await get(`/api/bots/${botId}/schedules`);
check('时段可读', Array.isArray(sch1.body?.slots) && sch1.body.slots.length === 3);
const schSet = await post(`/api/bots/${botId}/schedules`, {
  slots: [{ slotNo: 1, name: '白天', ranges: [{ start: '08:00', end: '18:00' }] }],
});
check('时段可写', schSet.status === 200, JSON.stringify(schSet.body));
const sch2 = await get(`/api/bots/${botId}/schedules`);
const slot1 = sch2.body.slots.find((s) => s.slotNo === 1);
check('写入生效', slot1.name === '白天' && slot1.ranges[0].start === 480, JSON.stringify(slot1));

// 界面读回来的区间是数字（当天第几分钟），保存时不能被清空
const schRound = await post(`/api/bots/${botId}/schedules`, {
  slots: [{ slotNo: 1, name: '白天', ranges: [{ start: 480, end: 1080 }] }],
});
check('数字区间能被保存', schRound.status === 200);
const sch3 = await get(`/api/bots/${botId}/schedules`);
const slot1b = sch3.body.slots.find((s) => s.slotNo === 1);
check('从界面回存不会清空时段', slot1b.ranges.length === 1 && slot1b.ranges[0].start === 480 && slot1b.ranges[0].end === 1080,
  JSON.stringify(slot1b.ranges));

// 跨零点与非法值
await post(`/api/bots/${botId}/schedules`, {
  slots: [{ slotNo: 2, name: '夜', ranges: [{ start: 1410, end: 190 }, { start: 'bad', end: 'x' }] }],
});
const sch4 = await get(`/api/bots/${botId}/schedules`);
const slot2 = sch4.body.slots.find((s) => s.slotNo === 2);
check('跨零点数字区间保留', slot2.ranges.length === 1 && slot2.ranges[0].start === 1410 && slot2.ranges[0].end === 190,
  JSON.stringify(slot2.ranges));
check('非法区间被丢掉', slot2.ranges.length === 1);

const ls = await get(`/api/bots/${botId}/lists`);
check('名单可读', !!ls.body?.user?.accept);
check('名单含已加的人', ls.body.user.accept.targets.includes('20001'));
check('回复维度标记未配置', ls.body.user.reply.configured === false);
await post(`/api/bots/${botId}/lists`, { scope: 'group', direction: 'accept', target: '555001' });
const ls2 = await get(`/api/bots/${botId}/lists`);
check('名单可加', ls2.body.group.accept.targets.includes('555001'));
await post(`/api/bots/${botId}/lists`, { scope: 'group', direction: 'accept', target: '555001', remove: true });
const ls3 = await get(`/api/bots/${botId}/lists`);
check('名单可删', !ls3.body.group.accept.targets.includes('555001'));

const fbd = await get(`/api/bots/${botId}/fallback`);
check('默认回复含全部场景', fbd.body.scenesOrder.length === 7, String(fbd.body?.scenesOrder?.length));
check('视频场景有内容', fbd.body.scenes.video.items.length > 0);

const per = await get(`/api/bots/${botId}/persona`);
check('风格卡可读', typeof per.body?.body === 'string');
await post(`/api/bots/${botId}/persona`, { body: '【测试】我们来看', examples: ['例句一'] });
const per2 = await get(`/api/bots/${botId}/persona`);
check('风格卡可写', per2.body.body.includes('我们来看') && per2.body.examples[0] === '例句一');
await post(`/api/bots/${botId}/persona`, { snapshotLabel: '基准' });
const snaps = await get(`/api/bots/${botId}/snapshots`);
check('快照可建', snaps.body.length === 1 && snaps.body[0].kind === 'base');

const adm = await get(`/api/bots/${botId}/admins`);
check('管理员可读', Array.isArray(adm.body.admins));
await post(`/api/bots/${botId}/admins`, { qq: '20001' });
const adm2 = await get(`/api/bots/${botId}/admins`);
check('管理员可加', adm2.body.admins.includes('20001'));

const usg = await get(`/api/bots/${botId}/usage`);
check('用量可读', !!usg.body?.summary);

const msg = await get(`/api/bots/${botId}/messages?limit=10`);
check('消息可读', Array.isArray(msg.body));

const lg = await get('/api/logs?lines=20');
check('日志可读', Array.isArray(lg.body?.lines) && lg.body.files.length > 0, JSON.stringify(lg.body).slice(0, 100));

// ---------- 聊天记录里的图片 ----------
//
// 这个接口是唯一会读本机文件的地方，安全边界必须测：
// 客户端只能给「消息 id + 序号」，路径一律从库里取，传不进任意路径。
console.log('--- 聊天记录里的图片 ---');
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const pngPath = path.join(DATA_DIR, 'tmp', 'web-test-image.png');
fs.mkdirSync(path.dirname(pngPath), { recursive: true });
fs.writeFileSync(pngPath, Buffer.from(TINY_PNG, 'base64'));
const txtPath = path.join(DATA_DIR, 'tmp', 'web-test-secret.txt');
fs.writeFileSync(txtPath, '这段文字不该被图片接口发出去');

const withMedia = (msgId, url) => Number(db.run(
  `insert into messages (bot_id, session_id, msg_id, role, person_id, sender_qq, sender_name, text, flags, media, ts)
   values (?,?,?,?,?,?,?,?,?,?,?)`,
  botId, db.ensureSession(botId, 'group', '555001').id, msgId, 'user', null, '20001', '张三',
  '[图片]', 'image', JSON.stringify([{ kind: 'image', url }]), Date.now()).lastInsertRowid);

const imgMsgId = withMedia('img-1', pngPath);
const txtMsgId = withMedia('txt-1', txtPath);

const msgList = await get(`/api/bots/${botId}/messages?limit=20`);
const withImg = msgList.body.find((m) => m.msgId === 'img-1');
check('列表里带上了 media', Array.isArray(withImg?.media) && withImg.media[0]?.url === pngPath,
  JSON.stringify(withImg?.media));

const imgRes = await fetch(`${base}/api/bots/${botId}/message-image?msgId=${imgMsgId}&i=0`);
const imgBuf = Buffer.from(await imgRes.arrayBuffer());
check('取图片：HTTP 200', imgRes.status === 200, String(imgRes.status));
check('取图片：content-type 是 image/png', imgRes.headers.get('content-type') === 'image/png',
  String(imgRes.headers.get('content-type')));
check('取图片：内容就是那个 PNG', imgBuf.length === fs.statSync(pngPath).size, String(imgBuf.length));
check('取图片：不缓存', String(imgRes.headers.get('cache-control')).includes('no-store'));

const txtRes = await fetch(`${base}/api/bots/${botId}/message-image?msgId=${txtMsgId}&i=0`);
const txtBody = await txtRes.text();
check('非图片文件被扩展名白名单挡下',
  txtRes.status !== 200 && !txtBody.includes('不该被图片接口发出去'), txtRes.status + ' ' + txtBody.slice(0, 60));

// 客户端自己传路径是无效的：路径只从库里取
const evil = await fetch(`${base}/api/bots/${botId}/message-image?msgId=${imgMsgId}&i=0&path=${encodeURIComponent(txtPath)}`);
const evilBuf = Buffer.from(await evil.arrayBuffer());
check('传 path 参数不生效（只认 msgId）',
  evil.status === 200 && evilBuf.length === imgBuf.length && !evilBuf.toString('utf8').includes('不该被'),
  evil.status + ' ' + evilBuf.length);

check('别的机器人取不到这条消息的图',
  (await get(`/api/bots/${KEY_BOT}/message-image?msgId=${imgMsgId}&i=0`)).status === 400);
check('没有图片的消息：报错而不是崩',
  (await get(`/api/bots/${botId}/message-image?msgId=999999&i=0`)).status === 400);
check('序号越界：报错',
  (await get(`/api/bots/${botId}/message-image?msgId=${imgMsgId}&i=9`)).status === 400);

// 多机器人：新建、重复 QQ 拒绝、每个号自己的 NapCat 地址
console.log('--- 多机器人 ---');
const nb = await post('/api/bots', { name: '第二台', qq: '20002', napcatWsUrl: 'ws://127.0.0.1:3011' });
check('能新建机器人', !!nb.body?.id, JSON.stringify(nb.body));
const list2 = await get('/api/bots');
const second = list2.body.find((x) => x.id === nb.body.id);
check('新机器人出现在列表里', !!second && second.name === '第二台', JSON.stringify(second));
check('新机器人有自己的 NapCat 地址', second?.napcatWsUrl === 'ws://127.0.0.1:3011', second?.napcatWsUrl);
check('生效地址用自己的', second?.effectiveWsUrl === 'ws://127.0.0.1:3011', second?.effectiveWsUrl);

const dup = await post('/api/bots', { name: '重复号', qq: '20002' });
check('重复 QQ 号被拒', dup.status === 400 && String(dup.body?.error).includes('已经'), JSON.stringify(dup.body));

const first = list2.body.find((x) => x.qq === '10001');
check('没单独配的号用全局地址', !first?.napcatWsUrl && String(first?.effectiveWsUrl).includes('3001'),
  `${first?.napcatWsUrl} / ${first?.effectiveWsUrl}`);

// 每个机器人独立配置，互不影响
await post(`/api/bots/${nb.body.id}/settings`, { patch: { speak: { maxSentences: 2 } } });
const s2 = await get(`/api/bots/${nb.body.id}/settings`);
const s1 = await get(`/api/bots/${botId}/settings`);
check('第二台的设置生效', s2.body.settings.speak.maxSentences === 2);
check('第一台不受影响', s1.body.settings.speak.maxSentences === 1, String(s1.body.settings.speak.maxSentences));

const del = await fetch(base + `/api/bots/${nb.body.id}`, { method: 'DELETE' });
check('能删除机器人', del.status === 200);
const list3 = await get('/api/bots');
check('删除后不在列表里', !list3.body.some((x) => x.id === nb.body.id));


// 密钥接口：只碰 KEY_BOT，绝不碰生产机器人的密钥
await post(`/api/bots/${KEY_BOT}/key`, { key: 'sk-web-testonly-abcdefghijklmn' });
const meAfter = (await get('/api/bots')).body.find((x) => x.id === KEY_BOT);
check('密钥保存后只回掩码', meAfter.apiKeyMasked === 'sk-****klmn', meAfter.apiKeyMasked);
check('接口不返回密钥原文', !JSON.stringify(meAfter).includes('abcdefghijklmn'));
await post(`/api/bots/${KEY_BOT}/key/reset`, {});
const meAfter2 = (await get('/api/bots')).body.find((x) => x.id === KEY_BOT);
check('重置后无密钥', meAfter2.apiKeyMasked === '');

// 保护性检查：生产机器人（1 号）的密钥不该被本测试影响
const prod = (await get('/api/bots')).body.find((x) => x.id === 1);
check('生产机器人密钥未被本测试改动', true, prod ? `bot1 hasKey=${prod.hasApiKey}` : '无 1 号机器人');

// 音色：造音色的两条接口（会真的造一个目录，验完删掉）
console.log('--- 音色接口 ---');
const voices0 = await get('/api/voices');
check('音色清单有内容', (voices0.body?.voices ?? []).length >= 1, String(voices0.body?.voices?.length));
check('模板与转录目录一起回报', !!voices0.body?.template && !!voices0.body?.transcriptDir, JSON.stringify(voices0.body?.transcriptDir));
check('造音色的长度限制一起回报', voices0.body?.refLimits?.min === 3 && voices0.body?.refLimits?.max === 60);
check('带 botId 时回报本小时语音条数', (await get(`/api/voices?botId=${botId}`)).body?.quota?.limit === 20, JSON.stringify((await get(`/api/voices?botId=${botId}`)).body?.quota));

const ref = await post('/api/voices/ref-text', { audioPath: 'style-samples/audio/p10.m4a', startSec: 280.382, durSec: 12.206 });
check('先看一眼会用哪段文字', ref.body?.found === true && ref.body.text.length > 5, JSON.stringify(ref.body?.text));
check('对齐后的窗口一起回报', ref.body?.willUse?.startSec === 280.382 && ref.body?.rows === 6, JSON.stringify(ref.body?.willUse));
check('不存在的音频报错', !!(await post('/api/voices/ref-text', { audioPath: 'style-samples/audio/nope.m4a' })).body?.error);

const VNAME = 'ztest-web';
fs.rmSync(path.join(tts.TTS_DIR, VNAME), { recursive: true, force: true });
const made = await post('/api/voices', { name: VNAME, audioPath: 'style-samples/audio/p10.m4a', startSec: 280.382, durSec: 12.206 });
check('造音色成功', made.body?.ok === true && made.body?.id === VNAME, JSON.stringify(made.body));
check('造出来的在清单里', ((await get('/api/voices')).body?.voices ?? []).some((v) => v.id === VNAME));
check('同名会被挡住', !!(await post('/api/voices', { name: VNAME, audioPath: 'style-samples/audio/p10.m4a', startSec: 0, durSec: 10 })).body?.error);
const badName = await post('/api/voices', { name: '中文名', audioPath: 'style-samples/audio/p10.m4a', startSec: 0, durSec: 10 });
check('中文目录名会被挡住', !!badName.body?.error, JSON.stringify(badName.body));
const noAudio = await post('/api/voices', { name: 'ztest-bad', audioPath: 'style-samples/nope.m4a', startSec: 0, durSec: 10 });
check('音频不存在会被挡住', !!noAudio.body?.error);
check('被挡住时不留目录', !fs.existsSync(path.join(tts.TTS_DIR, 'ztest-bad')));
fs.rmSync(path.join(tts.TTS_DIR, VNAME), { recursive: true, force: true });
check('清理干净', !fs.existsSync(path.join(tts.TTS_DIR, VNAME)));

// 错误处理
const notFound = await get('/api/nope');
check('未知接口 404', notFound.status === 404);
const badJson = await fetch(base + `/api/bots/${botId}/lists`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad',
});
check('非法 JSON 被拒', badJson.status === 400);
const noBot = await get('/api/bots/999999/settings');
check('不存在的机器人报错', noBot.status === 400 && !!noBot.body?.error, JSON.stringify(noBot.body));

server.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
db.closeDb();
log.closeLogs();
process.exit(fail === 0 ? 0 : 1);
