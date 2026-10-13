// 把 NapCat 的 OneBot 配置调成 AgentXiang 需要的样子
//
// 做三件事：
//  1. 开一个 websocket 服务在 127.0.0.1:3001（本程序默认连这里），只绑本机
//  2. parseMultMsg = true —— 不开这个读不到合并转发的内部节点
//  3. enableLocalFile2Url = true —— 语音/图片能直接给本地文件路径，省一次下载
//
// 可重复运行，已经配好就只报告不改动。
import fs from 'node:fs';
import path from 'node:path';
import { TOOLS_DIR } from '../src/paths.js';

const NAPCAT_CONFIG_DIR = path.join(TOOLS_DIR, 'napcat', 'config');
const WS_HOST = '127.0.0.1';
const WS_PORT = 3001;

function findOneBotConfig() {
  if (!fs.existsSync(NAPCAT_CONFIG_DIR)) return null;
  const files = fs.readdirSync(NAPCAT_CONFIG_DIR).filter((f) => /^onebot11_\d+\.json$/.test(f));
  if (files.length === 0) return null;
  // 有多个就取最近改动的那个
  return files
    .map((f) => ({ f, t: fs.statSync(path.join(NAPCAT_CONFIG_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0].f;
}

function main() {
  const name = findOneBotConfig();
  if (!name) {
    console.error('没找到 onebot11_*.json。先启动 NapCat 并完成登录，配置文件才会生成。');
    process.exit(1);
  }
  const full = path.join(NAPCAT_CONFIG_DIR, name);
  const qq = name.match(/onebot11_(\d+)\.json/)[1];
  const cfg = JSON.parse(fs.readFileSync(full, 'utf8'));
  cfg.network ??= {};
  const changes = [];

  // 1) websocket 服务
  cfg.network.websocketServers ??= [];
  const want = cfg.network.websocketServers.find((s) => Number(s.port) === WS_PORT);
  if (!want) {
    cfg.network.websocketServers.push({
      name: 'AgentXiang',
      enable: true,
      host: WS_HOST,
      port: WS_PORT,
      messagePostFormat: 'array',
      reportSelfMessage: false,
      token: '',
      enableForcePushEvent: true,
      debug: false,
      heartInterval: 30000,
    });
    changes.push(`新增 websocket 服务 ${WS_HOST}:${WS_PORT}`);
  } else if (!want.enable) {
    want.enable = true;
    changes.push('启用已有的 websocket 服务');
  }

  // 2) 合并转发解析：不开这个读不到转发消息的内部节点
  if (cfg.parseMultMsg !== true) {
    cfg.parseMultMsg = true;
    changes.push('parseMultMsg -> true（读取合并转发所需）');
  }

  // 3) 本地文件直链：语音与图片直接给本地路径
  if (cfg.enableLocalFile2Url !== true) {
    cfg.enableLocalFile2Url = true;
    changes.push('enableLocalFile2Url -> true（媒体文件直取本地路径）');
  }

  if (changes.length === 0) {
    console.log(`配置已经是目标状态（QQ ${qq}，${name}）`);
    return;
  }
  fs.writeFileSync(full, JSON.stringify(cfg, null, 2), 'utf8');
  console.log(`已更新 ${name}（QQ ${qq}）：`);
  for (const c of changes) console.log('  · ' + c);
  console.log('\nNapCat 需要重启才能让新配置生效。');
}

main();
