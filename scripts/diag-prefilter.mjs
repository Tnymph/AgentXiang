// 实测粗筛对「纯图片」的判定
import { ensureDirs } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as speaking from '../src/modules/speaking.js';
import { defaultBotSettings } from '../src/config.js';

ensureDirs();
const settings = defaultBotSettings();
// 用用户当前的实际参数
settings.speak.defaultGroupMode = 'active';
settings.speak.active = { perGroupMinute: 0, perGroupPerHour: 300, minGapSec: 1, minMessageLength: 1, randomRate: 0.8 };

const always = () => 0;      // 让随机闸门一定放行，只看长度那关

const cases = [
  { label: '纯图片（无文字）', msg: { textClean: '', images: [{ url: 'x' }] } },
  { label: '纯图片（有文字标记 [图片]）', msg: { textClean: '[图片]', images: [{ url: 'x' }] } },
  { label: '图片 + 一句话', msg: { textClean: '这啥', images: [{ url: 'x' }] } },
  { label: '纯文字', msg: { textClean: '这期神了', images: [] } },
  { label: '只有一个字', msg: { textClean: '唐', images: [] } },
  { label: '纯合并转发', msg: { textClean: '', images: [], forwardIds: ['f1'] } },
  { label: '真空消息', msg: { textClean: '', images: [] } },
];

for (const c of cases) {
  const r = speaking.prefilter(c.msg, settings, { random: always });
  console.log(`${r.pass ? '✅ 放行' : '❌ 拦下'}  ${c.label.padEnd(24)} ${r.reason}`);
}

console.log('');
console.log('--- 兜底判定：图片会不会被当成「无法处理」---');
for (const c of cases) {
  const u = speaking.isUnprocessable(c.msg);
  const scene = speaking.fallbackScene(c.msg);
  console.log(`${u ? '是' : '否'}  ${c.label.padEnd(24)} 兜底场景=${scene ?? '(不兜底)'}`);
}

log.closeLogs();
