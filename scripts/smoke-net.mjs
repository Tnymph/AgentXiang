// 冒烟测试：URL 安全校验
import { isPrivateIp, isPrivateIpv4, isPrivateIpv6, assertRemoteUrl, assertEndpoint } from '../src/net.js';
import * as log from '../src/logger.js';

let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL:', label); } };

console.log('--- IP 判定 ---');
check('127.0.0.1 私有', isPrivateIp('127.0.0.1'));
check('10.0.0.5 私有', isPrivateIp('10.0.0.5'));
check('192.168.1.1 私有', isPrivateIp('192.168.1.1'));
check('172.16.0.1 私有', isPrivateIp('172.16.0.1'));
check('172.32.0.1 公网', !isPrivateIp('172.32.0.1'));
check('169.254.1.1 私有', isPrivateIp('169.254.1.1'));
check('100.64.0.1 私有', isPrivateIp('100.64.0.1'));
check('0.0.0.0 私有', isPrivateIp('0.0.0.0'));
check('224.0.0.1 私有', isPrivateIp('224.0.0.1'));
check('8.8.8.8 公网', !isPrivateIp('8.8.8.8'));
check('1.1.1.1 公网', !isPrivateIp('1.1.1.1'));
check('::1 私有', isPrivateIp('::1'));
check('fe80::1 私有', isPrivateIp('fe80::1'));
check('fc00::1 私有', isPrivateIp('fc00::1'));
check('::ffff:127.0.0.1 私有', isPrivateIp('::ffff:127.0.0.1'));
check('2606:4700::1111 公网', !isPrivateIp('2606:4700::1111'));

console.log('--- assertRemoteUrl（不可信来源，应拒绝内网）---');
const cases = [
  ['http://127.0.0.1/x', false],
  ['http://localhost/x', false],
  ['https://192.168.1.1/x', false],
  ['file:///C:/x', false],
  ['ftp://example.com/x', false],
  ['https://1.1.1.1/x', true],
];
for (const [u, shouldPass] of cases) {
  let ok = true, reason = '';
  try { await assertRemoteUrl(u); } catch (e) { ok = false; reason = e.message; }
  check(`${u} -> ${shouldPass ? '放行' : '拒绝'}`, ok === shouldPass);
  if (ok !== shouldPass) console.log('   ', u, '->', ok, reason);
}

console.log('--- assertEndpoint（管理员配置，应放行本地）---');
const epCases = [
  ['http://127.0.0.1:6188', true],
  ['ws://127.0.0.1:3001', true],
  ['wss://example.com/ws', true],
  ['https://api.deepseek.com/v1', true],
  ['file:///etc/passwd', false],
];
for (const [u, shouldPass] of epCases) {
  let ok = true, reason = '';
  try { assertEndpoint(u); } catch (e) { ok = false; reason = e.message; }
  check(`${u} -> ${shouldPass ? '放行' : '拒绝'}`, ok === shouldPass);
  if (ok !== shouldPass) console.log('   ', u, '->', ok, reason);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
log.closeLogs();
