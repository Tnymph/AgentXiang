// 多机器人管理：按「本机启用」开关拉起各自的 OneBot 连接与处理管线
import * as db from './db.js';
import * as log from './logger.js';
import * as secrets from './secrets.js';
import { OneBot } from './onebot.js';
import { BotWorker } from './pipeline.js';
import { loadGlobal, botSettings } from './config.js';

export class BotManager {
  constructor() {
    this.instances = new Map();   // botId -> { bot, client, worker }
    this.stopping = false;
  }

  /** 拉起所有「本机启用」且有 QQ 号的机器人 */
  async startAll() {
    const bots = db.listBots().filter((b) => Number(b.enabled_local) === 1 && b.qq);
    log.info('manager', 'starting bots', { total: db.listBots().length, enabled: bots.length });
    for (const bot of bots) {
      await this.startOne(bot.id);
    }
  }

  async startOne(botId) {
    if (this.instances.has(botId)) return this.instances.get(botId);
    const bot = db.getBot(botId);
    if (!bot) throw new Error('机器人不存在');

    const g = loadGlobal();
    const settings = botSettings(botId);
    // 每个机器人可以有自己的 NapCat 地址：一个 NapCat 实例只对应一个 QQ 号。
    // 没单独配就用全局的（单机器人场景下没人会去配）。
    const wsUrl = settings.napcatWsUrl || g.napcat.wsUrl;

    const client = new OneBot({
      botId, url: wsUrl, accessToken: secrets.getAccessToken(), name: bot.name,
    });
    const worker = new BotWorker({ bot, client });

    client.on('ready', async ({ selfId }) => { await worker.onReady(selfId); });
    client.on('message', (event) => {
      worker.onMessage(event).catch((e) => log.error('manager', '处理消息抛错', { botId, err: String(e.message) }));
    });
    client.on('connected', () => log.info('manager', 'bot connected', { botId, name: bot.name, url: wsUrl }));
    client.on('disconnected', () => log.warn('manager', 'bot disconnected', { botId, name: bot.name }));

    client.connect();
    const inst = { bot, client, worker, wsUrl };
    this.instances.set(botId, inst);
    log.info('manager', 'bot started', { botId, name: bot.name, qq: bot.qq, url: wsUrl });
    return inst;
  }

  async stopOne(botId) {
    const inst = this.instances.get(botId);
    if (!inst) return;
    inst.client.close();
    this.instances.delete(botId);
    log.info('manager', 'bot stopped', { botId });
  }

  async stopAll() {
    this.stopping = true;
    for (const id of [...this.instances.keys()]) {
      await this.stopOne(id);
    }
  }

  /** 重启（改完连接参数后用） */
  async restartOne(botId) {
    await this.stopOne(botId);
    const bot = db.getBot(botId);
    if (bot && Number(bot.enabled_local) === 1 && bot.qq) await this.startOne(botId);
  }

  /** 界面展示用的实时状态 */
  status() {
    return db.listBots().map((b) => {
      const inst = this.instances.get(b.id);
      const settings = botSettings(b.id);
      return {
        id: b.id,
        name: b.name,
        qq: b.qq,
        enabledLocal: Number(b.enabled_local) === 1,
        running: !!inst,
        connected: !!inst?.client?.connected,
        selfId: inst?.client?.selfId ?? null,
        nicknames: inst?.worker?.nicknames ?? [],
        apiMode: settings.api.mode,
        hasApiKey: secrets.hasApiKey(b.id),
        apiKeyMasked: secrets.maskedApiKey(b.id),
      };
    });
  }
}
