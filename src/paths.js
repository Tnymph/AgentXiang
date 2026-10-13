// 路径：全项目只有这里定义目录结构；四个根目录可以换地方（模型放别的盘也行）。
//
// 取值顺序（前面的赢）：
//   1. 环境变量  AGENTXIANG_TOOLS_DIR / _DATA_DIR / _STYLE_DIR / _INBOX_DIR
//   2. paths.json（项目根，界面上「路径」卡片可改，也可以手写）
//   3. 内置默认  项目根下的 .tools / data / style-samples / inbox
//
// 值可以写绝对路径（放到别的盘）或相对项目根的路径。空值 = 用默认。
// 换完要**整个重启程序**才生效：这里是模块常量，载入时就定死了 ——
// 和「重启的是程序、不是机器人」那条老规矩是同一件事。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 项目根：本文件在 src/ 下，上一层就是根 */
export const ROOT = path.resolve(here, '..');

/** 引导文件：路径配置自己不能被配置，所以它固定在项目根 */
export const PATHS_FILE = path.join(ROOT, 'paths.json');

/** 可自定义的四个根目录；key 就是 paths.json 里的字段名，也是界面上的一行 */
export const DIRS = [
  {
    key: 'toolsDir', label: '模型与工具', def: '.tools', env: 'AGENTXIANG_TOOLS_DIR',
    hint: '引擎程序、模型、音色、NapCat、Python 环境',
  },
  {
    key: 'dataDir', label: '运行数据', def: 'data', env: 'AGENTXIANG_DATA_DIR',
    hint: '数据库、密钥、配置、日志、临时文件',
  },
  {
    key: 'styleDir', label: '学习素材', def: 'style-samples', env: 'AGENTXIANG_STYLE_DIR',
    hint: '语音转写、风格样本、人设笔记、热词表',
  },
  {
    key: 'inboxDir', label: '日志同步箱', def: 'inbox', env: 'AGENTXIANG_INBOX_DIR',
    hint: '导出的日志，供手动拷贝',
  },
];

/** QQ 程序的位置（只有 Windows 上启动 NapCat 时用得到） */
const QQ_DEF = 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe';

