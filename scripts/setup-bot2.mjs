// 给第二个机器人准备独立的 NapCat 实例
//
// 一个 NapCat 只对应一个 QQ 号，所以第二个号必须有自己的一套：
//   独立的程序目录 / 独立的数据目录 / 独立的 ws 端口
// 否则两个机器人会连到同一个账号上互相抢消息。
import fs from 'node:fs';
import path from 'node:path';
import { TOOLS_DIR } from '../src/paths.js';

const SECOND_QQ = '3998561404';        // 第二台机器人（猪咪群友）
const SRC_DIR = path.join(TOOLS_DIR, 'napcat');
const DST_DIR = path.join(TOOLS_DIR, 'napcat2');
const DATA_DIR = path.join(TOOLS_DIR, 'qq-bot2-data');
const WS_PORT = 3011;

function copyDir(src, dst, skip = []) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.includes(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d, skip);
    else fs.copyFileSync(s, d);
  }
}

console.log('=== 1. 复制程序目录 ===');
if (fs.existsSync(DST_DIR)) {
  console.log(`  ${DST_DIR} 已存在，跳过复制`);
} else {
  // 不复制 cache 与账号相关配置：缓存是上一个号的，配置我们重新写
  copyDir(SRC_DIR, DST_DIR, ['cache']);
  const cfgDir = path.join(DST_DIR, 'config');
  if (fs.existsSync(cfgDir)) {
    for (const f of fs.readdirSync(cfgDir)) {
      if (f.startsWith('onebot11_') || f.startsWith('napcat_') || f.startsWith('napcat_protocol_')) {
        fs.unlinkSync(path.join(cfgDir, f));
      }
    }
  }
  console.log(`  已复制到 ${DST_DIR}`);
}

console.log('');
console.log('=== 2. 建独立数据目录 ===');
fs.mkdirSync(DATA_DIR, { recursive: true });
console.log(`  ${DATA_DIR}`);

console.log('');
console.log('=== 3. 预写 OneBot 配置（ws 端口 ' + WS_PORT + '）===');
const cfgDir = path.join(DST_DIR, 'config');
fs.mkdirSync(cfgDir, { recursive: true });
const onebot = {
  network: {
    httpServers: [],
    httpSseServers: [],
    httpClients: [],
    websocketServers: [{
      name: 'AgentXiang',
      enable: true,
      host: '127.0.0.1',
      port: WS_PORT,
      messagePostFormat: 'array',
      reportSelfMessage: false,
      token: '',
      enableForcePushEvent: true,
      debug: false,
      heartInterval: 30000,
    }],
    websocketClients: [],
    plugins: [],
  },
  musicSignUrl: '',
  enableLocalFile2Url: true,     // 语音与图片直接给本地路径
  parseMultMsg: true,            // 读合并转发必需
  imageDownloadProxy: '',
  timeout: { baseTimeout: 10000, uploadSpeedKBps: 256, downloadSpeedKBps: 256, maxTimeout: 1800000 },
};
const onebotFile = path.join(cfgDir, `onebot11_${SECOND_QQ}.json`);
fs.writeFileSync(onebotFile, JSON.stringify(onebot, null, 2), 'utf8');
console.log(`  ${path.basename(onebotFile)}`);

console.log('');
console.log('=== 4. 结果 ===');
console.log(`  程序目录  ${DST_DIR}`);
console.log(`  数据目录  ${DATA_DIR}`);
console.log(`  机器人 QQ ${SECOND_QQ}`);
console.log(`  ws 端口   ${WS_PORT}`);
console.log(`  启动命令  scripts\\napcat-start.cmd napcat2 ${SECOND_QQ} qq-bot2-data`);
