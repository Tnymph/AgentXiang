// 入口：装配全部部件并启动
import { ensureDirs } from './paths.js';
import * as log from './logger.js';
import * as db from './db.js';
import * as secrets from './secrets.js';
import { loadGlobal } from './config.js';
import { BotManager } from './manager.js';
import * as tasks from './tasks.js';
import { startServer } from './web/server.js';
import { bindManager } from './web/api.js';
import { pruneOutputs } from './modules/tts.js';

const args = new Set(process.argv.slice(2));
const DEBUG = args.has('--debug');

async function main() {
  ensureDirs();
  log.setDebug(DEBUG);
  db.openDb();

  const g = loadGlobal();
  // 让密钥在启动时就注册进打码表，避免任何日志泄漏原文
  secrets.loadSecrets();
  // 合成出来的语音只在发送那一刻需要留着，几天前的清掉（启动时清，不在发送路径上删）
  pruneOutputs(3);

  log.info('boot', 'starting', {
    debug: DEBUG,
    ui: `http://${g.ui.host}:${g.ui.port}`,
    napcat: g.napcat.wsUrl,
  });

  const manager = new BotManager();
  bindManager(manager);
  await manager.startAll();

  tasks.startHousekeeping();
  tasks.startKeepAlive();
  tasks.startImpressionExtraction();

  const server = await startServer({ host: g.ui.host, port: g.ui.port });

  const banner = [
    '',
    '  AgentXiang 已启动',
    `  界面地址   http://${g.ui.host}:${g.ui.port}`,
    `  NapCat     ${g.napcat.wsUrl}`,
    `  机器人     ${manager.instances.size} 个在运行`,
    DEBUG ? '  调试模式   开' : '',
    '',
  ].filter(Boolean).join('\n');
  console.log(banner);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('boot', 'shutting down', { signal });
    tasks.stopAll();
    await manager.stopAll();
    server.close();
    db.closeDb();
    log.closeLogs();
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('boot', 'unhandledRejection', String(e?.message ?? e)));
  process.on('uncaughtException', (e) => log.error('boot', 'uncaughtException', String(e?.message ?? e)));
}

main().catch((e) => {
  console.error('启动失败：', e);
  log.error('boot', 'failed', String(e?.stack ?? e));
  process.exit(1);
});
