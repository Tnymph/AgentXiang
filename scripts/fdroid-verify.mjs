// 校验下载到的 APK 跟 F-Droid 索引里记录的是不是同一个文件
//
//   node --no-warnings scripts/fdroid-verify.mjs <index-v1.json> <apk 文件...>
//
// 做法：算出文件的 sha256，去索引里反查。查到 → 这个文件确实是 F-Droid 发布的那个版本；
// 查不到 → 可能是别的版本，或者下载过程被改过，别装。
import fs from 'node:fs';
import crypto from 'node:crypto';

const [indexPath, ...apks] = process.argv.slice(2);
if (!indexPath || !apks.length) {
  console.error('用法：node scripts/fdroid-verify.mjs <index-v1.json> <apk 文件...>');
  process.exit(2);
}

const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
const byHash = new Map();
for (const [pkg, list] of Object.entries(index.packages ?? {})) {
  for (const p of Array.isArray(list) ? list : []) {
    if (p.hash) byHash.set(String(p.hash).toLowerCase(), { pkg, ...p });
  }
}

let bad = 0;
for (const f of apks) {
  const buf = fs.readFileSync(f);
  const sizeMB = (buf.length / 1048576).toFixed(1);
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b; // APK 本身是 zip，开头是 "PK"
  if (!isZip) {
    console.log(`✗ ${f}  不是 APK（开头不是 PK）`);
    bad++;
    continue;
  }
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const hit = byHash.get(sha);
  if (!hit) {
    console.log(`✗ ${f}（${sizeMB}MB）sha256 在索引里查不到 —— 别装，重新下`);
    console.log(`   实测 sha256 ${sha}`);
    bad++;
    continue;
  }
  console.log(`✓ ${f}（${sizeMB}MB）`);
  console.log(`   索引里对应：${hit.pkg} ${hit.versionName}（versionCode ${hit.versionCode}）`);
  console.log(`   sha256 一致：${sha.slice(0, 32)}…`);
}

console.log('');
console.log(bad ? `${bad} 个文件有问题` : `${apks.length} 个文件全部与索引一致`);
process.exit(bad ? 1 : 0);
