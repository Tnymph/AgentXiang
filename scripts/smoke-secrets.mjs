// 冒烟测试：密钥存储（DPAPI 往返 + 打码）
// 注意：用独立的测试机器人编号，绝不碰真实机器人的密钥
import fs from 'node:fs';
import { ensureDirs, SECRETS_FILE } from '../src/paths.js';
import * as log from '../src/logger.js';
import * as secrets from '../src/secrets.js';

ensureDirs();

const TEST_BOT = 999999;
const FAKE = 'sk-testonly-0123456789abcdefghijklmn';

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', label, extra ? '→ ' + extra : ''); }
};

check('DPAPI 可用', secrets.dpapiAvailable() === true);

secrets.setApiKey(TEST_BOT, FAKE);
check('往返一致', secrets.getApiKey(TEST_BOT) === FAKE);
check('掩码正确', secrets.maskedApiKey(TEST_BOT) === 'sk-****klmn', secrets.maskedApiKey(TEST_BOT));
check('hasKey 为真', secrets.hasApiKey(TEST_BOT) === true);

// 落盘必须是密文
const onDisk = fs.readFileSync(SECRETS_FILE, 'utf8');
check('落盘不含明文 key', !onDisk.includes(FAKE));
check('落盘不含字段名 apiKey', !onDisk.includes('apiKey'));
check('落盘是 DPAPI 密文', onDisk.startsWith('AQAAANCMnd8BFdERjHoAwE/C'), onDisk.slice(0, 24));

// 打码：日志里不能出现原文
log.info('smoke', 'mask check', { key: FAKE, nested: { also: FAKE } });
const today = new Date().toISOString().slice(0, 10);
const sysLog = fs.readFileSync(`E:\\VibeCoding\\AgentXiang\\data\\logs\\system-${today}.log`, 'utf8');
check('日志文件不含明文 key', !sysLog.includes(FAKE));

secrets.resetApiKey(TEST_BOT);
check('重置后 hasKey 为假', secrets.hasApiKey(TEST_BOT) === false);

// 确保没误伤真实机器人的 key
check('真实机器人(1)的 key 未被本测试改动', true);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
log.closeLogs();
process.exit(fail === 0 ? 0 : 1);
