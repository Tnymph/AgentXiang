// 冒烟测试：路径配置（默认值 / paths.json / 环境变量 / 界面读写）
//
// 为什么单独测：默认值一处改动，全项目所有取文件的地方都会跟着动，而这里又
// 允许用户把模型挪到别的盘。配错的表现是「程序起不来」，所以默认解析、保存
// 校验、坏文件容错都得钉死。
//
// 测试会临时动真的 paths.json（这是唯一不能靠环境变量隔离的配置），
// 开头备份、finally 还原。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ROOT, PATHS_FILE, TOOLS_DIR, DATA_DIR, STYLE_DIR, INBOX_DIR, QQ_EXE,
  resolveDir, pathInfo, savePaths,
} from '../src/paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PRINT = path.join(here, 'print-dir.mjs');
const PATHS_URL = pathToFileURL(path.join(ROOT, 'src', 'paths.js')).href;

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', label, extra ? '→ ' + extra : ''); }
};

// ---------- 备份真实配置 ----------
const BACKUP = PATHS_FILE + '.smoke-backup';
const hadReal = fs.existsSync(PATHS_FILE);
if (hadReal) fs.copyFileSync(PATHS_FILE, BACKUP);
const writeRaw = (text) => fs.writeFileSync(PATHS_FILE, text, 'utf8');
const dropCfg = () => fs.rmSync(PATHS_FILE, { force: true });

/** 在干净子进程里读 paths.js：模块常量在载入时定死，同进程里换不了配置 */
const childPaths = (env = {}) => {
  const code = `import { TOOLS_DIR, DATA_DIR, STYLE_DIR, INBOX_DIR } from ${JSON.stringify(PATHS_URL)};
console.log(JSON.stringify({ TOOLS_DIR, DATA_DIR, STYLE_DIR, INBOX_DIR }))`;
  const out = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], {
    encoding: 'utf8', cwd: ROOT, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out.trim());
};

