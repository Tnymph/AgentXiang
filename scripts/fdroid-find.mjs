// 从 F-Droid 的 index-v1.json 里查某个 App 的 APK 文件名和下载地址
//
//   node --no-warnings scripts/fdroid-find.mjs <index-v1.json 路径> [镜像地址] [包名关键词]
//
// 用途：国内直连 f-droid.org 基本不通，改用清华/中科大镜像。但镜像上是标准仓库
// （没有文件列表页），APK 的真实文件名只能从索引里读，不能猜。
//
// 索引结构（index-v1.json）：
//   apps:     [ { packageName, name, ... } ]          —— 应用元信息
//   packages: { "<包名>": [ { apkName, versionCode, versionName, size } ] }  —— 注意是对象，不是数组
//
// 例：
//   node --no-warnings scripts/fdroid-find.mjs %TEMP%\fdroid-index\index-v1.json
import fs from 'node:fs';

const file = process.argv[2];
const mirror = (process.argv[3] ?? 'https://mirrors.tuna.tsinghua.edu.cn/fdroid/repo').replace(/\/+$/, '');
const keyword = process.argv[4] ?? 'termux';
if (!file) {
  console.error('用法：node scripts/fdroid-find.mjs <index-v1.json> [镜像地址] [关键词]');
  process.exit(2);
}

console.log('读索引 …');
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));

const appsMeta = Array.isArray(raw.apps) ? raw.apps : [];
const nameOf = new Map(appsMeta.map((a) => [String(a.packageName ?? ''), String(a.name ?? '')]));

// packages 是「包名 → APK 列表」的对象；也兼容 apps[] 里各自带 packages[] 的写法
const byPkg = new Map();
const obj = raw.packages && typeof raw.packages === 'object' && !Array.isArray(raw.packages) ? raw.packages : null;
if (obj) for (const [k, v] of Object.entries(obj)) if (Array.isArray(v)) byPkg.set(k, v);
for (const a of appsMeta) if (Array.isArray(a.packages)) byPkg.set(String(a.packageName ?? ''), a.packages);

const re = new RegExp(keyword, 'i');
const rows = [];
for (const [pkg, list] of byPkg) {
  if (!re.test(pkg) || !list.length) continue;
  const newest = list.reduce((best, p) => (Number(p.versionCode) > Number(best.versionCode) ? p : best));
  rows.push({
    pkg,
    name: nameOf.get(pkg) ?? '',
    versionName: String(newest.versionName ?? ''),
    versionCode: Number(newest.versionCode),
    apkName: String(newest.apkName ?? ''),
    sizeMB: (Number(newest.size ?? 0) / 1024 / 1024).toFixed(1),
    url: mirror + '/' + String(newest.apkName ?? ''),
  });
}
rows.sort((x, y) => x.pkg.localeCompare(y.pkg));

console.log(`索引里 ${byPkg.size} 个包，匹配「${keyword}」的 ${rows.length} 个：`);
console.log('');
for (const r of rows) {
  console.log(`${r.pkg}  ${r.name}`);
  console.log(`  版本 ${r.versionName}（versionCode ${r.versionCode}）  大小 ${r.sizeMB}MB`);
  console.log(`  ${r.url}`);
  console.log('');
}
if (rows.length) console.log('下载：curl -o 文件名.apk "<上面的链接>"');
