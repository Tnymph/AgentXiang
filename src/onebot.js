// OneBot 11 连接层（对接 NapCat）
//
// 职责边界：只管「连上、收发、重连」，不做任何业务判断。
// 业务逻辑全部在 pipeline 与 modules 里。
import { randomInt } from 'node:crypto';
import * as log from './logger.js';
import { assertEndpoint } from './net.js';

const DEFAULT_TIMEOUT = 15000;
// 建连看门狗：超过这么久还没 open，就当作连不上，关掉它重试。
// 必须要有这一条 —— 实测连接被悄悄掐断时，Node 的 WebSocket 可以一声不响地
// 挂很久（既不触发 error 也不触发 close），只等事件就会永远停在「未连接」。
const CONNECT_TIMEOUT = 8000;

/** 极简事件总线 */
class Emitter {
  constructor() { this.handlers = new Map(); }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  emit(type, payload) {
    for (const fn of this.handlers.get(type) ?? []) {
      try { fn(payload); } catch (e) { log.error('onebot', 'handler 抛错', { type, err: String(e.message) }); }
    }
  }
}

export class OneBot extends Emitter {
  constructor({ botId, url, accessToken = '', name = '' }) {
    super();
    this.botId = botId;
    this.name = name;
    this.rawUrl = url;
    this.accessToken = accessToken;
    this.ws = null;
    this.connected = false;
    this.selfId = null;
    this.pending = new Map();      // echo -> { resolve, reject, timer }
    this.seq = 0;
    this.retry = 0;
    this.closedByUser = false;
    this.reconnectTimer = null;
    this.watchdog = null;
  }

  /** 建连看门狗：到点还没连上就关掉重试，别指望事件一定会来 */
  armWatchdog() {
    this.disarmWatchdog();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.connected || this.closedByUser) return;
      log.warn('onebot', 'connect timeout, will retry', { bot: this.botId, afterMs: CONNECT_TIMEOUT });
      try { this.ws?.close(); } catch { /* 忽略 */ }
      this.scheduleReconnect();
    }, CONNECT_TIMEOUT);
  }

  disarmWatchdog() {
    if (this.watchdog) { clearTimeout(this.watchdog); this.watchdog = null; }
  }

  /** 建立连接；断线会自动重连 */
  connect() {
    this.closedByUser = false;
    const u = assertEndpoint(this.rawUrl);
    // 令牌走查询参数：OneBot 的通行做法，也避开浏览器 WebSocket API
    // 不支持自定义请求头的问题（第二个参数是子协议名，不是选项对象）。
    if (this.accessToken) u.searchParams.set('access_token', this.accessToken);

    log.info('onebot', 'connecting', { bot: this.botId, url: u.origin + u.pathname });

    let ws;
    try {
      ws = new WebSocket(u.href);
    } catch (e) {
      log.error('onebot', 'WebSocket 构造失败', String(e.message));
      return this.scheduleReconnect();
    }
    this.ws = ws;
    this.armWatchdog();

    ws.addEventListener('open', () => {
      this.connected = true;
      this.retry = 0;
      this.disarmWatchdog();
      log.info('onebot', 'connected', { bot: this.botId });
      this.emit('connected', { botId: this.botId });
    });

    ws.addEventListener('message', (ev) => {
      let data;
      try { data = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); }
      catch { return; }
      this.dispatch(data);
    });

    ws.addEventListener('close', (ev) => {
      this.connected = false;
      this.disarmWatchdog();
      log.warn('onebot', 'closed', { bot: this.botId, code: ev.code, reason: ev.reason });
      this.emit('disconnected', { botId: this.botId });
      this.failAllPending('连接已断开');
      if (!this.closedByUser) this.scheduleReconnect();
    });

    ws.addEventListener('error', (ev) => {
      log.warn('onebot', 'socket error', { bot: this.botId, msg: String(ev.message ?? '') });
      // 握手被拒时（NapCat 还没起来、或者 QQ 还没登录）浏览器规范只保证触发 error，
      // close 不一定会来 —— 只挂 close 的话，第一次连不上就永远卡住，界面一直显示
      // 「未连接」，等多久都不会自己好。所以这里补一条：还没连上就安排重连。
      // 已经连上时的 error 不在这里处理，交给随后的 close，免得两个 socket 并存。
      if (!this.closedByUser && !this.connected) this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.closedByUser || this.reconnectTimer) return;
    const wait = Math.min(1000 * 2 ** this.retry, 60000) + randomInt(0, 800);
    this.retry++;
    log.info('onebot', 'reconnect scheduled', { bot: this.botId, waitMs: wait, attempt: this.retry });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
  }

  close() {
    this.closedByUser = true;
    this.disarmWatchdog();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { this.ws?.close(); } catch { /* 忽略 */ }
    this.connected = false;
  }

  // ---------- 收发 ----------

  dispatch(data) {
    // 回包：带 echo
    if (data.echo !== undefined && data.echo !== null) {
      const p = this.pending.get(String(data.echo));
      if (p) {
        this.pending.delete(String(data.echo));
        clearTimeout(p.timer);
        if (data.status === 'failed' || data.retcode !== 0) {
          p.reject(new Error(data.message || `retcode=${data.retcode}`));
        } else {
          p.resolve(data.data);
        }
      }
      return;
    }

    // 生命周期
    if (data.post_type === 'meta_event') {
      if (data.meta_event_type === 'lifecycle' && data.sub_type === 'connect') {
        this.selfId = String(data.self_id ?? '');
        log.info('onebot', 'lifecycle connect', { bot: this.botId, selfId: this.selfId });
        this.emit('ready', { botId: this.botId, selfId: this.selfId });
      }
      return;
    }

    if (data.post_type === 'message') {
      this.emit('message', data);
      return;
    }

    if (data.post_type === 'notice') {
      this.emit('notice', data);
      return;
    }

    if (data.post_type === 'request') {
      this.emit('request', data);
      return;
    }
  }

  /** 调用一个 OneBot API */
  call(action, params = {}, timeoutMs = DEFAULT_TIMEOUT) {
    if (!this.connected || !this.ws) {
      return Promise.reject(new Error('未连接到 NapCat'));
    }
    const echo = `${this.botId}-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`API 超时: ${action}`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ action, params, echo }));
      } catch (e) {
        this.pending.delete(echo);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  failAllPending(reason) {
    for (const [echo, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(echo);
    }
  }

  // ---------- 常用动作 ----------

  sendGroupMsg(groupId, message) {
    return this.call('send_group_msg', { group_id: Number(groupId), message });
  }

  sendPrivateMsg(userId, message) {
    return this.call('send_private_msg', { user_id: Number(userId), message });
  }

  /** 按会话类型自动选发送接口 */
  sendTo(kind, peerId, message) {
    return kind === 'group' ? this.sendGroupMsg(peerId, message) : this.sendPrivateMsg(peerId, message);
  }

  deleteMsg(messageId) {
    return this.call('delete_msg', { message_id: Number(messageId) });
  }

  getMsg(messageId) {
    return this.call('get_msg', { message_id: Number(messageId) });
  }

  getForwardMsg(forwardId) {
    return this.call('get_forward_msg', { id: String(forwardId) }, 30000);
  }

  /** 取语音条的可解码地址（NapCat 会转码成通用格式） */
  getRecord(file, outFormat = 'mp3') {
    return this.call('get_record', { file, out_format: outFormat }, 30000);
  }

  getGroupMemberInfo(groupId, userId) {
    return this.call('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId) });
  }

  /** 取本机登录号的信息（用于拿到昵称） */
  getLoginInfo() {
    return this.call('get_login_info', {}, 10000);
  }
}