/** 读 paths.json：坏了或没有都退回空表，绝不让配置问题把程序带崩 */
function readPathsFile() {
  try {
    if (!fs.existsSync(PATHS_FILE)) return {};
    const j = JSON.parse(fs.readFileSync(PATHS_FILE, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch (e) {
    console.warn(`[paths] paths.json 读不了（${e.message}），这次全部用默认位置`);
    return {};
  }
}
const fileCfg = readPathsFile();

/** 相对路径按项目根算，绝对路径原样用 */
export function resolveDir(v, fallback) {
  const s = String(v ?? '').trim();
  if (!s) return fallback;
  return path.isAbsolute(s) ? path.resolve(s) : path.resolve(ROOT, s);
}

/** 环境变量优先于 paths.json */
function rawValue(d) {
  const env = process.env[d.env];
  return typeof env === 'string' && env.trim() !== '' ? env : fileCfg[d.key];
}

const VALUES = {};
for (const d of DIRS) VALUES[d.key] = resolveDir(rawValue(d), path.join(ROOT, d.def));
VALUES.qqExe = resolveDir((() => {
  const env = process.env.AGENTXIANG_QQ_EXE;
  return typeof env === 'string' && env.trim() !== '' ? env : fileCfg.qqExe;
})(), QQ_DEF);

export const TOOLS_DIR = VALUES.toolsDir;
export const DATA_DIR = VALUES.dataDir;
export const STYLE_DIR = VALUES.styleDir;
export const INBOX_DIR = VALUES.inboxDir;
export const QQ_EXE = VALUES.qqExe;

export const LOGS_DIR = path.join(DATA_DIR, 'logs');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json.enc');
export const DB_FILE = path.join(DATA_DIR, 'agentxiang.sqlite');

export const TRANSCRIPT_DIR = path.join(STYLE_DIR, 'transcript');
export const SAMPLES_FILE = path.join(STYLE_DIR, 'samples.txt');
export const NOTES_FILE = path.join(STYLE_DIR, 'notes.txt');
export const HOTWORDS_FILE = path.join(STYLE_DIR, 'hotwords.txt');

export const INBOX_LOGS = path.join(INBOX_DIR, 'logs');
export const INBOX_SYNC = path.join(INBOX_DIR, 'sync');

/** 建齐运行期需要的目录 */
export function ensureDirs() {
  for (const d of [DATA_DIR, LOGS_DIR, TMP_DIR, INBOX_DIR, INBOX_LOGS, INBOX_SYNC]) {
    try {
      fs.mkdirSync(d, { recursive: true });
    } catch (e) {
      throw new Error(`建不出目录 ${d}：${e.message}（路径在 paths.json 或「路径」页里改过？）`);
    }
  }
}

// ---------- 给界面用的读写 ----------

const isSet = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * 界面上的全景。三个值要分清，不然「改完保存了但看起来没变」：
 *   value      这个进程现在实际在用的（重启才换）
 *   configured 配置里写着的（保存后立刻变成新值）
 *   pending    configured 与 value 不一致 = 等着重启生效
 */
export function pathInfo() {
  const cur = readPathsFile();   // 现读一遍：保存动作刚改过它
  const one = (d) => {
    const env = process.env[d.env];
    const fromEnv = isSet(env);
    const raw = fromEnv ? env : cur[d.key];
    const def = d.fallback ?? path.join(ROOT, d.def);
    const configured = resolveDir(raw, def);
    return {
      key: d.key, label: d.label, hint: d.hint,
      value: VALUES[d.key],
      configured,
      pending: configured !== VALUES[d.key],
      def,
      envName: d.env,
      fromEnv,
      custom: isSet(raw),
      exists: fs.existsSync(VALUES[d.key]),
    };
  };
  const dirs = DIRS.map(one);
  return {
    file: PATHS_FILE,
    root: ROOT,
    dirs,
    qqExe: one({
      key: 'qqExe', label: 'QQ 程序', env: 'AGENTXIANG_QQ_EXE', fallback: QQ_DEF,
      hint: 'NapCat 借它启动；QQ 装在别处时改这里',
    }),
    // 只读展示，让「改一个大目录 = 整体搬家」这件事看得见
    derived: [
      { label: '语音识别模型', value: path.join(TOOLS_DIR, 'model-sense-voice') },
      { label: 'sherpa 引擎', value: path.join(TOOLS_DIR, 'sherpa') },
      { label: '合成音色', value: path.join(TOOLS_DIR, 'tts') },
      { label: 'CosyVoice 音色', value: path.join(TOOLS_DIR, 'cosy-voices') },
      { label: '变声音色', value: path.join(TOOLS_DIR, 'rvc-voices') },
      { label: 'NapCat', value: path.join(TOOLS_DIR, 'napcat') },
      { label: '数据库', value: DB_FILE },
      { label: '素材转写', value: TRANSCRIPT_DIR },
    ],
  };
}

/**
 * 写回 paths.json。
 *   - 空串 = 删掉该字段，恢复默认
 *   - 写之前先试建目录：建不出来就整个不写（免得存进去一个起不来的路径）
 *   - 重新读一遍文件再合并，保留手写过的、我们不认识的字段
 */
export function savePaths(patch = {}) {
  const cur = readPathsFile();
  const next = { ...cur };
  const errors = [];

  for (const d of DIRS) {
    if (!(d.key in patch)) continue;
    const v = String(patch[d.key] ?? '').trim();
    if (!v) { delete next[d.key]; continue; }
    const abs = resolveDir(v, '');
    try {
      fs.mkdirSync(abs, { recursive: true });
    } catch (e) {
      errors.push(`${d.label}建不出来（${abs}）：${e.message}`);
      continue;
    }
    next[d.key] = v;
  }

  if ('qqExe' in patch) {
    const v = String(patch.qqExe ?? '').trim();
    // QQ 路径不建目录：还没装 QQ 的时候也不该拦着保存
    if (!v) delete next.qqExe; else next.qqExe = v;
  }

  if (errors.length) return { ok: false, error: errors.join('；') };
  try {
    fs.writeFileSync(PATHS_FILE, Object.keys(next).length ? JSON.stringify(next, null, 2) + '\n' : '{}\n', 'utf8');
  } catch (e) {
    return { ok: false, error: `paths.json 写不进去：${e.message}` };
  }
  return { ok: true, file: PATHS_FILE };
}
