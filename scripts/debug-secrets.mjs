// 诊断：为什么独立脚本读不到密钥
import fs from 'node:fs';
import { SECRETS_FILE } from '../src/paths.js';
import * as secrets from '../src/secrets.js';

console.log('IS_WIN =', process.platform === 'win32');
console.log('文件存在 =', fs.existsSync(SECRETS_FILE));

const raw = fs.readFileSync(SECRETS_FILE, 'utf8');
console.log('文件长度 =', raw.length);
console.log('前 30 字符 =', JSON.stringify(raw.slice(0, 30)));
console.log('含换行 =', raw.includes('\n'));

try {
  const text = secrets.decryptBuf(raw);
  console.log('解密结果 =', text === null ? 'null（非 Windows）' : text);
} catch (e) {
  console.log('解密抛错:', e.message);
}

console.log('');
console.log('dpapiAvailable =', secrets.dpapiAvailable());
console.log('loadSecrets() 的 bots 键 =', Object.keys(secrets.loadSecrets().bots ?? {}));
console.log('getApiKey(1) 长度 =', secrets.getApiKey(1).length);
console.log('getAccessToken 长度 =', (secrets.getAccessToken() ?? '').length);
