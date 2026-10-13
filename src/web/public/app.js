'use strict';

// ---------- 状态 ----------
const SECTIONS = [
  ['overview', '概览'],
  ['runtime', '运行'],
  ['login', '扫码登录'],
  ['access', '接入与密钥'],
  ['schedules', '时段方案'],
  ['lists', '名单'],
  ['fallback', '默认回复'],
  ['pickup', '接话'],
  ['speech', '发言与频控'],
  ['persona', '风格卡'],
  ['learn', '学习'],
  ['impressions', '印象'],
  ['voices', '音色'],
  ['commands', '命令与管理员'],
  ['messages', '聊天记录'],
  ['logs', '日志'],
];

/** 从地址栏读当前页面，这样每个页面都能直接用链接打开 */
function sectionFromHash() {
  const k = (location.hash || '').replace(/^#/, '');
  return SECTIONS.some(([key]) => key === k) ? k : 'overview';
}

// 当前选的是哪个机器人要记住。刷新页面时 state 会重建，只放在内存里的话
// 每次都会掉回列表第一个——管理多个机器人时很烦。
//
// 注意：这段必须在 state 之前。state 初始化时就调用 savedBotId()，
// 而 const 不像函数声明会提升——放下面会撞上暂时性死区，整个模块直接抛错白屏。
const BOT_KEY = 'agentxiang.botId';

function savedBotId() {
  const v = Number(localStorage.getItem(BOT_KEY));
  return Number.isFinite(v) && v > 0 ? v : null;
}

function setSavedBotId(id) {
  if (id) localStorage.setItem(BOT_KEY, String(id));
  else localStorage.removeItem(BOT_KEY);
}

const state = {
  botId: savedBotId(),
  section: sectionFromHash(),
  bots: [],
  overview: null,
  cache: {},
};

/** 切页：改地址栏（会触发 hashchange 统一走渲染），地址已对就直接渲染 */
function go(key) {
  if (key === state.section && location.hash === '#' + key) return;
  if (location.hash === '#' + key) {
    // 地址已经对了，hashchange 不会触发，直接渲染
    state.section = key;
    state.cache = {};
    render();
    return;
  }
  // 只改地址栏，state.section 留给 hashchange 去改。
  // 这里千万不能先改 state.section：hashchange 那句「地址没变就跳过」会因此直接 return，
  // 结果就是点了导航只换地址、正文不动（这个 bug 在加了「运行」页做浏览器验证时才抓到）。
  location.hash = '#' + key;
}

// ---------- 小工具 ----------
function h(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'selected' || k === 'disabled') e[k] = !!v;
    else if (k === 'value') e.value = v;
    else e.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

/**
 * 只允许调本机自己的接口：相对路径、且必须以 /api/ 开头。
 * 页面逻辑里没有一处需要请求外部地址，这条校验把「path 拼进 fetch」变成
 * 一个受约束的数据流（静态安全扫描会把没有约束的 fetch(path) 判成 SSRF 入口）。
 */
function localApiUrl(path) {
  const p = String(path ?? '');
  if (!p.startsWith('/api/') || p.startsWith('//') || p.includes('\\')) {
    throw new Error('只允许访问本机 /api/ 接口：' + p.slice(0, 60));
  }
  const url = new URL(p, location.origin);
  if (url.origin !== location.origin) throw new Error('拒绝跨站请求');
  return url.pathname + url.search;
}

async function api(path, body) {
  const res = await fetch(localApiUrl(path), body === undefined ? {} : {
    method: 'POST',
    // X-AgentXiang 是给「运行」页那种会启停进程的接口看的：带自定义头的跨域请求
    // 必须先过预检，别的网页因此没法在后台偷偷调它们。
    headers: { 'Content-Type': 'application/json', 'X-AgentXiang': '1' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

async function apiDel(path) {
  const res = await fetch(localApiUrl(path), { method: 'DELETE', headers: { 'X-AgentXiang': '1' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

let toastTimer = null;
function toast(msg, bad) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = bad ? '#dc2626' : '#1f2328';
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

const b = (label, fn, cls = '', attrs = {}) => h('button', { class: cls, onclick: fn, ...attrs }, label);
const card = (title, hint, ...kids) => h('div', { class: 'card' },
  title ? h('h2', { text: title }) : null,
  hint ? h('p', { class: 'hint', text: hint }) : null,
  ...kids);
const field = (label, input) => h('label', { class: 'inline' },
  h('span', { class: 'muted', text: label }), input);

const API = () => `/api/bots/${state.botId}`;

// 路径配置（「运行」页的「位置」卡片）。别处要显示真实目录时从这里取 ——
// 写死 .tools 的话，用户把模型挪到别的盘以后，界面上的说明就全错了。
let PATHS = null;
const dirPath = (key, fallback) => PATHS?.dirs?.find((d) => d.key === key)?.value ?? fallback;

// ---------- 启动 ----------
async function boot() {
  buildNav();
  document.getElementById('botPick').addEventListener('change', (e) => {
    state.botId = Number(e.target.value);
    setSavedBotId(state.botId);
    state.cache = {};
    render();
  });
  window.addEventListener('hashchange', () => {
    const key = sectionFromHash();
    if (key === state.section) return;
    state.section = key;
    state.cache = {};
    render();
  });

  // 侧栏底部的自动刷新开关
  const foot = document.querySelector('.side-foot');
  const cb = h('input', { type: 'checkbox', checked: autoRefreshOn() });
  cb.addEventListener('change', () => {
    setAutoRefresh(cb.checked);
    toast(cb.checked ? '已开启自动刷新' : '已暂停自动刷新');
  });
  foot.append(h('label', { class: 'inline', style: 'margin-top:8px;font-size:12px' },
    cb, h('span', { id: 'autoLabel' })));
  updateAutoLabel();
  startTicker();

  await refreshBots();
  PATHS = await api('/api/paths').catch(() => null);
  await render();
}

function buildNav() {
  const nav = document.getElementById('nav');
  nav.replaceChildren(...SECTIONS.map(([key, label]) =>
    h('button', {
      class: state.section === key ? 'on' : '',
      onclick: () => go(key),
    }, label)));
}

async function refreshBots() {
  state.overview = await api('/api/overview');
  state.bots = state.overview.bots;
  const pick = document.getElementById('botPick');
  pick.replaceChildren(...state.bots.map((x) =>
    h('option', { value: x.id, text: `${x.name}${x.qq ? ' (' + x.qq + ')' : ''}` })));
  // 记住的那个可能已经被删了，或者第一次打开还没有——回退到第一个并写回，
  // 这样下次刷新不会再跳。
  if (!state.bots.some((x) => x.id === state.botId)) state.botId = state.bots[0]?.id ?? null;
  setSavedBotId(state.botId);
  pick.value = state.botId ?? '';
  pick.disabled = state.bots.length === 0;

  const st = document.getElementById('botStatus');
  const me = state.bots.find((x) => x.id === state.botId);
  if (!me) { st.textContent = '还没有机器人'; }
  else {
    const bits = [me.connected ? '已连接' : (me.running ? '连接中…' : '未运行')];
    if (!me.hasApiKey) bits.push('未设密钥');
    st.textContent = bits.join(' · ');
  }
  const apiState = document.getElementById('apiState');
  if (!state.bots.length) { apiState.textContent = '无机器人'; apiState.className = 'pill'; }
  else if (!me) { apiState.textContent = '—'; apiState.className = 'pill'; }
  else if (!me.connected) { apiState.textContent = '未连接'; apiState.className = 'pill bad'; }
  else { apiState.textContent = '运行中'; apiState.className = 'pill ok'; }
}

// ---------- 自动刷新 ----------
//
// 分两类页面处理：
//  · 看数据为主的页面（概览 / 聊天记录 / 日志）自动重绘，不用手动刷新
//  · 配置表单的页面（风格卡 / 名单 / 默认回复 等）**绝不自动重绘**，
//    否则你正在输入的内容会被清掉。这类页面保存后本来就会自己重绘一次。
//
// 侧栏的连接状态则一直自动更新，不受当前页面影响。

const AUTO_KEY = 'agentxiang.autoRefresh';
const LIVE_SECTIONS = new Set(['overview', 'runtime', 'messages', 'logs']);
const TICK_MS = 5000;

let ticker = null;

function autoRefreshOn() {
  const v = localStorage.getItem(AUTO_KEY);
  return v === null ? true : v === '1';
}

function setAutoRefresh(on) {
  localStorage.setItem(AUTO_KEY, on ? '1' : '0');
  updateAutoLabel();
}

function updateAutoLabel() {
  const el = document.getElementById('autoLabel');
  if (el) el.textContent = autoRefreshOn() ? '自动刷新' : '已暂停';
}

/** 正在输入控件里的话就别动页面，免得把人家打了一半的字冲掉 */
function isEditing() {
  const el = document.activeElement;
  if (!el) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

async function tick() {
  if (!autoRefreshOn() || document.hidden) return;
  try { await refreshBots(); } catch { return; }
  if (!LIVE_SECTIONS.has(state.section) || isEditing()) return;

  const head = document.getElementById('headActions');
  const body = document.getElementById('content');
  const fn = RENDERERS[state.section];
  if (!fn) return;

  // 记住滚动位置：日志页你往上翻的时候不该被拽回底部
  const logPre = body.querySelector('.log');
  const logAtBottom = logPre ? logPre.scrollHeight - logPre.scrollTop - logPre.clientHeight < 40 : true;
  const logTop = logPre?.scrollTop ?? 0;

  let out;
  try { out = await fn(head); } catch { return; }
  const nodes = Array.isArray(out) ? out : [out];
  const html = nodes.map((n) => n?.outerHTML ?? '').join('');

  // 内容没变就别重绘，避免闪烁和滚动跳动
  if (html === body.__lastHtml) return;
  body.__lastHtml = html;
  body.replaceChildren(...nodes);

  const nextPre = body.querySelector('.log');
  if (nextPre) nextPre.scrollTop = logAtBottom ? nextPre.scrollHeight : logTop;
}

function startTicker() {
  if (ticker) clearInterval(ticker);
  ticker = setInterval(tick, TICK_MS);
}

// ---------- 渲染 ----------
async function render() {
  buildNav();
  await refreshBots();
  const sec = SECTIONS.find(([k]) => k === state.section);
  document.getElementById('title').textContent = sec ? sec[1] : '';
  const head = document.getElementById('headActions');
  const body = document.getElementById('content');
  head.replaceChildren();
  body.replaceChildren(h('div', { class: 'empty', text: '载入中…' }));
  body.__lastHtml = null;

  try {
    const fn = RENDERERS[state.section];
    const out = await fn(head);
    const nodes = Array.isArray(out) ? out : [out];
    body.__lastHtml = nodes.map((n) => n?.outerHTML ?? '').join('');
    body.replaceChildren(...nodes);
  } catch (e) {
    const err = h('div', { class: 'note', text: '载入失败：' + e.message });
    body.__lastHtml = err.outerHTML;
    body.replaceChildren(err);
  }
}

const RENDERERS = {};

// ---------- 概览 ----------
RENDERERS.overview = async () => {
  const out = [];

  // 一个机器人都没有时，不早返回——下面的「机器人」卡片里就带着添加表单
  const me = state.bots.find((x) => x.id === state.botId);
  const u = state.overview.usage.find((x) => x.id === state.botId) ?? {};
  const warn = state.overview.listWarn.find((x) => x.id === state.botId);

  if (state.bots.length === 0) {
    out.push(h('div', { class: 'note' },
      '还没有机器人。在下面的表单里加一个，再去「扫码登录」页登录小号、去「接入与密钥」页填 API 密钥。'));
  }
  if (warn?.unconfigured && state.bots.length) {
    out.push(h('div', { class: 'note' },
      '名单还没配置，机器人现在不会响应任何人。去「名单」里把你自己和要用的群加进去。'));
  }

  if (state.bots.length) out.push(card('运行状态', null, h('div', { class: 'grid' },
    h('div', {}, h('div', { class: 'kv' }, h('span', { text: 'NapCat' }), h('span', { class: 'mono', text: me?.effectiveWsUrl ?? state.overview.napcat.wsUrl })),
      h('div', { class: 'kv' }, h('span', { text: '连接' }), h('span', { class: me?.connected ? 'pill ok' : 'pill bad', text: me?.connected ? '已连接' : '未连接' })),
      h('div', { class: 'kv' }, h('span', { text: '登录号' }), h('span', { class: 'mono', text: me?.selfId ?? '—' }))),
    h('div', {}, h('div', { class: 'kv' }, h('span', { text: '今日调用' }), h('span', { text: u.calls ?? 0 })),
      h('div', { class: 'kv' }, h('span', { text: '缓存命中率' }), h('span', { text: ((u.hitRate ?? 0) * 100).toFixed(1) + '%' })),
      h('div', { class: 'kv' }, h('span', { text: '今日花费' }), h('span', { text: '¥' + (u.cost?.spent ?? 0).toFixed(4) }))),
    h('div', {}, h('div', { class: 'kv' }, h('span', { text: '输入 token' }), h('span', { text: (u.prompt ?? 0).toLocaleString() })),
      h('div', { class: 'kv' }, h('span', { text: '其中命中' }), h('span', { text: (u.cacheHit ?? 0).toLocaleString() })),
      h('div', { class: 'kv' }, h('span', { text: '缓存省下' }), h('span', { text: '¥' + (u.cost?.saved ?? 0).toFixed(4) }))))));

  // 机器人管理：增删改 + 每个号自己的 NapCat 地址
  const addName = h('input', { type: 'text', placeholder: '名字（自己区分用）', style: 'width:150px' });
  const addQq = h('input', { type: 'text', placeholder: 'QQ 号', style: 'width:120px' });
  const addWs = h('input', { type: 'text', placeholder: 'NapCat 地址（可留空）', style: 'width:200px' });
  const addBtn = b('添加机器人', async (ev) => {
    const name = addName.value.trim();
    if (!name) return toast('名字要填', true);
    ev.target.disabled = true;
    try {
      const r = await api('/api/bots', { name, qq: addQq.value.trim(), napcatWsUrl: addWs.value.trim() });
      toast('已添加。记得去「扫码登录」页给它登录');
      state.botId = r.id;
      setSavedBotId(state.botId);
      render();
    } catch (e) {
      toast('添加失败：' + e.message, true);
      ev.target.disabled = false;
    }
  }, 'primary');

  const botRow = (x) => {
    const ws = h('input', { type: 'text', value: x.napcatWsUrl ?? '', placeholder: x.effectiveWsUrl ?? '用全局设置', style: 'width:190px' });
    ws.addEventListener('change', async () => {
      await api(`/api/bots/${x.id}/settings`, { patch: { napcatWsUrl: ws.value.trim() } });
      toast('已保存，正在重连');
      await api(`/api/bots/${x.id}/restart`, {});
      render();
    });
    return h('tr', {},
      h('td', {}, h('div', { text: x.name }), h('div', { class: 'muted mono', style: 'font-size:12px', text: '#' + x.id })),
      h('td', { class: 'mono', text: x.qq ?? '—' }),
      h('td', {}, h('span', {
        class: x.connected ? 'pill ok' : (x.running ? 'pill warn' : 'pill'),
        text: x.connected ? '已连接' : (x.running ? '连接中' : '未运行'),
      })),
      h('td', {}, ws),
      h('td', { class: 'mono', text: x.apiKeyMasked || '—' }),
      h('td', {},
        b('重启', async () => { await api(`/api/bots/${x.id}/restart`, {}); toast('已重连'); render(); }, 'sm'),
        ' ',
        b('删除', async () => {
          if (!confirm(`删除「${x.name}」？\n它的记忆、名单、风格卡都会一起删掉，不可恢复。`)) return;
          const r = await fetch(`/api/bots/${x.id}`, { method: 'DELETE' });
          if (r.ok) {
            toast('已删除');
            state.botId = null;
            setSavedBotId(null);
            // 立刻重取列表：否则被删的那个还留在下拉里，且要等下一次自动刷新
            // 才会落到别的机器人上
            await refreshBots();
            render();
          }
          else toast('删除失败', true);
        }, 'sm danger')));
  };

  out.push(card('机器人', '每个机器人可以有自己的 NapCat 地址——一个 NapCat 只对应一个 QQ 号，两个号共用同一个地址会互相抢连接。',
    h('table', {},
      h('thead', {}, h('tr', {},
        h('th', { text: '名字' }), h('th', { text: 'QQ' }), h('th', { text: '状态' }),
        h('th', { text: 'NapCat 地址' }), h('th', { text: '密钥' }), h('th', { text: '操作' }))),
      h('tbody', {}, ...state.bots.map(botRow))),
    h('div', { class: 'row', style: 'margin-top:14px;padding-top:12px;border-top:1px solid var(--line)' },
      addName, addQq, addWs, addBtn),
    h('p', { class: 'hint', text: `新加的机器人还需要单独跑一个 NapCat 实例：在 ${dirPath('toolsDir', '.tools')} 下复制一份与 qq-bot-data 不同的目录，用不同的 ws 端口启动，再把上面的地址填成对应的端口。` })));

  // 从另一个机器人复制配置（有两个以上机器人才有意义）
  if (state.bots.length >= 2) {
    const parts = await api('/api/copyable').catch(() => []);
    const fromSel = h('select', { style: 'width:160px' }, ...state.bots.map((x) => h('option', { value: x.id, text: x.name })));
    const toSel = h('select', { style: 'width:160px' }, ...state.bots.map((x) => h('option', { value: x.id, text: x.name })));
    // 默认：源 = 第一个，目标 = 当前选中的那个
    fromSel.value = state.bots[0].id;
    toSel.value = state.botId ?? state.bots[1].id;

    const boxes = parts.map((p) => {
      const cb = h('input', { type: 'checkbox', checked: p.key !== 'api' });
      return { key: p.key, cb, label: p.label, desc: p.desc };
    });

    out.push(card('从另一个机器人复制配置', '时段、名单、兜底话术这些每个号都要配一遍太烦。注意：记忆、印象、风格卡和密钥不会被复制——那是两个号各自的东西。',
      h('div', { class: 'row' },
        h('span', { class: 'muted', text: '从' }), fromSel,
        h('span', { class: 'muted', text: '复制到' }), toSel),
      h('div', { style: 'margin-top:12px' },
        ...boxes.map((b) => h('label', { class: 'inline', style: 'display:block;margin:4px 0' },
          b.cb,
          h('span', { text: ' ' + b.label }),
          h('span', { class: 'muted', style: 'font-size:12px', text: '　' + b.desc })))),
      h('div', { class: 'row', style: 'margin-top:12px' },
        b('开始复制', async (ev) => {
          const chosen = boxes.filter((x) => x.cb.checked).map((x) => x.key);
          if (!chosen.length) return toast('至少选一项', true);
          if (String(fromSel.value) === String(toSel.value)) return toast('源和目标不能是同一个', true);
          const target = state.bots.find((x) => String(x.id) === String(toSel.value));
          if (!confirm(`把配置复制到「${target?.name}」？\n目标机器人原有的对应配置会被覆盖。`)) return;
          ev.target.disabled = true;
          try {
            const r = await api(`/api/bots/${toSel.value}/copy-from`, {
              fromBotId: Number(fromSel.value), parts: chosen,
            });
            toast(`已复制 ${r.copied.length} 项`);
            await api(`/api/bots/${toSel.value}/restart`, {});
            render();
          } catch (e) {
            toast('复制失败：' + e.message, true);
            ev.target.disabled = false;
          }
        }, 'primary'),
        h('span', { class: 'muted', text: '复制后会自动重连目标机器人' }))));
  }

  return out;
};

// ---------- 扫码登录 ----------
RENDERERS.login = async () => {
  const me = state.bots.find((x) => x.id === state.botId);
  const root = h('div', {});

  if (me?.connected) {
    root.append(card('已登录', null,
      h('div', { class: 'row' },
        h('span', { class: 'pill ok', text: '连接正常' }),
        h('span', { class: 'muted', text: `登录号 ${me.selfId ?? '—'}　QQ ${me.qq ?? '—'}` }))));
    return root;
  }

  root.append(h('div', { class: 'note' },
    'QQ 登录二维码大约两分钟就会过期。过期后本页会自动拉取新的，直接扫最新的那张即可。'));

  const img = h('img', { style: 'width:260px;height:260px;display:block;border:1px solid var(--line);border-radius:8px;background:#fff' });
  const statusLine = h('div', { class: 'hint', text: '正在读取二维码…' });
  const napcatDir = me?.napcatDir || 'napcat';

  const load = async () => {
    try {
      img.src = `${API()}/qrcode?t=` + Date.now();
    } catch { /* 忽略 */ }
    try {
      const info = await api(`${API()}/qrcode-info`);
      statusLine.textContent = info.exists ? `二维码生成于 ${info.ageSec} 秒前` : '还没有二维码';
    } catch { statusLine.textContent = '还没有二维码'; }
  };
  img.addEventListener('error', () => {
    img.removeAttribute('src');
    img.style.display = 'none';
    statusLine.textContent = `还没有二维码。先在命令行启动这个号对应的 NapCat：\nscripts\\napcat-start.cmd ${napcatDir} ${me?.qq ?? '<QQ号>'} ${napcatDir === 'napcat' ? 'qq-bot-data' : napcatDir.replace('napcat', 'qq-bot') + '-data'}`;
  });
  img.addEventListener('load', () => { img.style.display = 'block'; });

  root.append(card('用手机 QQ 扫码登录机器人小号',
    '用手机 QQ 登录你要当机器人的那个号（不是你的常用号），扫下面这张。',
    h('div', { class: 'row', style: 'align-items:flex-start;gap:24px' },
      h('div', {}, img, h('div', { style: 'margin-top:8px' }, b('刷新二维码', load, 'sm'))),
      h('div', { style: 'flex:1;min-width:220px' },
        h('div', { class: 'kv' }, h('span', { text: '机器人名字' }), h('span', { text: me?.name ?? '—' })),
        h('div', { class: 'kv' }, h('span', { text: '机器人 QQ' }), h('span', { text: me?.qq ?? '（未填）' })),
        h('div', { class: 'kv' }, h('span', { text: '连接状态' }), h('span', { class: me?.running ? 'pill warn' : 'pill', text: me?.running ? '已启动，等待登录' : '未启动' })),
        h('div', { style: 'margin-top:10px' }, statusLine),
        h('p', { class: 'hint', text: '登录成功后自动跳转，不需要手动刷新页面。' })))));

  // 每 25 秒自动换一张新码（QQ 的码两分钟过期）
  const timer = setInterval(async () => {
    if (state.section !== 'login') { clearInterval(timer); return; }
    try {
      const info = await api(`${API()}/qrcode-info`);
      if (!info.exists) return;
      if (info.ageSec > 100) { await load(); }
      else statusLine.textContent = `二维码生成于 ${info.ageSec} 秒前`;
    } catch { /* 忽略 */ }
    // 顺带看看登没登上
    try {
      const ov = await api('/api/overview');
      const cur = ov.bots.find((x) => x.id === state.botId);
      if (cur?.connected) { clearInterval(timer); toast('登录成功'); render(); }
    } catch { /* 忽略 */ }
  }, 25000);
  setTimeout(() => clearInterval(timer), 10 * 60 * 1000);

  await load();
  return root;
};

// ---------- 接入与密钥 ----------
RENDERERS.access = async () => {
  if (!state.botId) return card('', '先创建机器人');
  const { settings } = await api(`${API()}/settings`);
  const me = state.bots.find((x) => x.id === state.botId);

  const save = async (patch) => { await api(`${API()}/settings`, { patch }); toast('已保存'); render(); };

  const modeSel = h('select', {}, ...[['auto', '按时段自动'], ['force_on', '强制开启'], ['force_off', '强制关闭']]
    .map(([v, t]) => h('option', { value: v, text: t, selected: settings.api.mode === v })));
  modeSel.addEventListener('change', () => save({ api: { mode: modeSel.value } }));

  const effortSel = h('select', {}, ...[['auto', '自动（聊天低、提炼高）'], ['low', '全用低'], ['high', '全用高']]
    .map(([v, t]) => h('option', { value: v, text: t, selected: settings.api.effortMode === v })));
  effortSel.addEventListener('change', () => save({ api: { effortMode: effortSel.value } }));

  const keyInput = h('input', { type: 'password', placeholder: me?.hasApiKey ? '已设置（只能重置后修改）' : '填写 API Key' });
  const doSet = async () => {
    const k = keyInput.value.trim();
    if (!k) return toast('请填写密钥', true);
    await api(`${API()}/key`, { key: k });
    keyInput.value = '';
    toast('已保存');
    render();
  };
  const doReset = async () => {
    if (!confirm('确定重置密钥？重置后才能重新填写。')) return;
    await api(`${API()}/key/reset`, {});
    toast('已重置');
    render();
  };

  const root = h('div', {});

  if (!me?.hasApiKey) root.append(h('div', { class: 'note', text: '还没有配置 API 密钥，机器人无法接入模型。' }));

  root.append(card('模型接入', '密钥存储经系统加密（DPAPI），界面永远只显示掩码。',
    h('div', { class: 'row' }, field('接入方式', modeSel), field('思考档位', effortSel)),
    h('div', { class: 'row', style: 'margin-top:10px' },
      h('div', { class: 'grow' }, keyInput),
      b(me?.hasApiKey ? '重置密钥' : '保存密钥', me?.hasApiKey ? doReset : doSet, 'primary')),
    h('div', { class: 'row', style: 'margin-top:6px' },
      h('span', { class: 'muted mono', text: me?.hasApiKey ? '当前：' + me.apiKeyMasked : '当前：未设置' }))));

  root.append(card('识别开关', '控制图片与语音是否送去识别，直接关系到花费。',
    h('div', { class: 'row' },
      toggle('识别图片', settings.api.vision.enabled, (v) => save({ api: { vision: { enabled: v } } })),
      toggle('识别语音条', settings.api.voiceAsr.enabled, (v) => save({ api: { voiceAsr: { enabled: v } } }))),
    h('div', { class: 'row', style: 'margin-top:8px' },
      field('图片档位', (() => {
        const s = h('select', {}, ...[['auto', 'auto（认字时自动用高清）'], ['low', 'low（始终省）'], ['high', 'high（始终清晰）']]
          .map(([v, t]) => h('option', { value: v, text: t, selected: settings.api.vision.detail === v })));
        s.addEventListener('change', () => save({ api: { vision: { detail: s.value } } }));
        return s;
      })()),
      field('每小时识别上限', numInput(settings.api.vision.perHourLimit, (v) => save({ api: { vision: { perHourLimit: v } } }))))));

  // 联网搜索：开着才把搜索工具交给模型，由它自己决定要不要查
  const sst = await api('/api/search/status').catch(() => null);
  const providers = sst?.providers ?? {};
  const curProvider = settings.api.search?.provider ?? 'bing';
  const curInfo = providers[curProvider] ?? {};
  const providerSel = h('select', {}, ...Object.entries(providers).map(([k, v]) =>
    h('option', { value: k, text: v.label, selected: curProvider === k })));
  providerSel.addEventListener('change', () => save({ api: { search: { provider: providerSel.value } } }));
  const searchKeyInput = h('input', { type: 'password', placeholder: sst?.hasKey ? '已设置（只能重置后修改）' : '博查的密钥（必应不需要）' });
  root.append(card('联网搜索',
    '开着的时候模型能自己决定「联网查一下」：它觉得知识不够新、或者根本不知道时才会查，闲聊和常识不会。每次搜索是一次额外的接口调用（照样计入花费统计），所以有每小时的次数上限兜底。默认用必应，不用注册也不用密钥；想要结果更全可以换成博查，那家要密钥。',
    h('div', { class: 'row' },
      toggle('允许它联网查资料', settings.api.search?.enabled === true, (v) => save({ api: { search: { enabled: v } } })),
      field('搜索源', providerSel),
      field('每小时最多搜几次', numInput(settings.api.search?.perHourLimit ?? 30, (v) => save({ api: { search: { perHourLimit: v } } }))),
      field('一次取几条结果', numInput(settings.api.search?.count ?? 5, (v) => save({ api: { search: { count: v } } })))),
    h('div', { class: 'row', style: 'margin-top:10px' },
      h('div', { class: 'grow' }, searchKeyInput),
      b(sst?.hasKey ? '重置密钥' : '保存密钥', async () => {
        if (sst?.hasKey) {
          if (!confirm('确定重置搜索密钥？')) return;
          await api('/api/search/key/reset', {});
        } else {
          const k = searchKeyInput.value.trim();
          if (!k) return toast('请填写搜索密钥', true);
          await api('/api/search/key', { key: k });
          searchKeyInput.value = '';
        }
        toast('已保存');
        render();
      }, 'primary')),
    h('div', { class: 'row', style: 'margin-top:6px' },
      h('span', { class: 'muted mono', text: sst?.hasKey ? '博查密钥：' + sst.maskedKey : '博查密钥：未设置' })),
    h('p', { class: 'hint', text: `当前搜索源：${curInfo.label ?? curProvider} —— ${curInfo.quota ?? ''}${curInfo.applyUrl ? `（到 ${curInfo.applyUrl} 注册）` : ''}。没配密钥也不会卡住：它会直接说查不到，不会瞎编。` })));

  root.append(card('转发里的图片',
    '别人转发一段聊天记录进来时，里面的图可以一起送去识别，这样机器人才答得上「这段记录里说了啥」。转发里动辄十几二十张图，全读一次要上万 token，所以按张数封顶；不足这个数就全部读完。填 0 表示不看转发里的图。',
    h('div', { class: 'row' },
      field('最多读几张',
        numInput(settings.api.vision.forwardMaxImages ?? 8,
          (v) => save({ api: { vision: { forwardMaxImages: v } } }))))));

  // 语音识别服务状态
  const st = await api('/api/asr/status').catch(() => null);
  const asrBox = h('div', {});
  const drawAsr = (probe) => {
    asrBox.replaceChildren(
      h('div', { class: 'row' },
        h('span', { class: 'muted', text: '服务地址' }),
        h('span', { class: 'mono', text: `${st?.target?.host ?? '127.0.0.1'}:${st?.target?.port ?? 6007}` }),
        probe
          ? h('span', { class: probe.ok ? 'pill ok' : 'pill bad', text: probe.ok ? '在线' : '连不上' })
          : h('span', { class: 'pill', text: '未探测' }),
        b('探测', async (ev) => {
          ev.target.disabled = true;
          ev.target.textContent = '探测中…';
          const r = await api('/api/asr/probe', {});
          toast(r.ok ? '识别服务在线' : '连不上：' + r.error, !r.ok);
          drawAsr(r);
        })),
      probe && !probe.ok
        ? h('p', { class: 'hint', text: '连不上时的处理：去「运行」页点一下「启动」（或双击 scripts\\asr-server.cmd）。它没启动时，语音条会走「默认回复」里的语音兜底。' })
        : h('p', { class: 'hint', text: '识别服务是常驻的，模型只加载一次。没启动时语音条会走兜底回复，其他功能不受影响。' }));
  };
  drawAsr(st?.lastProbe ?? null);
  root.append(card('语音识别服务', '跑在本地，开关在「运行」页。', asrBox));

  root.append(card('NapCat 连接', '机器人通过它收发 QQ 消息。默认 ws://127.0.0.1:3001。',
    (() => {
      const i = h('input', { type: 'text', value: state.overview.napcat.wsUrl });
      const btn = b('保存并重连', async () => {
        await api('/api/global', { patch: { napcat: { wsUrl: i.value.trim() } } });
        await api(`${API()}/restart`, {});
        toast('已保存并重连');
        render();
      }, 'primary');
      return h('div', { class: 'row' }, h('div', { class: 'grow' }, i), btn);
    })()));

  root.append(card('NapCat 启动参数',
    '一个 NapCat 实例只服务一个 QQ 号，所以两个号必须各有各的目录和数据目录，共用会让 QQ 互相顶下线。「运行」页点启动时用这两个值，填错了 QQ 会当成新设备、要重新扫码。',
    h('div', { class: 'row' },
      field('NapCat 目录（模型目录下）', (() => {
        const i = h('input', { type: 'text', value: settings.napcatDir || 'napcat' });
        return h('div', { class: 'row' }, h('div', { class: 'grow' }, i),
          b('保存', () => save({ napcatDir: i.value.trim() })));
      })()),
      field('QQ 数据目录', (() => {
        const i = h('input', { type: 'text', value: settings.napcatDataDir || 'qq-bot-data' });
        return h('div', { class: 'row' }, h('div', { class: 'grow' }, i),
          b('保存', () => save({ napcatDataDir: i.value.trim() })));
      })()))));

  return root;
};

const toggle = (label, checked, on) => {
  const i = h('input', { type: 'checkbox', checked });
  i.addEventListener('change', () => on(i.checked));
  return h('label', { class: 'inline' }, i, h('span', { text: label }));
};
const numInput = (value, on, style = 'width:90px') => {
  const i = h('input', { type: 'number', value, style });
  i.addEventListener('change', () => on(Number(i.value)));
  return i;
};

// ---------- 运行 ----------
// 「位置」卡片保存后的提示。不能直接写进卡片里的节点 —— render() 会重建整张卡，
// 写上去的元素就没了（pickup 页踩过一次）。
let pathsNote = '';
RENDERERS.runtime = async () => {
  const st = await api('/api/system');
  const root = h('div', {});

  // 动作按钮：点完先禁用，过一两秒自动刷新一次状态
  const act = (key, action, label, kind) => b(label, async (ev) => {
    const t = ev.target;
    t.disabled = true;
    const old = t.textContent;
    t.textContent = '执行中…';
    try {
      const r = await api(`/api/system/${encodeURIComponent(key)}/${action}`, {});
      toast(r.note || '完成');
    } catch (e) {
      toast(String(e.message), true);
    }
    t.textContent = old;
    t.disabled = false;
    setTimeout(() => render(), 1500);
  }, kind);

  root.append(card('机器人本体',
    '就是正在给你发这个页面的进程。「停止」之后这个页面会断开，要重新拉起来得去电脑上双击 scripts\\start-all.cmd（手机上是 bash start-bot.sh）——页面本身是它发的，它停了就没有页面可点了。',
    h('div', { class: 'row' },
      h('span', { class: 'pill ok', text: '在跑' }),
      h('span', { class: 'muted mono', text: `pid ${st.bot.pid} · 已运行 ${Math.floor(st.bot.uptimeSec / 60)} 分钟` }),
      act('bot', 'restart', '重启', 'primary'),
      act('bot', 'stop', '停止'))));

  for (const n of st.napcat) {
    root.append(card(n.label,
      n.running
        ? '在跑。QQ 卡住或掉线时点「重启」最省事：重新起来后 QQ 会用已保存的登录态自动登录。'
        : '没在跑。点「启动」会把它拉起来，QQ 会自动登录；万一它要重新扫码，去「扫码登录」页。',
      h('div', { class: 'row' },
        h('span', { class: n.running ? 'pill ok' : 'pill bad', text: n.running ? '在线' : '离线' }),
        h('span', { class: 'muted mono', text: n.port ? `端口 ${n.port}` : '没配 ws 地址' }),
        act(n.key, 'start', '启动'),
        act(n.key, 'restart', '重启', 'primary'),
        act(n.key, 'stop', '停止'))));
  }

  root.append(card('语音识别服务',
    st.asr.installed
      ? '常驻的本地识别服务，模型只加载一次。停了之后语音条会走「默认回复」里的语音兜底，其他功能不受影响。'
      : `这台机器上没找到识别程序或模型（${dirPath('toolsDir', '.tools')}\\sherpa、model-sense-voice），所以只能停不能启。`,
    h('div', { class: 'row' },
      h('span', { class: st.asr.running ? 'pill ok' : 'pill bad', text: st.asr.running ? '在线' : '离线' }),
      h('span', { class: 'muted mono', text: `端口 ${st.asr.port}` }),
      st.asr.installed ? act('asr', 'start', '启动') : h('span', {}),
      act('asr', 'restart', '重启', 'primary'),
      act('asr', 'stop', '停止'))));

  // ---- 位置：模型 / 数据 / 素材放哪（可自定义，默认都在项目目录里）----
  const pinfo = await api('/api/paths');
  PATHS = pinfo;
  const inputs = {};
  const tagOf = (d) => (d.fromEnv ? h('span', { class: 'pill', text: '环境变量优先' })
    : d.custom ? h('span', { class: 'pill', text: '自定义' })
      : h('span', { class: 'pill', text: '默认' }));
  const pathRow = (d, hintText) => {
    // 显示的是「配置里写的值」（保存后就变），不是「这进程正在用的值」——
    // 两者不一样时挂一个「待重启生效」，不说清的话用户会以为保存没成功。
    const input = h('input', {
      type: 'text', value: d.configured, class: 'mono', style: 'flex:1;min-width:42ch',
      'data-pathkey': d.key,   // 浏览器自动化按它定位（role/name 匹配这类控件不稳）
    });
    inputs[d.key] = input;
    return h('div', { class: 'row', style: 'margin:6px 0' },
      h('span', { class: 'muted', style: 'width:9ch', text: d.label }),
      input, tagOf(d),
      b('恢复默认', () => { input.value = d.def; }, '', { 'data-act': 'reset', 'data-pathkey': d.key }),
      d.pending ? h('span', { class: 'pill', style: 'background:#b45309', text: '待重启生效' }) : null,
      hintText ? h('span', { class: 'muted', text: hintText }) : null);
  };
  const rows = pinfo.dirs.map((d) => pathRow(d, d.exists ? '' : '（还没建出来）'));
  rows.push(pathRow(pinfo.qqExe, 'Windows 上 NapCat 借它启动'));

  const savePathsBtn = b('保存', async (ev) => {
    const t = ev.target;
    t.disabled = true;
    // 与默认值相同的项提交空串 = 从 paths.json 里删掉它。
    // 否则点一次保存就把五个默认值全写进文件，界面上每一行都会变成「自定义」，
    // 用户根本看不出自己改过哪一项（2026-10-13 实测踩到）。
    const body = {};
    for (const d of pinfo.dirs) {
      const v = inputs[d.key].value.trim();
      body[d.key] = v === d.def ? '' : v;
    }
    const qv = inputs.qqExe.value.trim();
    body.qqExe = qv === pinfo.qqExe.def ? '' : qv;
    try {
      PATHS = await api('/api/paths', body);
      pathsNote = '已写入 paths.json。要让程序整个重启才生效（上面「机器人本体」的重启就是干这个的）；'
        + '换位置不会自动搬数据，旧目录里的文件要自己拷过去。';
      toast('已保存');
    } catch (e) {
      toast(String(e.message), true);
    }
    t.disabled = false;
    render();
  }, 'primary', { 'data-act': 'save-paths' });

  root.append(card('位置（模型 / 数据 / 素材放哪）',
    '默认都在项目目录里。模型想放到别的盘、素材想跟着云盘走，就在这里改：留空 = 用默认。'
    + '改完要整个重启程序才生效；子目录（音色、识别模型、NapCat 等）都跟着下面的根目录走。',
    ...rows,
    h('div', { class: 'row' }, savePathsBtn),
    pathsNote ? h('p', { class: 'hint', style: 'color:#b45309', text: pathsNote }) : null,
    h('p', { class: 'hint', text: '跟着自动变的：' + pinfo.derived.map((x) => `${x.label} → ${x.value}`).join('　') }),
    h('p', { class: 'hint mono', text: 'paths.json：' + pinfo.file })));

  root.append(h('p', { class: 'hint', text: st.restartHint }));
  return root;
};

// ---------- 音色 ----------
// 造音色之后要说的话。不能直接往卡片里的元素上写 —— render() 会把整张卡重建，
// 写上去的元素就丢了（踩过一次：提示写了但看不见）。所以记在这里、渲染时带出来。
let forgeNote = '';
RENDERERS.voices = async () => {
  const data = await api('/api/voices');
  const root = h('div', {});

  root.append(h('div', { class: 'note' },
    '音色是共享的：多个机器人可以引用同一个音色，改一次全都变。'
    + '现在有三套引擎，**选音色就等于选引擎**：带 rvc: 前缀的是变声（先用标准音色把字念标准、'
    + '再换成目标音色，变声服务'
    + (data.rvc?.ok ? `已就绪，运算在 ${data.rvc.device ?? '?'}` : '**没在跑**，这类音色会退回声源音色')
    + '）；带 cosy: 前缀的走 CosyVoice2（常驻服务，'
    + (data.cosy?.ok ? '已就绪' : '**没在跑**，这类音色会退回文字')
    + '）；其余的走老的 sherpa 程序。新增音色在页面下方。'));

  const engineLabel = {
    rvc: '变声·RVC', cosyvoice: 'CosyVoice2', zipvoice: '旧·ZipVoice 克隆', vits: '旧·固定音色',
  };
  for (const v of data.voices ?? []) {
    const isZip = v.kind === 'zipvoice';
    const isCosy = v.kind === 'cosyvoice';
    const isRvc = v.kind === 'rvc';
    const input = h('input', { type: 'text', placeholder: '试听这句话（克隆音色建议短句）' });
    const audio = h('audio', { controls: true, style: 'margin-top:8px;height:32px' });
    const qualitySel = h('select', {}, ...[['normal', '默认（约 10 秒）'], ['high', '高质量（更自然，约 30 秒）']]
      .map(([k, t]) => h('option', { value: k, text: t })));
    // 句间停顿：vits 音色的停顿是烧在模型里的，只能按标点切开逐句合成、中间自己补静音
    const pauseIn = h('input', { type: 'number', value: 0, step: 50, min: 0, max: 1500, style: 'width:90px' });
    // 新引擎的语速是原生参数（1 最快慢由它定，0.9 就是慢一点）
    const speedIn = h('input', { type: 'number', value: 1, step: 0.05, min: 0.5, max: 1.5, style: 'width:80px' });
    const say = b('试听', async (ev) => {
      const btn = ev.target;
      btn.disabled = true;
      btn.textContent = '合成中…';
      try {
        const res = await fetch(`/api/voices/${encodeURIComponent(v.id)}/say`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-AgentXiang': '1' },
          body: JSON.stringify({
            text: input.value.trim() || '这是一段试听。',
            quality: qualitySel.value,
            pauseMs: Number(pauseIn.value) || 0,
            speed: Number(speedIn.value) || 0,
          }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || ('HTTP ' + res.status));
        }
        const url = URL.createObjectURL(await res.blob());
        audio.src = url;
        audio.play().catch(() => { /* 浏览器不允许自动播就手动点 */ });
      } catch (e) {
        toast(String(e.message).slice(0, 80), true);
      }
      btn.disabled = false;
      btn.textContent = '试听';
    }, 'primary');

    // 变声参数：音高（半音）、索引比例（越像越糊）、声源（先由谁把字念标准）
    const pitchIn = h('input', { type: 'number', value: v.pitch ?? 0, step: 1, min: -24, max: 24, style: 'width:70px' });
    const rateIn = h('input', { type: 'number', value: v.indexRate ?? 0.5, step: 0.05, min: 0, max: 1, style: 'width:80px' });
    const srcSel = h('select', {}, ...(data.rvcSources ?? []).map((id) => h('option', { value: id, text: id })));
    if (v.sourceVoice) srcSel.value = v.sourceVoice;
    const saveMeta = b('存参数', async (ev) => {
      const btn = ev.target;
      btn.disabled = true;
      try {
        const r = await fetch(`/api/voices/${encodeURIComponent(v.id)}/meta`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-AgentXiang': '1' },
          body: JSON.stringify({ pitch: Number(pitchIn.value), indexRate: Number(rateIn.value), sourceVoice: srcSel.value }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        toast('存好了，再点「试听」听听效果');
      } catch (e) {
        toast(String(e.message).slice(0, 80), true);
      }
      btn.disabled = false;
      render();
    });

    const row = isRvc
      ? h('div', {}, h('div', { class: 'row' }, h('div', { class: 'grow' }, input), say),
        h('div', { class: 'row', style: 'margin-top:6px' },
          field('音高(半音)', pitchIn), field('索引比例', rateIn), field('声源', srcSel), saveMeta))
      : isCosy
        ? h('div', { class: 'row' }, h('div', { class: 'grow' }, input), field('语速', speedIn), say)
        : h('div', { class: 'row' }, h('div', { class: 'grow' }, input), qualitySel, field('停顿(毫秒)', pauseIn), say);

    const sizeText = isRvc
      ? `模型 ${v.modelMB}MB${v.indexMB ? ` + 索引 ${v.indexMB}MB` : ''}`
      : isCosy ? `${v.seconds ? v.seconds + ' 秒参考' : ''}` : `${v.sizeMB}MB`;
    const hint = isRvc
      ? `变声：先用 ${v.sourceVoice} 把字念标准，再换成「${v.label || v.name}」的音色（只换音色、不换读音）。`
        + `音高 0 是原调，女声换女声一般不用动；听着闷就往上加 2~4。${v.note ? '　' + v.note : ''}`
      : isCosy
        ? `参考文字：${String(v.refText ?? '').slice(0, 40)}${String(v.refText ?? '').length > 40 ? '…' : ''}`
        : (isZip ? '零样本克隆：它的音色来自目录里的参考录音 + 参考原文，两者必须严格对应。' : '固定音色模型。');

    root.append(card(`${v.id}${v.kind === 'rvc' && v.label ? `（${v.label}）` : ''}　${engineLabel[v.kind] ?? v.kind}　${sizeText}`, hint, row, audio));
  }

  // ---- 新增音色（放一段音频自动生成）----
  // 浏览器拿不到本机文件，所以这里跟「手动加语料」一样走路径 + 文件名，不做上传。
  const nameIn = h('input', { type: 'text', placeholder: '英文名，如 tomori（中文当目录名会让合成静默失败）' });
  const engineSel = h('select', {}, ...[
    ['cosyvoice', 'CosyVoice2（推荐：只要音频+文字，几秒登记完）'],
    ['rvc', '变声 RVC（要现成的 .pth 模型，不是登记音频）'],
    ['zipvoice', '旧引擎 ZipVoice 克隆'],
  ].map(([k, t]) => h('option', { value: k, text: t })));
  const modeSel = h('select', {}, ...[
    ['audio', '从参考音频生成'],
    ['voice', '从已有音色复制（仅旧引擎）'],
  ].map(([k, t]) => h('option', { value: k, text: t })));
  const audioIn = h('input', { type: 'text', value: 'style-samples/audio/p10.m4a' });
  // 默认给的就是小向那个参考段的窗口（对齐后 280.382 起 12.3 秒），直接点「生成」就能用；
  // 起始秒填 0 太靠前（p10 开头两句只有不到 1 秒，会被守卫挡下）
  const startIn = h('input', { type: 'number', value: 280.382, step: 0.001, style: 'width:110px' });
  const durIn = h('input', { type: 'number', value: data.refLimits?.def ?? 14, step: 0.1, style: 'width:90px' });
  const textIn = h('textarea', { rows: 3, placeholder: '参考文字：必须与录音逐字对应（**转录是机器生成的，很可能有错字，务必对着录音核一遍**）。留空则自动从 style-samples/transcript/<同名>.tsv 里按时间窗截' });
  const fromSel = h('select', {}, ...(data.voices ?? []).filter((v) => v.kind === 'zipvoice')
    .map((v) => h('option', { value: v.id, text: v.id })));
  const out = h('div', { class: 'hint' });
  const audioRow = h('div', {}, field('参考音频', audioIn),
    h('div', { class: 'row' }, field('起始秒', startIn), field('时长秒', durIn)));
  const copyRow = h('div', {}, field('复制自', fromSel));
  const syncMode = () => {
    const isAudio = modeSel.value === 'audio';
    audioRow.style.display = isAudio ? '' : 'none';
    copyRow.style.display = isAudio ? 'none' : '';
    textIn.style.display = isAudio ? '' : 'none';
  };
  modeSel.addEventListener('change', syncMode);
  syncMode();

  root.append(card('新增音色（放一段音频自动生成）',
    '新引擎（CosyVoice2）只要两样：**一段 10~20 秒的干净人声**（整段文件或截取一段）+ **与它逐字对应的文字**，'
    + '登记进去几秒钟就好，不用复制模型、不占额外磁盘。旧引擎（ZipVoice）还要复制 176MB 模型文件，慢，而且开头有怪音。'
    + '参考文字一个字错了就会念糊（自动核对挡不住这种错），所以务必人工对着录音核一遍。',
    h('div', { class: 'row' }, h('div', { class: 'grow' }, field('音色名', nameIn)), field('引擎', engineSel), field('来源', modeSel)),
    audioRow, textIn, copyRow,
    h('div', { class: 'row' },
      b('看一眼会用哪段文字', async () => {
        try {
          const r = await api('/api/voices/ref-text', { audioPath: audioIn.value.trim(), startSec: Number(startIn.value), durSec: Number(durIn.value) });
          out.textContent = r.found
            ? `转录 ${r.file}：对齐到 ${r.willUse.startSec} 秒起 ${r.willUse.durSec} 秒，共 ${r.rows} 行 → 「${r.text}」`
            : `没找到同名转录（${r.file}），选「从已有音色复制」，或在下面手填参考文字`;
        } catch (e) { out.textContent = String(e.message).slice(0, 120); }
      }),
      b('生成音色', async (ev) => {
        const btn = ev.target;
        btn.disabled = true;
        btn.textContent = '生成中…';
        try {
          // 变声音色不是「登记一段音频」造出来的，它要现成的 RVC 模型，所以这里只报怎么放
          if (engineSel.value === 'rvc') {
            out.textContent = `变声 RVC 音色要现成的模型文件（不是登记音频）：在 ${dirPath('toolsDir', '.tools')}\\rvc-voices\\ 下建一个目录`
              + '（名字只能小写字母数字下划线短横线，例如 tomori），把模型存成 model.pth、索引存成 model.index，'
              + '再放一个 voice.json 写 {label, pitch, sourceVoice}。放好后刷新本页就会出现这张卡片。';
            btn.disabled = false;
            btn.textContent = '生成音色';
            return;
          }
          const body = modeSel.value === 'audio'
            ? {
                engine: engineSel.value,
                name: nameIn.value.trim(),
                audioPath: audioIn.value.trim(),
                startSec: Number(startIn.value),
                durSec: Number(durIn.value),
                text: textIn.value.trim(),
              }
            : { name: nameIn.value.trim(), fromVoice: fromSel.value };
          const r = await api('/api/voices', body);
          toast(`音色 ${r.id} 造好了`);
          // 核对结果要显出来：文字与录音对不上就会克隆出「糊」的声音，而文件、命令都不报错
          if (r.refCheck?.level === 'warn') {
            forgeNote = `造好了，但参考文字要人工核一遍：自动核对只有 ${r.refCheck.similarity} 相似度，`
              + `识别回读是「${String(r.refCheck.heard ?? '').slice(0, 40)}」。错一个字就会糊，建议照着录音逐字改。`;
          } else if (r.refCheck?.level === 'skipped') {
            forgeNote = `造好了。没能自动核对参考文字（${r.refCheck.why}），请自己对着录音核一遍。`;
          } else {
            forgeNote = '';
          }
          await render();
        } catch (e) {
          out.textContent = String(e.message).slice(0, 160);
          toast('没造出来', true);
        }
        btn.disabled = false;
        btn.textContent = '生成音色';
        }, 'primary')),
    out,
    forgeNote ? h('p', { class: 'hint', style: 'color:#b45309', text: forgeNote }) : null));

  root.append(h('p', { class: 'hint', text: `删音色就是删 ${dirPath('toolsDir', '.tools')}\\tts\\<名字>\\ 这个目录（没做按钮，怕误删模板）；在目录里放个 README.txt 说明出处，以后自己看得懂。` }));
  return root;
};

// ---------- 时段 ----------
RENDERERS.schedules = async () => {
  if (!state.botId) return card('', '先创建机器人');
  const data = await api(`${API()}/schedules`);
  const st = data.status;

  const save = async (slots, activeSlot) => {
    await api(`${API()}/schedules`, { slots, activeSlot });
    toast('已保存');
    render();
  };

  const hint = st.active
    ? `当前状态：已接入（${st.reason}）`
    : `当前状态：未接入（${st.reason}）`;

  const root = h('div', {});
  root.append(card('接入状态', hint,
    h('div', { class: 'row' },
      h('span', { class: st.active ? 'pill ok' : 'pill warn', text: st.active ? 'API 已接入' : 'API 未接入' }),
      h('span', { class: 'muted', text: '手动覆盖在「接入与密钥」里设置' }))));

  const slots = data.slots.map((s) => ({ ...s }));
  slots.forEach((slot) => {
    const activeRadio = h('input', { type: 'radio', name: 'activeslot', checked: slot.isActive });
    activeRadio.addEventListener('change', () => save(slots, slot.slotNo));
    const nameInput = h('input', { type: 'text', value: slot.name, style: 'width:120px' });
    nameInput.addEventListener('change', () => save(slots.map((x) => ({ ...x, name: x.slotNo === slot.slotNo ? nameInput.value : x.name })), data.activeSlot));
    const rangesInput = h('textarea', { rows: 3, placeholder: '每行一个区间，如 23:30-03:10（支持跨零点）' , text: '' });
    rangesInput.value = slot.ranges.map((r) => `${fmt(r.start)}-${fmt(r.end)}`).join('\n');
    const saveBtn = b('保存本方案', () => {
      const ranges = rangesInput.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const [a, c] = l.split(/[-~—]/).map((x) => x.trim());
        return { start: a, end: c };
      });
      const bad = ranges.find((r) => !r.start || !r.end);
      if (bad) return toast('区间格式不对，应为 23:30-03:10', true);
      save(slots.map((x) => ({ ...x, ranges: x.slotNo === slot.slotNo ? ranges : x.ranges })), data.activeSlot);
    }, 'primary');

    root.append(card(null, null,
      h('div', { class: 'row' },
        h('label', { class: 'inline' }, activeRadio, h('span', { text: '使用中' })),
        nameInput,
        saveBtn),
      h('div', { style: 'margin-top:8px' }, rangesInput),
      h('p', { class: 'hint', text: '每行一个时间段；跨零点直接写 23:30-03:10。方案切换立即生效。' })));
  });

  root.append(h('p', { class: 'muted', text: '时段之外的时刻，机器人只回「默认回复」里配置的话。' }));
  return root;
};

const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// ---------- 名单 ----------
RENDERERS.lists = async () => {
  if (!state.botId) return card('', '先创建机器人');
  const data = await api(`${API()}/lists`);
  const root = h('div', {});
  root.append(h('div', { class: 'note', text: '安全默认：白名单模式下，不在名单里的人一律不响应。机器人只会响应名单里的人。' }));

  const SCOPE_LABEL = { user: '用户', group: '群' };
  const DIR_LABEL = { accept: '接收', reply: '回复' };

  const save = async (body) => { await api(`${API()}/lists`, body); toast('已保存'); render(); };

  for (const scope of ['user', 'group']) {
    for (const dir of ['accept', 'reply']) {
      const d = data[scope][dir];
      const modeSel = h('select', { style: 'width:130px' }, ...[['whitelist', '白名单'], ['blacklist', '黑名单']]
        .map(([v, t]) => h('option', { value: v, text: t, selected: d.mode === v })));
      modeSel.addEventListener('change', () => save({ scope, direction: dir, mode: modeSel.value }));

      const input = h('input', { type: 'text', placeholder: scope === 'user' ? 'QQ 号' : '群号', style: 'width:160px' });
      const addBtn = b('加入', () => {
        const v = input.value.trim();
        if (!v) return toast('请填写号码', true);
        save({ scope, direction: dir, target: v });
      });

      const list = h('div', { class: 'row', style: 'margin-top:8px' },
        ...(d.targets.length ? d.targets.map((t) => h('span', { class: 'pill' },
          t, ' ', b('×', () => save({ scope, direction: dir, target: t, remove: true }), 'sm')))
          : [h('span', { class: 'muted', text: '（空）' })]));

      root.append(card(`${SCOPE_LABEL[scope]}的${DIR_LABEL[dir]}名单`,
        scope === 'user'
          ? (dir === 'accept' ? '名单外的人，消息直接丢弃，连记录都不留。' : '未配置时跟随「接收」。配置后单独生效。')
          : '群消息要同时过用户和群两套名单。',
        h('div', { class: 'row' }, field('模式', modeSel), input, addBtn),
        list));
    }
  }
  return root;
};

// ---------- 默认回复 ----------
RENDERERS.fallback = async () => {
  if (!state.botId) return card('', '先创建机器人');
  const data = await api(`${API()}/fallback`);
  const root = h('div', {});
  root.append(h('div', { class: 'note', text: '这些是机器人说不出话时的兜底。某个场景下所有条目都禁用，就等于完全静默。' }));

  const save = async (body) => { await api(`${API()}/fallback`, body); toast('已保存'); render(); };

  for (const scene of data.scenesOrder) {
    const s = data.scenes[scene];
    const input = h('input', { type: 'text', placeholder: '新增一条…' });
    root.append(card(s.label, null,
      h('div', { class: 'row' }, h('div', { class: 'grow' }, input),
        b('添加', () => { if (input.value.trim()) save({ scene, text: input.value.trim() }); })),
      h('table', {}, h('tbody', {}, ...s.items.map((it) => h('tr', {},
        h('td', {}, h('label', { class: 'inline' },
          (() => { const i = h('input', { type: 'checkbox', checked: !!it.enabled }); i.addEventListener('change', () => save({ id: it.id, enabled: i.checked })); return i; })(),
          h('span', { text: '' }))),
        h('td', { style: 'width:100%' }, (() => {
          const i = h('input', { type: 'text', value: it.text });
          i.addEventListener('change', () => save({ id: it.id, text: i.value }));
          return i;
        })()),
        h('td', {}, h('label', { class: 'inline' },
          (() => { const i = h('input', { type: 'radio', name: 'fixed-' + scene, checked: !!it.is_fixed }); i.addEventListener('change', () => save({ id: it.id, isFixed: true })); return i; })(),
          h('span', { text: '固定' }))),
        h('td', {}, b('删', () => save({ remove: it.id }), 'sm danger'))))))));
  }

  const cd = h('input', { type: 'number', value: (await api(`${API()}/settings`)).settings.fallback.cooldownSec, style: 'width:90px' });
  cd.addEventListener('change', async () => { await api(`${API()}/settings`, { patch: { fallback: { cooldownSec: Number(cd.value) } } }); toast('已保存'); });
  root.append(card('冷却', '同一个人在这个时间内只会收到一条兜底回复，避免刷屏。',
    h('div', { class: 'row' }, field('冷却秒数', cd))));
  return root;
};

// ---------- 接话 ----------
// 命中触发词就一定接一句。和「复读」的区别：复读是模型自己决定要不要跟，接话是写死的规则。
// 批量结果记在这里而不是卡片里的元素上 —— render() 会把整张卡重建，写上去就看不见了（踩过两次）。
let pickupNote = '';
RENDERERS.pickup = async () => {
  if (!state.botId) return card('', '先创建机器人');
  const data = await api(`${API()}/pickup`);
  const { settings } = await api(`${API()}/settings`);
  const root = h('div', {});

  const save = async (body) => {
    const r = await api(`${API()}/pickup`, body);
    if (r?.skipped?.length) {
      pickupNote = `加了 ${r.added} 条，跳过 ${r.skipped.length} 条：`
        + r.skipped.slice(0, 3).map((s) => `「${s.line.slice(0, 10)}」${s.why}`).join('；');
    } else if (r?.added !== undefined && body.batch !== undefined) {
      pickupNote = `批量加了 ${r.added} 条`;
    } else if (r?.removed !== undefined) {
      pickupNote = `删掉了 ${r.removed} 条`;
    } else {
      pickupNote = '';
    }
    render();
    return r;
  };

  root.append(h('div', { class: 'note' },
    '命中触发词就**主动接一句**，不等人 @。两种回法：'
    + '「回固定话术」本地直接发（不花模型钱、API 掉线也能接）；'
    + '「让模型顺着接」交给模型现编一句（要 API 在线，花一次调用）。'
    + '规则里配的触发词**忽略大小写与全半角**，命中的先后按列表顺序（越上面的越优先）。'
    + `本小时已接 ${data.hourlyUsed}/${data.cfg.maxPerHour} 次。`));
  if (pickupNote) {
    root.append(h('p', { class: 'hint', style: 'color:#b45309', text: pickupNote }));
  }

  // ---- 新增（含一行一个的批量粘）----
  const matchSel = h('select', {}, ...data.matches.map((m) => h('option', { value: m.id, text: m.label })));
  const modeSel = h('select', {}, ...data.modes.map((m) => h('option', { value: m.id, text: m.label })));
  const replyIn = h('textarea', {
    rows: 3,
    placeholder: '要回的话。一句话可以配好几种回法：**一行一种**（也可以用 | 分隔）。\n命中时随机挑一种，同一段对话里挑过的先不挑。',
  });
  const cdIn = h('input', { type: 'number', value: 0, step: 10, min: 0, style: 'width:90px', placeholder: '0=用默认' });
  const oneIn = h('input', { type: 'text', placeholder: '触发词，例如：晚安' });
  const batchArea = h('textarea', { rows: 5, placeholder: '批量加：一行一个触发词，共用右边的回法与模式。\n例如：\n晚安\n我睡了\n晚安晚安' });
  const out = h('div', { class: 'hint' });

  root.append(card('新增一条',
    '触发词短一点更容易命中（比如「晚安」而不是「大家晚安啊」）；写太长就得对方一字不差说出来。'
    + '「完全相同」要求整条消息就是这个词，「包含」只要出现就算。'
    + '回法框里一行一种，命中时随机挑一句、**同一段对话里不重复**（全挑过一轮才会允许重复）。',
    h('div', { class: 'row' },
      h('div', { class: 'grow' }, field('触发词', oneIn)),
      field('判定', matchSel), field('回法', modeSel), field('冷却(秒)', cdIn)),
    h('div', { class: 'row', style: 'margin-top:6px' },
      h('div', { class: 'grow' }, field('要回的话（一行一种，可留空给 ai 模式）', replyIn)),
      b('添加这一条', async () => {
        if (!oneIn.value.trim()) { out.textContent = '先写个触发词'; return; }
        await save({
          pattern: oneIn.value.trim(), match: matchSel.value, mode: modeSel.value,
          reply: replyIn.value.trim(), cooldownSec: Number(cdIn.value) || 0,
        });
      }, 'primary')),
    h('div', { style: 'margin-top:10px' }, field('批量加（一行一个）', batchArea)),
    h('div', { class: 'row' },
      b('批量添加', async () => {
        if (!batchArea.value.trim()) { out.textContent = '批量框里先粘几行'; return; }
        const r = await save({
          batch: batchArea.value, match: matchSel.value, mode: modeSel.value,
          reply: replyIn.value.trim(), cooldownSec: Number(cdIn.value) || 0,
        });
        out.textContent = `加了 ${r?.added ?? 0} 条` + (r?.skipped?.length ? `，跳过 ${r.skipped.length} 条（${r.skipped.map((s) => s.why).join('、')}）` : '');
      }),
      b('清空全部规则', async () => {
        if (!confirm(`确定删掉全部 ${data.rules.length} 条接话规则？`)) return;
        await save({ clear: true });
      }, 'sm danger')),
    out));

  // ---- 规则列表 ----
  const rows = data.rules.map((r) => {
    const pat = h('input', { type: 'text', value: r.pattern });
    pat.addEventListener('change', () => save({ id: r.id, pattern: pat.value.trim() }));
    const mSel = h('select', {}, ...data.matches.map((m) => h('option', { value: m.id, text: m.label })));
    mSel.value = r.match;
    mSel.addEventListener('change', () => save({ id: r.id, match: mSel.value }));
    const mdSel = h('select', {}, ...data.modes.map((m) => h('option', { value: m.id, text: m.label })));
    mdSel.value = r.mode;
    mdSel.addEventListener('change', () => save({ id: r.id, mode: mdSel.value }));
    const rep = h('textarea', { rows: 2, value: r.reply, placeholder: r.mode === 'ai' ? '（模型自己接，可留空）' : '要回的话，一行一种' });
    rep.addEventListener('change', () => save({ id: r.id, reply: rep.value.trim() }));
    const cd = h('input', { type: 'number', value: r.cooldown_sec, step: 10, min: 0, style: 'width:80px' });
    cd.addEventListener('change', () => save({ id: r.id, cooldownSec: Number(cd.value) || 0 }));
    const en = h('input', { type: 'checkbox', checked: !!r.enabled });
    en.addEventListener('change', () => save({ id: r.id, enabled: en.checked }));
    const last = Number(r.last_hit_at) > 0 ? new Date(Number(r.last_hit_at)).toLocaleString() : '还没接过';
    return h('tr', {},
      h('td', {}, h('label', { class: 'inline' }, en, h('span', { text: '' }))),
      h('td', {}, pat),
      h('td', {}, mSel),
      h('td', {}, mdSel),
      h('td', { style: 'width:34%' }, rep),
      h('td', {}, cd),
      h('td', { class: 'muted' }, h('span', { text: `${r.hits} 次` })),
      h('td', { class: 'muted', style: 'white-space:nowrap' }, h('span', { text: last })),
      h('td', {}, b('删', () => save({ remove: r.id }), 'sm danger')));
  });

  root.append(card('规则列表',
    data.rules.length
      ? '「接过几次」和「最近一次」是它真的在接的证据；一直 0 次就说明群里没出现过这些词，或者被判成「完全相同」而没人整句说。'
      : '还没有规则。上面加一条试试：比如触发词「晚安」+ 回法「晚安，早点睡」。',
    data.rules.length
      ? h('table', {}, h('thead', {}, h('tr', {},
        h('th', { text: '开' }), h('th', { text: '触发词' }), h('th', { text: '判定' }), h('th', { text: '回法' }),
        h('th', { text: '要回的话' }), h('th', { text: '冷却' }), h('th', { text: '接过' }), h('th', { text: '最近一次' }), h('th', { text: '' }))),
      h('tbody', {}, ...rows))
      : null));

  // ---- 总开关与限额 ----
  const enabled = h('input', { type: 'checkbox', checked: data.cfg.enabled !== false });
  enabled.addEventListener('change', () => save2({ enabled: enabled.checked }));
  const dcd = h('input', { type: 'number', value: data.cfg.defaultCooldownSec, step: 10, min: 0, style: 'width:90px' });
  dcd.addEventListener('change', () => save2({ defaultCooldownSec: Number(dcd.value) || 0 }));
  const mph = h('input', { type: 'number', value: data.cfg.maxPerHour, step: 1, min: 1, style: 'width:90px' });
  mph.addEventListener('change', () => save2({ maxPerHour: Number(mph.value) || 1 }));
  const sc = h('input', { type: 'number', value: data.cfg.selfChance, step: 0.1, min: 0, max: 1, style: 'width:90px' });
  sc.addEventListener('change', () => save2({ selfChance: Math.min(1, Math.max(0, Number(sc.value) || 0)) }));
  async function save2(patch) {
    await api(`${API()}/settings`, { patch: { pickup: patch } });
    toast('已保存');
    render();
  }
  root.append(card('开关与限额',
    '「默认冷却」是每条规则没单独填冷却时用的值（同一条规则在这个时间内只接一次，避免同一句话连发十遍它就接十遍）。'
    + '「每小时上限」是全机器人合计的护栏 —— 规则配得太宽（比如触发词就一个字）时，靠它兜住不刷屏。'
    + '「自己接自己」指对方那句话里**已经含有你要回的内容**（规则「原神 → 原神怎么你了」，对方正好说了「原神怎么你了」）：'
    + '照接会像复读机，所以只按这个概率接 —— 0 = 从不接、1 = 每次都接、0.3 = 三成。'
    + '接话在「主动」和「被动」模式下都会生效，但会话被设成「关闭发言」时不接。',
    h('div', { class: 'row' },
      h('label', { class: 'inline' }, enabled, h('span', { text: '启用接话' })),
      field('默认冷却(秒)', dcd), field('每小时上限', mph), field('自己接自己的概率(0~1)', sc))));

  // ---- 被找茬时回一个字（语义判断交给模型，本地只按概率放行）----
  const an = data.annoyed;
  const anOn = h('input', { type: 'checkbox', checked: an.enabled !== false });
  anOn.addEventListener('change', () => save2({ annoyed: { enabled: anOn.checked } }));
  const anChance = h('input', { type: 'number', value: an.chance, step: 0.05, min: 0, max: 1, style: 'width:90px' });
  anChance.addEventListener('change', () => save2({ annoyed: { chance: Math.min(1, Math.max(0, Number(anChance.value) || 0)) } }));
  const anText = h('input', { type: 'text', value: an.text, style: 'width:100px' });
  anText.addEventListener('change', () => save2({ annoyed: { text: anText.value.trim() || '急' } }));
  const anWhen = h('textarea', { rows: 2, placeholder: `留空用内置描述：${data.annoyedDefaultWhen}` });
  anWhen.value = String(an.when ?? '') === String(data.annoyedDefaultWhen ?? '') ? '' : String(an.when ?? '');
  anWhen.addEventListener('change', () => save2({ annoyed: { when: anWhen.value.trim() } }));
  root.append(card('被找茬时回一个字',
    '「没事找事」是语义判断，本地匹配做不到，所以交给模型：提示词里告诉它什么情况算、'
    + '想这么接就在回复里写一个记号，本地再按概率决定发不发（和语音那条路一样，记号不会泄漏到群里）。'
    + '概率 0 = 从不发、1 = 模型每次想发都发。'
    + '「什么算」可以自己改 —— 比如想限定成「只对它阴阳怪气时」，就写清楚；留空用内置描述。',
    h('div', { class: 'row' },
      h('label', { class: 'inline' }, anOn, h('span', { text: '启用' })),
      field('概率(0~1)', anChance), field('回的字', anText)),
    h('div', { style: 'margin-top:6px' }, field('什么算「没事找事」', anWhen))));

  return root;
};

// ---------- 发言与频控 ----------
RENDERERS.speech = async () => {
  if (!state.botId) return card('', '先创建机器人');
  const { settings } = await api(`${API()}/settings`);
  const save = async (patch) => { await api(`${API()}/settings`, { patch }); toast('已保存'); render(); };
  // AI 互聊的开关与参数存在**全局**设置里（一次管所有机器人），不能走每机器人的 save()
  const gset = await api('/api/global');
  const saveG = async (patch) => { await api('/api/global', { patch }); toast('已保存'); render(); };
  const sp = settings.speak, ec = settings.repeatEcho, rt = settings.rate;

  const modeSel = (value, on) => {
    const s = h('select', {}, ...[['passive', '被动（被@才回）'], ['active', '主动（可自行接话）'], ['off', '关闭']]
      .map(([v, t]) => h('option', { value: v, text: t, selected: value === v })));
    s.addEventListener('change', () => on(s.value));
    return s;
  };

  const root = h('div', {});
  root.append(card('发言模式', '主动模式走两级闸门：先本地粗筛，通过的才送模型判断要不要接话。私聊恒为被动。',
    h('div', { class: 'row' },
      field('群里默认', modeSel(sp.defaultGroupMode, (v) => save({ speak: { defaultGroupMode: v } }))),
      field('本群每小时最多主动说', numInput(sp.active.perGroupPerHour, (v) => save({ speak: { active: { perGroupPerHour: v } } }))),
      field('两条之间至少隔(秒)', numInput(sp.active.minGapSec, (v) => save({ speak: { active: { minGapSec: v } } })))),
    h('div', { class: 'row', style: 'margin-top:8px' },
      field('粗筛：最短字数', numInput(sp.active.minMessageLength, (v) => save({ speak: { active: { minMessageLength: v } } }))),
      field('粗筛：随机命中率', numInput(sp.active.randomRate, (v) => save({ speak: { active: { randomRate: v } } }), 'width:90px')))));

  root.append(card('AI 互聊',
    '让同一个群里的几个机器人互相接话。关着的时候它们互相当对方不存在（连历史都不记）。这个开关是全局的，一次对所有机器人生效，也可以用 /talk on、/talk off 切换。注意：开着时它们会一直对聊，所以有「连续上限」当刹车——连续几条都是机器人在说就自动停，等真人开口再恢复。',
    h('div', { class: 'row' },
      field('互聊', (() => {
        const cb = h('input', { type: 'checkbox', checked: gset?.talk?.enabled === true });
        cb.addEventListener('change', () => saveG({ talk: { enabled: cb.checked } }));
        return cb;
      })()),
      field('两次发言至少隔(毫秒)', numInput(gset?.talk?.minGapMs ?? 1500, (v) => saveG({ talk: { minGapMs: v } }))),
      field('连续说几条就停', numInput(gset?.talk?.maxChain ?? 6, (v) => saveG({ talk: { maxChain: v } }))))));

  root.append(card('叫它什么名字', '群里没人会喊全名。把你平时叫它的名字都加进来，它才会答应。一行一个，别写太短的通用词。',
    (() => {
      const ta = h('textarea', { rows: 3, placeholder: '小向\n客服小向' });
      ta.value = (sp.aliases ?? []).join('\n');
      return h('div', {}, ta, h('div', { class: 'row', style: 'margin-top:8px' },
        b('保存', () => save({ speak: { aliases: ta.value.split('\n').map((x) => x.trim()).filter(Boolean) } }), 'primary'),
        h('span', { class: 'muted', text: '机器人自己的昵称会自动算进去，这里补别名即可' })));
    })()));

  root.append(card('单条消息的篇幅',
    '模型返回一整串句子时，本地会按下面的句子数**拆成多条发出去**：一条装几句由「每条最多几句」定，最多发几条由「一次最多发几条」定（超了就均匀合并，不会丢内容）。',
    h('div', { class: 'row' },
      field('日常：每条最多几句', numInput(sp.maxSentences, (v) => save({ speak: { maxSentences: v } }))),
      field('讲解：每条最多几句', numInput(sp.maxSentencesDetailed, (v) => save({ speak: { maxSentencesDetailed: v } }))),
      field('一次最多发几条', numInput(sp.maxMessages, (v) => save({ speak: { maxMessages: v } })))),
    h('p', { class: 'hint', text: '例：模型写了 7 句，「每条最多几句」= 3 时，会拆成 3+3+1 共 3 条发出去。填 1 就是一句一条（短促连绵），填 3 就是每条几句。' }),
    h('div', { class: 'row', style: 'margin-top:8px' },
      field('闲聊：字数目标', numInput(sp.replyMaxChars, (v) => save({ speak: { replyMaxChars: v } }))),
      field('讲题/举例：字数目标', numInput(sp.replyMaxCharsDetailed ?? 200, (v) => save({ speak: { replyMaxCharsDetailed: v } }))),
      field('分条之间隔(毫秒)', numInput(sp.segmentDelayMs ?? 350, (v) => save({ speak: { segmentDelayMs: v } }))),
      toggle('超长时自动拆条', sp.splitLongReplies !== false, (v) => save({ speak: { splitLongReplies: v } }))),
    h('p', { class: 'hint', text: '字数目标写进提示词，模型按「是不是在讲正经东西」自己选：只给一个上限的话，讲例题它也会往那个数字上压，结果就是只讲一半、不给具体例子。分条间隔是本地发送时的停顿，0 到 3000 毫秒；多条消息就是按这个节奏一条条发出去的。' }),
    (() => {
      const ta = h('textarea', { rows: 3, placeholder: '留空使用内置清单' });
      ta.value = (sp.detailedKeywords ?? []).join('\n');
      return h('div', { style: 'margin-top:10px' },
        h('p', { class: 'hint', text: '命中这些词就按「讲解」档处理，一条消息可以多带几句。一行一个，留空用内置清单。' }),
        ta,
        h('div', { class: 'row', style: 'margin-top:6px' },
          b('保存关键词', () => save({ speak: { detailedKeywords: ta.value.split('\n').map((x) => x.trim()).filter(Boolean) } }), 'primary')));
    })()));

  root.append(card('网上素材',
    '打开后，当对方像是在要个乐子时，会从一言（抖机灵／来自网络）抓一句当聊天素材——取不到就不带，不影响回复。素材只是给他参考，用不用、怎么由他自己决定。实测只有一言这个源能连通，所以只用它。',
    h('div', { class: 'row' },
      toggle('抓网上素材', settings.api.webJokes?.enabled === true, (v) => save({ api: { webJokes: { enabled: v } } })),
      field('抽冷子自己讲一句的概率', numInput(settings.api.webJokes?.randomRate ?? 0,
        (v) => save({ api: { webJokes: { randomRate: v } } }), 'width:90px')),
      field('超时(毫秒)', numInput(settings.api.webJokes?.timeoutMs ?? 9000,
        (v) => save({ api: { webJokes: { timeoutMs: v } } }))))));

  root.append(card('复读', '群里不同的人说了相同的话，机器人可以跟着说一遍，由模型决定要不要跟。',
    h('div', { class: 'row' },
      toggle('启用复读', ec.enabled, (v) => save({ repeatEcho: { enabled: v } })),
      field('几个人说才算', numInput(ec.minPeople, (v) => save({ repeatEcho: { minPeople: v } }))),
      field('允许隔几条', numInput(ec.maxGapMessages, (v) => save({ repeatEcho: { maxGapMessages: v } }))),
      field('检测窗口', numInput(ec.windowMessages, (v) => save({ repeatEcho: { windowMessages: v } })))),
    h('div', { class: 'row', style: 'margin-top:8px' },
      field('相同判定', (() => {
        const s = h('select', {}, ...[['loosest', '最宽松（忽略标点和空格）'], ['loose', '宽松（忽略大小写与全半角）'], ['strict', '严格（一字不差）']]
          .map(([v, t]) => h('option', { value: v, text: t, selected: ec.matchMode === v })));
        s.addEventListener('change', () => save({ repeatEcho: { matchMode: s.value } }));
        return s;
      })()),
      field('最短字数', numInput(ec.minLength, (v) => save({ repeatEcho: { minLength: v } }))),
      toggle('只在主动模式的群生效', ec.onlyActiveMode, (v) => save({ repeatEcho: { onlyActiveMode: v } })))));

  const rate = (label, cfg, key, hint) => h('div', { class: 'row', style: 'margin-top:8px' },
    h('span', { class: 'muted', style: 'width:110px', text: label }),
    field('窗口(秒)', numInput(cfg.windowSec, (v) => save({ rate: { [key]: { windowSec: v } } }))),
    field('上限(条)', numInput(cfg.max, (v) => save({ rate: { [key]: { max: v } } }))),
    h('span', { class: 'muted', text: hint ?? '' }));

  root.append(card('频控', '阈值是全局单一值，但按人分别计数。',
    rate('重复内容', rt.repeat, 'repeat', '更严'),
    rate('非重复内容', rt.unique, 'unique', '较松'),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('span', { class: 'muted', style: 'width:110px', text: '全局防风控' }),
      field('每分钟', numInput(rt.global.perMinute, (v) => save({ rate: { global: { perMinute: v } } }))),
      field('每小时', numInput(rt.global.perHour, (v) => save({ rate: { global: { perHour: v } } }))),
      h('span', { class: 'muted', text: '不分人，防封号' }))));

  root.append(card('上下文', null,
    h('div', { class: 'row' },
      field('记忆轮数', numInput(settings.context.rounds, (v) => save({ context: { rounds: v } }))),
      toggle('启用摘要压缩', settings.context.summary.enabled, (v) => save({ context: { summary: { enabled: v } } })),
      field('每几轮压缩一次', numInput(settings.context.summary.everyKRounds, (v) => save({ context: { summary: { everyKRounds: v } } })))),
    h('p', { class: 'hint', text: '摘要会破坏前缀缓存，默认关闭。记忆轮数越大，命中缓存的上下文越多，反而更省。' })));

  // ---- 语音回复（四档）----
  // 音色是共享资源（.tools/tts/<名字>/），这里只选用哪一个；试听与新增在「音色」页。
  const vc = sp.voice ?? {};
  const vdata = await api('/api/voices' + (state.botId ? `?botId=${encodeURIComponent(state.botId)}` : ''));
  const selOf = (value, pairs, on) => {
    const s = h('select', {}, ...pairs.map(([v, t]) => h('option', { value: v, text: t, selected: String(value) === String(v) })));
    s.addEventListener('change', () => on(s.value));
    return s;
  };
  const voicePairs = [['', '（默认：清单里第一个）'], ...(vdata.voices ?? []).map((v) => {
    const tag = v.kind === 'rvc' ? `（变声${v.label ? '·' + v.label : ''}）`
      : v.kind === 'cosyvoice' ? '（CosyVoice）'
        : v.kind === 'zipvoice' ? '（克隆）' : '';
    return [v.id, v.id + tag];
  })];
  const q = vdata.quota;

  root.append(card('语音回复（本地合成，不花钱，但慢）',
    '四档：只发文字 / 全用语音 / 按概率 / 由模型自己决定（它想用语音就在回复第一行写 [语音]）。一条语音约 11 秒才合成完，所以默认单条 26 字、一次最多 2 条、每小时 20 条；讲题类回答自动走文字（要能回头翻）。'
    + '变声音色（rvc: 开头）要多过一道：先用标准音色念、再换音色，一条约 18 秒，嫌慢就少用它。'
    + '「模型点名时最多几条」是它自己写了 [语音] 时的额度（默认 4）——群里让人「朗读」一段诗是明确要求，被 2 条卡掉会显得答非所问。'
    + '「停顿」是句间补的静音毫秒数：普通音色（vits）的停顿烧在模型里，调这个才有用，代价是每个分句都要单独合成一次；克隆音色本来就慢，别调大。'
    + '「语速」0 = 用默认（克隆音色默认 0.82），嫌快就往小调（0.72 比默认慢约一成）。'
    + '一条回复要么整条语音、要么整条文字，不会混着发。音色在下面选，试听和「放音频自动生成音色」都在「音色」页。',
    h('div', { class: 'row' },
      field('档位', selOf(vc.mode ?? 'text', [['text', '只发文字'], ['voice', '全用语音'], ['prob', '按概率'], ['ai', '模型自己决定']],
        (v) => save({ speak: { voice: { mode: v } } }))),
      field('概率', numInput(vc.prob ?? 0.3, (v) => save({ speak: { voice: { prob: v } } }), 'width:80px')),
      field('音色', selOf(vc.voiceId ?? '', voicePairs, (v) => save({ speak: { voice: { voiceId: v } } }))),
      field('质量', selOf(vc.quality ?? 'normal', [['normal', '默认'], ['high', '高质量（慢 3 倍）'], ['auto', '自动（讲题时高质量）']],
        (v) => save({ speak: { voice: { quality: v } } })))),
    h('div', { class: 'row', style: 'margin-top:8px' },
      field('语速', numInput(vc.speed ?? 0, (v) => save({ speak: { voice: { speed: v } } }), 'width:80px')),
      field('单条字数', numInput(vc.maxChars ?? 26, (v) => save({ speak: { voice: { maxChars: v } } }), 'width:80px')),
      field('最多几条', numInput(vc.maxMessages ?? 2, (v) => save({ speak: { voice: { maxMessages: v } } }), 'width:80px')),
      field('模型点名时最多几条', numInput(vc.maxMessagesForced ?? 4, (v) => save({ speak: { voice: { maxMessagesForced: v } } }), 'width:90px')),
      field('每小时上限', numInput(vc.perHour ?? 20, (v) => save({ speak: { voice: { perHour: v } } }), 'width:80px')),
      field('停顿(毫秒)', numInput(vc.pauseMs ?? 0, (v) => save({ speak: { voice: { pauseMs: v } } }), 'width:90px')),
      h('span', { class: 'muted', text: q ? `本小时已用 ${q.used}/${q.limit}` : '' }))));

  return root;
};

// ---------- 风格卡 ----------
RENDERERS.persona = async () => {
  if (!state.botId) return card('', '先创建机器人');
  const p = await api(`${API()}/persona`);
  const snaps = await api(`${API()}/snapshots`);
  const root = h('div', {});

  const bodyArea = h('textarea', { rows: 18 });
  bodyArea.value = p.body;
  const exArea = h('textarea', { rows: 6 });
  exArea.value = (p.examples ?? []).join('\n');
  const paramsArea = h('textarea', { rows: 4 });
  paramsArea.value = JSON.stringify(p.params ?? {}, null, 2);

  // 三个板块共用一套保存逻辑，但**各自要有独立的按钮节点**——
  // DOM 里同一个节点只能出现在一个位置，复用会让按钮被挪到最后一个板块，
  // 结果在「固定例句」里改完找不到保存按钮。
  const doSave = async () => {
    let params = p.params ?? {};
    let paramsBad = false;
    try {
      params = JSON.parse(paramsArea.value || '{}');
    } catch {
      // 行为参数写坏了不该连累正文和例句：那两个照存，只提示参数没保存
      paramsBad = true;
    }
    const payload = {
      body: bodyArea.value,
      examples: exArea.value.split('\n').map((s) => s.trim()).filter(Boolean),
    };
    if (!paramsBad) payload.params = params;

    await api(`${API()}/persona`, payload);
    if (paramsBad) toast('正文和例句已保存；行为参数不是合法 JSON，这次没保存', true);
    else toast('已保存');
    render();
  };
  const mkSaveBtn = (label) => b(label, doSave, 'primary');

  root.append(card('风格卡正文', '这是唯一进入模型的内容。改完之后缓存前缀会变，之后恢复正常。',
    bodyArea, h('div', { class: 'row', style: 'margin-top:10px' }, mkSaveBtn('保存正文'))));

  root.append(card('固定例句', '一行一条。这些例句每次对话都会带给模型。',
    exArea, h('div', { class: 'row', style: 'margin-top:10px' }, mkSaveBtn('保存例句'))));

  root.append(card('行为参数', 'JSON 格式，例如句长、称呼方式。',
    paramsArea, h('div', { class: 'row', style: 'margin-top:10px' }, mkSaveBtn('保存参数'))));

  const snapInput = h('input', { type: 'text', placeholder: '快照名字，例如「我调好的最终版」' });

  const snapRow = (s) => h('tr', {},
    h('td', {}, h('span', { class: s.kind === 'base' ? 'pill ok' : 'pill', text: s.kind === 'base' ? '基准' : '自动' })),
    h('td', { text: s.label }),
    h('td', { class: 'muted', text: new Date(s.created_at).toLocaleString('zh-CN') }),
    h('td', {}, `${s.body_len} 字`),
    h('td', {}, b('回退', async () => {
      if (!confirm(`回退到「${s.label}」？当前状态会先自动备份一份。`)) return;
      await api(`${API()}/snapshots`, { restore: s.id });
      toast('已回退');
      render();
    }, 'sm')));

  const snapRows = snaps.length
    ? snaps.map(snapRow)
    : [h('tr', {}, h('td', { class: 'muted', text: '还没有快照' }))];

  root.append(card('快照', '基准快照永久保留，不会被自动清理，任何时候都能回退。',
    h('div', { class: 'row' }, h('div', { class: 'grow' }, snapInput),
      b('存为基准快照', async () => {
        if (!snapInput.value.trim()) return toast('请填名字', true);
        await api(`${API()}/persona`, { snapshotLabel: snapInput.value.trim() });
        toast('已保存快照');
        render();
      }, 'primary')),
    h('table', {}, h('tbody', {}, ...snapRows))));
  return root;
};

// ---------- 学习 ----------
RENDERERS.learn = async () => {
  if (!state.botId) return card('', '先创建机器人');
  const data = await api(`${API()}/learning`);
  const st = data.readiness.stats;
  const cfg = data.settings;
  const root = h('div', {});

  // 手动加语料：界面上直接粘，或者在群里引用一条别人的消息用 /learn quote 收
  const notes = (await api(`${API()}/notes`).catch(() => ({ notes: [] }))).notes ?? [];
  const noteInput = h('textarea', { rows: 3, placeholder: '把想让它参考的句子粘进来。\n比如某个人说话特别有意思，或者你自己想让它记住的说法。' });
  const noteList = () => (notes.length === 0
    ? h('p', { class: 'hint', text: '还没有手动语料。群里引用一条消息发 /learn quote 也能收进来。' })
    : h('div', {}, ...notes.map((n) => h('div', { class: 'row', style: 'margin-top:6px;align-items:flex-start' },
      h('div', { class: 'grow' },
        h('div', { style: 'font-size:13px;white-space:pre-wrap', text: n.text.slice(0, 400) }),
        h('div', { class: 'muted', style: 'font-size:11px', text: `${n.source === 'quoted' ? '引用' : (n.source === 'media' ? '语音/视频' : '手动')}${n.who ? ' · ' + n.who : ''} · ${new Date(n.createdAt).toLocaleString('zh-CN')}` })),
      b('删除', async () => { await apiDel(`${API()}/notes/${n.id}`); toast('已删除'); render(); })))));

  // 语音/视频语料：文件放目录里，扫描后本地识别（不花模型钱），停顿和语气都会变成素材里的一句话
  const media = await api(`${API()}/media`).catch(() => ({ dir: '', files: [] }));
  const mediaBox = h('div', { style: 'margin-top:12px' },
    h('p', { class: 'hint', text: `语音和视频：把文件（mp3/m4a/mp4/…）丢进 ${media.dir || 'data/learn-media'}，文件名当说话人，然后点扫描。识别在本地跑，不花模型钱；语气（开心/生气）、笑声、语速和停顿都会写进素材。` }),
    h('div', { class: 'row', style: 'margin-top:6px' },
      b('扫描并收录', async (ev) => {
        ev.target.disabled = true;
        ev.target.textContent = '识别中…（长文件要等一会儿）';
        try {
          const r = await api(`${API()}/media/ingest`, {});
          const okN = (r.results ?? []).filter((x) => x.ok).length;
          const skipN = (r.results ?? []).filter((x) => x.skipped).length;
          const bad = (r.results ?? []).filter((x) => !x.ok && !x.skipped);
          toast(`收录 ${okN} 个${skipN ? `，跳过 ${skipN} 个（同名已收录）` : ''}${bad.length ? `，${bad.length} 个失败` : ''}`, bad.length > 0);
          if (bad.length) console.warn('收录失败的：', bad);
          render();
        } catch (e) {
          toast(String(e.message), true);
          ev.target.disabled = false;
        }
      }, 'primary'),
      h('span', { class: 'muted', text: `目录里现在有 ${media.files?.length ?? 0} 个音视频文件` })));

  root.append(card('手动加语料',
    '粘进来的句子会被当成「特意挑的参考」进到学习素材里（每次学习都带上，不需要了就删掉）。它和学习标记不一样：不挂在某条聊天记录上，聊天记录过期了也不影响。引用了别人的消息时，模型只会学句式和套路，不会把别人的口头禅当成它自己的。',
    noteInput,
    h('div', { class: 'row', style: 'margin-top:8px' },
      b('保存这条语料', async () => {
        const text = noteInput.value.trim();
        if (!text) return toast('先写点东西', true);
        await api(`${API()}/notes`, { text });
        noteInput.value = '';
        toast('已收下');
        render();
      }, 'primary'),
      h('span', { class: 'muted', text: '群里用法：引用一条消息（文字/语音/截图都能识，图片走视觉模型）→ 发 /learn quote' })),
    mediaBox,
    noteList()));

  const save = async (patch) => { await api(`${API()}/settings`, { patch }); toast('已保存'); render(); };

  root.append(h('div', { class: 'note' },
    '学习只产出「建议」，改风格卡一定发生在你点采纳之后，而且改之前会自动存一份快照，随时能回退。'));

  root.append(card('素材', '素材 A 是机器人自己说过的话（按上次学习时间取增量，已去重、排除被标👎的）。素材 B 是你在「聊天记录」里手动标的例子。',
    h('div', { class: 'grid' },
      h('div', {}, h('div', { class: 'kv' }, h('span', { text: '素材 A' }), h('span', { text: `${st.a.count} 条 · ${st.a.chars} 字` })),
        h('div', { class: 'kv' }, h('span', { text: '其中排除 👎' }), h('span', { text: st.a.excluded }))),
      h('div', {}, h('div', { class: 'kv' }, h('span', { text: '素材 B 👍' }), h('span', { text: st.b.good })),
        h('div', { class: 'kv' }, h('span', { text: '素材 B 👎' }), h('span', { text: st.b.bad })))),
    h('div', { class: 'row', style: 'margin-top:10px' },
      toggle('启用素材 A（机器人自己的发言）', cfg.sourceA !== false, (v) => save({ learning: { sourceA: v } })),
      toggle('启用素材 B（手动标记）', cfg.sourceB !== false, (v) => save({ learning: { sourceB: v } })),
      toggle('自动采纳低风险项（只新增例句）', !!cfg.autoApply, (v) => save({ learning: { autoApply: v } })))),
  );

  const runBtn = b('开始学习', async (ev) => {
    const btn = ev.target;
    btn.disabled = true;
    btn.textContent = '提炼中…（约 20 秒）';
    try {
      const r = await api(`${API()}/learning/run`, {});
      toast(`提炼出 ${r.suggestions.length} 条建议`);
      if ((r.autoIds ?? []).length) {
        await api(`${API()}/learning/apply`, { runId: r.runId, acceptedIds: r.autoIds });
        toast(`其中 ${r.autoIds.length} 条低风险项已自动采纳`);
      }
      render();
    } catch (e) {
      toast('学习失败：' + e.message, true);
      btn.disabled = false;
      btn.textContent = '开始学习';
    }
  }, 'primary');
  if (!data.readiness.ok) runBtn.disabled = true;

  root.append(card('跑一次学习',
    data.readiness.ok
      ? '会调用一次模型（高思考档），从上面两批素材里找现有风格卡没有的新特征。'
      : '暂时学不了：' + data.readiness.reason,
    h('div', { class: 'row' }, runBtn)));

  // 待审核
  const pending = data.runs.filter((r) => r.status === 'pending');
  for (const run of pending) {
    const box = h('div', {});
    box.append(h('p', { class: 'hint', text: run.observations || '（模型没有给出观察说明）' }));
    const boxes = [];
    if (!run.payload.suggestions.length) {
      box.append(h('p', { class: 'muted', text: '这次没有提出任何新特征——按提示词的设计，这是正常结果，说明现有风格卡已经覆盖了这批素材。' }));
    }
    for (const s of run.payload.suggestions) {
      const cb = h('input', { type: 'checkbox', checked: true });
      boxes.push({ id: s.id, cb });
      box.append(h('div', { style: 'padding:6px 0;border-bottom:1px solid var(--line)' },
        h('label', { class: 'inline' }, cb, h('span', { class: 'pill', text: s.section })),
        h('div', { style: 'margin-top:3px' }, s.text),
        s.reason ? h('div', { class: 'hint', text: '理由：' + s.reason }) : null,
        s.evidence?.length ? h('div', { class: 'hint', text: '依据：' + s.evidence.join(' ｜ ') }) : null));
    }
    const adopt = b('采纳所选', async () => {
      const ids = boxes.filter((x) => x.cb.checked).map((x) => x.id);
      if (!ids.length && !confirm('一条都没勾，只会把这条学习记录关掉。继续？')) return;
      await api(`${API()}/learning/apply`, { runId: run.id, acceptedIds: ids });
      toast(ids.length ? `已采纳 ${ids.length} 条，改动前已存快照` : '已关闭这条记录');
      render();
    }, 'primary');
    const drop = b('全部丢弃', async () => {
      await api(`${API()}/learning/discard`, { runId: run.id });
      render();
    });
    box.append(h('div', { class: 'row', style: 'margin-top:10px' }, adopt, drop));
    root.append(card(`待审核（${new Date(run.createdAt).toLocaleString('zh-CN')}）`,
      `素材 A ${run.sourceA} 条 · 👍 ${run.sourceBGood} · 👎 ${run.sourceBBad}`, box));
  }

  // 历史
  const done = data.runs.filter((r) => r.status !== 'pending');
  if (done.length) {
    root.append(card('历史', null, h('table', {},
      h('thead', {}, h('tr', {}, h('th', { text: '时间' }), h('th', { text: '结果' }), h('th', { text: '建议' }), h('th', { text: '采纳' }))),
      h('tbody', {}, ...done.map((r) => h('tr', {},
        h('td', { class: 'muted', text: new Date(r.createdAt).toLocaleString('zh-CN') }),
        h('td', {}, h('span', { class: r.status === 'applied' ? 'pill ok' : 'pill', text: r.status === 'applied' ? '已采纳' : '已丢弃' })),
        h('td', { text: r.suggestions }),
        h('td', { text: r.accepted }))))))); 
  }

  return root;
};

// ---------- 印象 ----------
RENDERERS.impressions = async () => {
  if (!state.botId) return card('', '先创建机器人');
  const rows = await api(`${API()}/impressions`);
  const root = h('div', {});

  root.append(h('div', { class: 'note' },
    '印象是机器人对某个人的长期认知，只在他跟这个人说话时带上，不会被记忆淘汰。'
    + '手写内容优先级最高，自动提炼不会覆盖它。'));

  // 提炼：印象要提炼过才会出现，不点就一直空着
  root.append(card('提炼印象', '把每个人最近说过的话交给模型，更新他的档案。聊过之后点一次即可。',
    h('div', { class: 'row' },
      b('给所有人提炼一次', async (ev) => {
        const btn = ev.target;
        btn.disabled = true;
        btn.textContent = '提炼中…';
        try {
          const r = await api(`${API()}/impressions/extract`, {});
          toast(`提炼完成：${r.done}/${r.total} 人`);
          render();
        } catch (e) {
          toast('失败：' + e.message, true);
          btn.disabled = false;
          btn.textContent = '给所有人提炼一次';
        }
      }, 'primary'),
      h('span', { class: 'muted', text: '每人一次模型调用，聊得少的人会被跳过' }))));

  // 大小号绑定
  const qqA = h('input', { type: 'text', placeholder: 'QQ 号 A', style: 'width:150px' });
  const qqB = h('input', { type: 'text', placeholder: 'QQ 号 B', style: 'width:150px' });
  root.append(card('把多个 QQ 号绑成一个人', '绑定后他们共用记忆、印象、名单和权限。解绑出来的号按新用户算，不带历史。',
    h('div', { class: 'row' }, qqA, qqB,
      b('绑定', async () => {
        const a = qqA.value.trim();
        const c = qqB.value.trim();
        if (!a || !c) return toast('两个号都要填', true);
        try {
          const r = await api(`${API()}/bind`, { qqA: a, qqB: c });
          toast(r.merged ? '已绑成同一个人' : '他们本来就是同一个人');
          render();
        } catch (e) { toast('失败：' + e.message, true); }
      }, 'primary'))));

  if (!rows.length) {
    root.append(card('还没有记录', '机器人跟人聊过之后，这里会出现。'));
    return root;
  }

  const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN') : '');

  for (const r of rows) {
    const manual = h('input', { type: 'text', value: r.manual, placeholder: '手写印象（优先级最高）' });
    manual.addEventListener('change', async () => {
      await api(`${API()}/impressions`, { personId: r.personId, manual: manual.value });
      toast('已保存');
    });

    const title = r.lastName || r.qqs.join(' / ') || `第 ${r.personId} 号人物`;
    const sub = [
      `QQ：${r.qqs.join(' ／ ')}`,
      `说过 ${r.msgCount} 句`,
      r.lastTs ? `最后活动 ${fmtTime(r.lastTs)}` : '',
    ].filter(Boolean).join('　');

    root.append(card(title, sub,
      h('div', { class: 'row' }, h('div', { class: 'grow' }, manual),
        b('提炼这个人的', async (ev) => {
          ev.target.disabled = true;
          ev.target.textContent = '提炼中…';
          try {
            const res = await api(`${API()}/impressions/extract`, { personId: r.personId });
            const one = res.results?.[0];
            toast(one?.ok ? '已更新印象' : '提炼失败：' + (one?.error ?? '未知'));
            render();
          } catch (e) {
            toast('失败：' + e.message, true);
            ev.target.disabled = false;
            ev.target.textContent = '提炼这个人的';
          }
        }, 'sm primary'),
        r.qqs.length > 1
          ? b('解绑其中一个', async () => {
            const q = prompt('要把哪个 QQ 号解绑出来？\n' + r.qqs.join('、'));
            if (!q) return;
            try {
              await api(`${API()}/unbind`, { qq: q.trim() });
              toast('已解绑，该号按新用户算');
              render();
            } catch (e) { toast('失败：' + e.message, true); }
          }, 'sm')
          : null,
        b('清除印象', async () => {
          if (!confirm('清除这个人的全部印象？')) return;
          await api(`${API()}/impressions`, { personId: r.personId, remove: true });
          render();
        }, 'sm danger')),
      r.facts ? h('p', { class: 'hint', text: '📌 知道的事实：' + r.facts }) : null,
      r.feelings ? h('p', { class: 'hint', text: '💭 对 TA 的印象：' + r.feelings }) : null,
      (!r.facts && !r.feelings && !r.manual)
        ? h('p', { class: 'hint', text: '还没有印象。点上面的「提炼这个人的」生成，或直接在输入框里手写。' })
        : null));
  }
  return root;
};

// ---------- 命令与管理员 ----------
RENDERERS.commands = async () => {
  if (!state.botId) return card('', '先创建机器人');
  const data = await api(`${API()}/admins`);
  const cmds = await api('/api/commands');
  const { settings } = await api(`${API()}/settings`);
  const root = h('div', {});

  root.append(h('div', { class: 'note', text: '管理员名单为空时，所有命令一律不响应（防止新部署的机器人被人抢先教）。' }));

  const qqInput = h('input', { type: 'text', placeholder: 'QQ 号', style: 'width:180px' });
  const save = async (body) => { await api(`${API()}/admins`, body); toast('已保存'); render(); };
  root.append(card('管理员', '按「人」判定：绑定的小号自动继承权限。',
    h('div', { class: 'row' }, qqInput, b('添加', () => { if (qqInput.value.trim()) save({ qq: qqInput.value.trim() }); }, 'primary')),
    h('div', { class: 'row', style: 'margin-top:8px' },
      ...(data.admins.length
        ? data.admins.map((q) => h('span', { class: 'pill' }, q, ' ', b('×', () => save({ qq: q, remove: true }), 'sm')))
        : [h('span', { class: 'muted', text: '（空 · 命令当前无人可用）' })]))));

  // /learn 的确认回话
  const lr = settings.speak?.learnReplies ?? {};
  const goodInput = h('input', { type: 'text', value: lr.goodex ?? '' });
  const badInput = h('input', { type: 'text', value: lr.badex ?? '' });
  root.append(card('/learn 的回话', '标记成功后回一句，让你知道生效了。留空则用默认文案。',
    h('div', { class: 'row' }, h('span', { class: 'muted', style: 'width:96px', text: '/learn goodex' }), goodInput),
    h('div', { class: 'row', style: 'margin-top:8px' }, h('span', { class: 'muted', style: 'width:96px', text: '/learn badex' }), badInput),
    h('div', { class: 'row', style: 'margin-top:10px' },
      b('保存', async () => {
        await api(`${API()}/settings`, { patch: { speak: { learnReplies: { goodex: goodInput.value, badex: badInput.value } } } });
        toast('已保存');
        render();
      }, 'primary'))));

  const bodyArea = h('textarea', { rows: 4 });
  bodyArea.value = settings.help?.body ?? '';
  const footerArea = h('textarea', { rows: 2 });
  footerArea.value = settings.help?.footer ?? '';
  const desc = settings.help?.descriptions ?? {};
  const descRows = [];
  for (const c of cmds) for (const u of (c.usages ?? [])) {
    const key = u.key;
    const i = h('input', { type: 'text', value: desc[key] ?? u.desc });
    i.addEventListener('change', async () => {
      const next = { ...desc, [key]: i.value };
      await api(`${API()}/settings`, { patch: { help: { descriptions: next } } });
      toast('已保存');
    });
    descRows.push(h('tr', {}, h('td', { class: 'mono', text: u.text }), h('td', { style: 'width:70%' }, i)));
  }

  root.append(card('/help 文本', '留空则用默认值。命令列表是自动生成的，不用手写。',
    h('div', { class: 'row' }, h('span', { class: 'muted', style: 'width:70px', text: '正文' }), bodyArea),
    h('div', { class: 'row', style: 'margin-top:8px' }, h('span', { class: 'muted', style: 'width:70px', text: '页脚' }), footerArea),
    h('div', { class: 'row', style: 'margin-top:10px' },
      b('保存', async () => {
        await api(`${API()}/settings`, { patch: { help: { body: bodyArea.value, footer: footerArea.value } } });
        toast('已保存');
        render();
      }, 'primary')),
    h('table', { style: 'margin-top:12px' }, h('tbody', {}, ...descRows))));

  return root;
};

// ---------- 聊天记录 ----------
RENDERERS.messages = async () => {
  if (!state.botId) return card('', '先创建机器人');
  const rows = await api(`${API()}/messages?limit=200`);
  const root = h('div', {});
  root.append(h('div', { class: 'note', text: '在这里可以直接给机器人的发言打标：👍 进学习素材，👎 让它别学这类。' }));
  if (!rows.length) { root.append(card('还没有记录', null)); return root; }

  const box = h('div', {});
  for (const m of rows.slice().reverse()) {
    const isBot = m.role === 'bot';
    const cls = 'msg' + (isBot ? ' bot' : '') + (m.mark === 'good' ? ' mark-good' : m.mark === 'bad' ? ' mark-bad' : '');
    box.append(h('div', { class: cls },
      h('div', { class: 'who' },
        (isBot ? '机器人' : (m.senderName || m.senderQq || '未知')),
        m.kind === 'group' ? `　群 ${m.peerId}` : '　私聊',
        '　', new Date(m.ts).toLocaleString('zh-CN'),
        m.flags ? `　[${m.flags}]` : ''),
      h('div', { text: m.text }),
      imageStrip(m),
      isBot ? h('div', { class: 'row', style: 'margin-top:3px' },
        b(m.mark === 'good' ? '👍 已标' : '👍 说得好', async () => {
          await api(`${API()}/mark`, { messageId: m.id, kind: m.mark === 'good' ? 'none' : 'good' });
          render();
        }, 'sm'),
        b(m.mark === 'bad' ? '👎 已标' : '👎 别这样', async () => {
          await api(`${API()}/mark`, { messageId: m.id, kind: m.mark === 'bad' ? 'none' : 'bad' });
          render();
        }, 'sm')) : null));
  }
  root.append(card('最近 200 条', null, box));
  return root;
};

/**
 * 消息里的图片。地址有两种：
 *  · http(s)：直接让浏览器去取
 *  · 本机路径（NapCat 开了本地直链就常给这种）：浏览器读不了 file://，
 *    得走我们的接口——接口只认库里存过的那个地址，客户端传不了任意路径
 */
function imageStrip(m) {
  const list = Array.isArray(m.media) ? m.media : [];
  if (!list.length) return null;
  const row = h('div', { class: 'thumbs' });
  list.forEach((it, i) => {
    const direct = /^https?:\/\//i.test(it.url);
    const src = direct ? it.url : `${API()}/message-image?msgId=${m.id}&i=${i}`;
    const img = h('img', { class: 'thumb', src, alt: '图片', loading: 'lazy' });
    img.addEventListener('error', () => {
      // 取不到就退成一行说明，别留个破图
      img.replaceWith(h('span', { class: 'muted', style: 'font-size:12px', text: '（图片取不到了，NapCat 缓存可能已清理）' }));
    });
    img.addEventListener('click', () => window.open(src, '_blank'));
    row.append(img);
  });
  return row;
}

// ---------- 日志 ----------
RENDERERS.logs = async () => {
  const head = document.getElementById('headActions');
  head.replaceChildren(b('导出日志包', async () => {
    const r = await api('/api/logs/export', {});
    toast('已导出到 ' + r.file);
  }, 'primary'));
  const data = await api('/api/logs?lines=300');
  const sel = h('select', { style: 'width:260px' }, ...data.files.map((f) =>
    h('option', { value: f, text: f, selected: f === data.file })));
  sel.addEventListener('change', async () => {
    const d = await api('/api/logs?file=' + encodeURIComponent(sel.value) + '&lines=300');
    pre.textContent = d.lines.join('\n');
    pre.scrollTop = pre.scrollHeight;
  });
  const pre = h('pre', { class: 'log', text: (data.lines ?? []).join('\n') });
  return card('日志', '密钥在写盘和输出前都会打码。导出会把近期日志汇总成一个文件放到 inbox/logs。',
    h('div', { class: 'row' }, sel), h('div', { style: 'margin-top:10px' }, pre));
};

boot();