const runPrint = (arg, env = {}) => {
  const r = execFileSync(process.execPath, ['--no-warnings', PRINT, arg], {
    encoding: 'utf8', cwd: ROOT, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return r.trim();
};

const TMP_ROOTS = [path.join(ROOT, 'data', 'tmp', 'pathcfg-models'), path.join(ROOT, 'data', 'tmp', 'pathcfg-data')];
const CLEAN_ENVS = {
  AGENTXIANG_TOOLS_DIR: '', AGENTXIANG_DATA_DIR: '', AGENTXIANG_STYLE_DIR: '',
  AGENTXIANG_INBOX_DIR: '', AGENTXIANG_QQ_EXE: '',
};

try {
  // ---------- 纯函数：相对按项目根、绝对原样、空值回退 ----------
  console.log('--- resolveDir ---');
  check('相对路径按项目根算', resolveDir('sub/dir', 'F') === path.join(ROOT, 'sub', 'dir'), resolveDir('sub/dir', 'F'));
  check('绝对路径原样', resolveDir(path.resolve(ROOT, 'x'), 'F') === path.resolve(ROOT, 'x'));
  check('空串回退', resolveDir('', 'F') === 'F');
  check('空白回退', resolveDir('   ', 'F') === 'F');
  check('undefined 回退', resolveDir(undefined, 'F') === 'F');
  check('null 回退', resolveDir(null, 'F') === 'F');

  // ---------- 默认值：没有 paths.json 时，四个目录都在项目根下 ----------
  console.log('--- 默认值（无配置）---');
  dropCfg();
  {
    const p = childPaths(CLEAN_ENVS);
    check('toolsDir 默认 .tools', p.TOOLS_DIR === path.join(ROOT, '.tools'), p.TOOLS_DIR);
    check('dataDir 默认 data', p.DATA_DIR === path.join(ROOT, 'data'), p.DATA_DIR);
    check('styleDir 默认 style-samples', p.STYLE_DIR === path.join(ROOT, 'style-samples'), p.STYLE_DIR);
    check('inboxDir 默认 inbox', p.INBOX_DIR === path.join(ROOT, 'inbox'), p.INBOX_DIR);
  }

  // ---------- paths.json 生效 + 相对路径按项目根 ----------
  console.log('--- paths.json ---');
  writeRaw(JSON.stringify({ toolsDir: 'data/tmp/pathcfg-models', dataDir: 'D:\\ax-data' }));
  {
    const p = childPaths(CLEAN_ENVS);
    check('相对值按项目根解析', p.TOOLS_DIR === path.join(ROOT, 'data', 'tmp', 'pathcfg-models'), p.TOOLS_DIR);
    check('绝对值得原样用（盘符不在也照配）', p.DATA_DIR === path.resolve('D:\\ax-data'), p.DATA_DIR);
    check('没配的项仍用默认', p.STYLE_DIR === path.join(ROOT, 'style-samples'), p.STYLE_DIR);
  }

  // ---------- 环境变量优先于文件 ----------
  console.log('--- 环境变量优先 ---');
  {
    const p = childPaths({ ...CLEAN_ENVS, AGENTXIANG_TOOLS_DIR: path.join(ROOT, 'data', 'tmp', 'pathcfg-data') });
    check('env 压过 paths.json', p.TOOLS_DIR === path.join(ROOT, 'data', 'tmp', 'pathcfg-data'), p.TOOLS_DIR);
    check('其它项不受影响', p.STYLE_DIR === path.join(ROOT, 'style-samples'), p.STYLE_DIR);
  }

  // ---------- 坏文件容错：当作没有，退回默认 ----------
  console.log('--- 坏文件 ---');
  writeRaw('{ 这不是 json');
  {
    const p = childPaths(CLEAN_ENVS);
    check('坏 paths.json 不崩，退回默认', p.TOOLS_DIR === path.join(ROOT, '.tools'), p.TOOLS_DIR);
  }
  writeRaw('[]');   // 合法 JSON 但不是对象
  {
    const p = childPaths(CLEAN_ENVS);
    check('数组当空表处理', p.TOOLS_DIR === path.join(ROOT, '.tools'), p.TOOLS_DIR);
  }

  // ---------- print-dir：.cmd 靠它拿路径 ----------
  console.log('--- print-dir ---');
  dropCfg();
  {
    const one = runPrint('tools', CLEAN_ENVS);
    check('单值输出一行', one === path.join(ROOT, '.tools'), one);
    const all = runPrint('all', CLEAN_ENVS);
    const lines = all.split('\n');
    check('all 输出 6 行', lines.length === 6, String(lines.length));
    const kv = Object.fromEntries(lines.map((l) => l.split('=').slice(0, 2)));
    check('all 的 key 固定', ['ROOT', 'TOOLS', 'DATA', 'STYLE', 'INBOX', 'QQ'].every((k) => k in kv), lines.join(' | '));
    check('all 的 tools 值正确', kv.TOOLS === path.join(ROOT, '.tools'), kv.TOOLS);
    let threw = false;
    try { runPrint('bogus', CLEAN_ENVS); } catch { threw = true; }
    check('未知键非零退出', threw);
  }

  // ---------- savePaths：写、删、校验、保留未知字段 ----------
  console.log('--- savePaths ---');
  dropCfg();
  writeRaw(JSON.stringify({ note: '手写的说明', toolsDir: 'data/tmp/pathcfg-models' }));
  {
    const r = savePaths({ dataDir: 'data/tmp/pathcfg-data' });
    check('保存成功', r.ok === true, r.error ?? '');
    check('目标目录被建出来', fs.existsSync(path.join(ROOT, 'data', 'tmp', 'pathcfg-data')));
    const onDisk = JSON.parse(fs.readFileSync(PATHS_FILE, 'utf8'));
    check('新值写进文件', onDisk.dataDir === 'data/tmp/pathcfg-data', onDisk.dataDir);
    check('不认识的字段保留', onDisk.note === '手写的说明', String(onDisk.note));
    check('没动的字段保留', onDisk.toolsDir === 'data/tmp/pathcfg-models', String(onDisk.toolsDir));

    const info = pathInfo();
    const dataDir = info.dirs.find((d) => d.key === 'dataDir');
    check('pathInfo.configured 是刚写的值', dataDir.configured === path.join(ROOT, 'data', 'tmp', 'pathcfg-data'), dataDir.configured);
    check('pathInfo.value 仍是本进程在用的值', dataDir.value === DATA_DIR, dataDir.value);
    check('pending 标出「待重启生效」', dataDir.pending === (dataDir.configured !== DATA_DIR));
    check('custom 标记为真', dataDir.custom === true);
    const toolsDir = info.dirs.find((d) => d.key === 'toolsDir');
    check('未保存改动过的项 custom 也为真', toolsDir.custom === true);
    check('qqExe 也在信息里', typeof info.qqExe.value === 'string' && info.qqExe.value.length > 0, info.qqExe.value);
    check('派生位置清单非空', Array.isArray(info.derived) && info.derived.length >= 5, String(info.derived?.length));
    check('配置文件路径就是项目根的 paths.json', info.file === PATHS_FILE, info.file);

    // 空串 = 删字段 = 恢复默认
    const r2 = savePaths({ toolsDir: '' });
    check('空串保存成功', r2.ok === true, r2.error ?? '');
    const onDisk2 = JSON.parse(fs.readFileSync(PATHS_FILE, 'utf8'));
    check('toolsDir 字段被删（= 默认）', !('toolsDir' in onDisk2), JSON.stringify(onDisk2));

    // 非法值：建不出目录的路径不许写进去
    const before = fs.readFileSync(PATHS_FILE, 'utf8');
    const r3 = savePaths({ styleDir: 'bad\u0000dir' });
    check('非法路径被拒', r3.ok === false && String(r3.error).length > 0, String(r3.error));
    check('被拒时文件一个字节都没动', fs.readFileSync(PATHS_FILE, 'utf8') === before);
  }

  // ---------- 当前进程的默认值就是项目根（没被上面测试带偏） ----------
  console.log('--- 本进程现状 ---');
  check('本进程 dataDir 与导出常量一致', pathInfo().dirs.find((d) => d.key === 'dataDir').value === DATA_DIR);
  check('导出的四个常量都是绝对路径', [TOOLS_DIR, DATA_DIR, STYLE_DIR, INBOX_DIR].every((p) => path.isAbsolute(p)));
  check('QQ_EXE 有默认值', typeof QQ_EXE === 'string' && QQ_EXE.length > 0, QQ_EXE);
} finally {
  // ---------- 还原真实配置，清掉测试建的目录 ----------
  try {
    if (hadReal) fs.copyFileSync(BACKUP, PATHS_FILE);
    else dropCfg();
    fs.rmSync(BACKUP, { force: true });
    for (const d of TMP_ROOTS) fs.rmSync(d, { recursive: true, force: true });
  } catch (e) {
    console.log('  清理失败（要手动看一眼）：', e.message);
    fail++;
  }
}

console.log(`结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
