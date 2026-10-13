// 冒烟测试：联网搜索（工具定义、查询词清洗、结果归一化、每小时上限、payload 透传）
//
// 不会真的发搜索请求：无密钥/不认识的服务的路径都在发请求之前就返回了。
import {
  cleanQuery, normalizeResults, formatForModel, searchQuota, noteSearch, resetSearchQuota,
  searchWeb, TOOL_SPEC, PROVIDERS, parseRss, needsKey,
} from '../src/modules/search.js';
import { buildPayload } from '../src/llm.js';
import * as log from '../src/logger.js';

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', label, extra ?? ''); }
};

console.log('--- cleanQuery ---');
check('去掉控制字符、压平空白', cleanQuery('  a\u0000b\n\nc  ') === 'a b c', JSON.stringify(cleanQuery('  a\u0000b\n\nc  ')));
check('超长截断到 180', cleanQuery('x'.repeat(500)).length === 180);
check('空值都是空串', cleanQuery(null) === '' && cleanQuery(undefined) === '' && cleanQuery('   ') === '');
check('保留中文和标点', cleanQuery('今天 上海 天气？') === '今天 上海 天气？');

console.log('--- normalizeResults ---');
const bocha = { code: 200, data: { webPages: { value: [{ name: '标题A', url: 'https://a.example', summary: '摘要A' }] } } };
check('认得博查的结构', normalizeResults(bocha, 5)[0]?.title === '标题A', JSON.stringify(normalizeResults(bocha, 5)));
check('认得裸 webPages.value', normalizeResults({ webPages: { value: [{ name: 'B', url: 'https://b', snippet: 'S' }] } })[0]?.snippet === 'S');
check('认得 data.value', normalizeResults({ data: { value: [{ title: 'C', link: 'https://c' }] } })[0]?.url === 'https://c');
check('认得 results', normalizeResults({ results: [{ title: 'D', description: 'desc' }] })[0]?.snippet === 'desc');
check('认不出就是空数组', normalizeResults({ foo: 1 }).length === 0 && normalizeResults(null).length === 0);
const many = { data: { webPages: { value: Array.from({ length: 20 }, (_, i) => ({ name: 't' + i, url: 'u' + i })) } } };
check('按 limit 截断', normalizeResults(many, 3).length === 3);
check('只有 url 的条目被丢掉', normalizeResults({ data: { value: [{ url: 'x' }] } }).length === 0);

console.log('--- formatForModel ---');
check('空结果有兜底文案', formatForModel([]).includes('没搜到'));
check('带上出处', formatForModel([{ title: 'T', url: 'https://u.example', snippet: 'S' }]).includes('https://u.example'));
check('超长会截断', formatForModel([{ title: 'T', url: 'u', snippet: 'y'.repeat(9000) }]).length <= 4000);

console.log('--- 每小时上限 ---');
resetSearchQuota();
check('初始有额度', searchQuota(999001, 2).ok === true && searchQuota(999001, 2).left === 2);
noteSearch(999001);
check('用一次少一次', searchQuota(999001, 2).left === 1);
noteSearch(999001);
check('用满后拒绝', searchQuota(999001, 2).ok === false);
check('按机器人分开计数', searchQuota(999002, 2).ok === true);
check('跨小时后重置', searchQuota(999001, 2, Date.now() + 3600000).ok === true);
resetSearchQuota();
check('reset 之后归零', searchQuota(999001, 2).used === 0);

console.log('--- 该失败的在发请求前就失败 ---');
check('博查没密钥直接失败', (await searchWeb('测试', { apiKey: '', provider: 'bocha' })).error.includes('密钥'));
check('空查询词直接失败', (await searchWeb('   ', { apiKey: 'x' })).ok === false);
check('不认识的服务直接失败', (await searchWeb('测试', { apiKey: 'x', provider: 'nope' })).ok === false);

console.log('--- 必应 RSS 解析（免密钥那条路）---');
const rssXml = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title><![CDATA[高等代数（数学课程）_百度百科]]></title><link>https://baike.baidu.com/item/x</link><description><![CDATA[沿着这两个方向继续发展 &amp; 更远]]></description></item>
<item><title>线性代数与高等代数的区别 - 知乎</title><link>https://www.zhihu.com/question/1</link><description>矩阵及其变换</description></item>
<item><title></title><link>https://x</link><description></description></item>
</channel></rss>`;
const rss = parseRss(rssXml, 5);
check('解析出条目（空条目被丢掉）', rss.length === 2, String(rss.length));
check('CDATA 和标签被清掉', rss[0]?.title === '高等代数（数学课程）_百度百科', rss[0]?.title);
check('HTML 实体被还原', String(rss[0]?.snippet).includes('& 更远'), rss[0]?.snippet);
check('链接在里面', rss[1]?.url === 'https://www.zhihu.com/question/1', rss[1]?.url);
check('条数上限生效', parseRss(rssXml, 1).length === 1);
check('不是 XML 也不炸', parseRss('hello', 5).length === 0 && parseRss(null, 5).length === 0);

console.log('--- 必应免密钥（它为什么能白嫖）---');
check('bing 不需要密钥', needsKey('bing') === false);
check('bocha 需要密钥', needsKey('bocha') === true);
check('bing 走 rss 这条路', PROVIDERS.bing.kind === 'rss');
check('两家都登记在册', !!PROVIDERS.bing && !!PROVIDERS.bocha);

console.log('--- 工具定义 ---');
check('工具名是 web_search', TOOL_SPEC.function.name === 'web_search');
check('参数里要求 query', TOOL_SPEC.function.parameters.required.includes('query'));
check('博查登记在册', !!PROVIDERS.bocha && PROVIDERS.bocha.endpoint.startsWith('https://'));

console.log('--- payload 透传 ---');
const withTools = buildPayload({ model: 'm', system: 's', history: [], tail: 'hi', tools: [TOOL_SPEC] });
check('给了工具就带上', Array.isArray(withTools.tools) && withTools.tools[0].function.name === 'web_search');
check('没给工具就不带', buildPayload({ model: 'm', system: 's', history: [], tail: 'hi' }).tools === undefined);
check('空数组也不带', buildPayload({ model: 'm', system: 's', history: [], tail: 'hi', tools: [] }).tools === undefined);
const toolMsgs = buildPayload({
  model: 'm', system: 's', tail: 'hi',
  history: [
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '结果' },
  ],
});
check('工具消息原样透传', toolMsgs.messages.some((m) => m.role === 'tool') && toolMsgs.messages.some((m) => m.tool_calls));
check('system 与 tail 顺序没乱', toolMsgs.messages[0].role === 'system' && toolMsgs.messages.at(-1).role === 'user');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
log.closeLogs();
