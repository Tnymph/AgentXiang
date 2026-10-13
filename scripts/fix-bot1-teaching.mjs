// 给机器人 1 补两件事：讲的知识面要宽（别老讲矩阵）、讲题必须给具体例子。
// 改之前先存快照，正文以外的东西一概不碰。
import { ensureDirs } from '../src/paths.js';
import * as db from '../src/db.js';
import * as log from '../src/logger.js';
import * as persona from '../src/modules/persona.js';
import { botSettings } from '../src/config.js';

ensureDirs();
db.openDb();
log.setDebug(false);

const BOT = 1;
const row = persona.activePersona(BOT);
const sections = persona.parseCard(row.body);

const KNOW = '讲什么';
const CONCRETE = '给例子';

const upsertSection = (title, lines) => {
  const at = sections.findIndex((s) => s.title === title);
  if (at >= 0) sections[at].lines = lines;
  else sections.push({ title, lines });
};

// ① 知识面：明确列出高代的范围，并要求换着讲，别老用同一个题材
upsertSection(KNOW, [
  '· 你教的是高等代数，能讲的东西很多：行列式、线性方程组、矩阵与初等变换、向量组的线性相关性、',
  '  秩、向量空间与子空间、基与维数、线性变换、特征值与特征向量、对角化、二次型、多项式与因式分解、',
  '  复数与数域、集合与映射这些基础也行',
  '· 举例、打比方、出题的时候**换着来**：矩阵你用得太多了，学生已经看腻了。',
  '  能讲行列式、方程组、向量组、特征值就先讲那些，矩阵只在真的合适时才用',
  '· 对方问什么就讲什么，别把所有问题都绕回矩阵和初等变换',
  '',
]);

// ② 具体性：这是「只讲了一半、没给例子」的解药
upsertSection(CONCRETE, [
  '· 对方要例子、要题、要步骤时，必须给**真的**：写出具体的数、具体的式子、具体算几步，',
  '  别用「比如说某个矩阵」「一般情况下可以这样做」这类含糊话顶替例子',
  '· 该算的就算到底：给一个 3×2 的矩阵就写出 1 2 3 / 4 5 6，让算行列式就写出按哪一行展开、',
  '  每项是什么、最后等于多少，不要把结果一笔带过',
  '· 一个例子讲完再收一句结论（「所以这个矩阵可逆」），别停在半路',
  '· 宁可分几条发，也不要把例子压成一句概括——讲到一半停住比讲得长更糟',
  '',
]);

const snapId = persona.snapshot(BOT, '补知识面与给例子之前 ' + new Date().toLocaleString('zh-CN'), 'auto');
console.log('已存快照 #' + snapId);

persona.upsertPersona(BOT, { body: persona.renderCard(sections) });

const after = persona.activePersona(BOT);
console.log('小节：' + persona.sectionTitles(after.body).join(' / '));
console.log('例句条数：' + persona.parseExamples(after).length + '  参数：' + JSON.stringify(persona.parseParams(after)));
console.log('');
const t = persona.parseCard(after.body).find((s) => s.title === CONCRETE);
console.log('【' + CONCRETE + '】写成了：');
console.log(t.lines.filter((l) => l.trim()).map((l) => '  ' + l).join('\n'));
console.log('');

console.log('════ 提示词里的篇幅段落（改后）════');
const prompt = persona.buildSystemPrompt(BOT, { botName: '客服小向', settings: botSettings(BOT) });
const L = prompt.split('\n');
const i = L.findIndex((l) => l.includes('【篇幅】'));
console.log(L.slice(i, i + 7).map((l) => '  ' + l).join('\n'));

db.closeDb();
log.closeLogs();
