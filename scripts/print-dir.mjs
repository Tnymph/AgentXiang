// 给 .cmd 脚本用：把路径配置打印出来（cmd 的 for /f 捕获 stdout）。
// 这样启动脚本永远跟着 paths.json 走，不用在批处理里手写目录名。
// 用法: node --no-warnings scripts/print-dir.mjs tools|data|style|inbox|qq|root|all
import { TOOLS_DIR, DATA_DIR, STYLE_DIR, INBOX_DIR, QQ_EXE, ROOT } from '../src/paths.js';

const map = {
  root: ROOT,
  tools: TOOLS_DIR,
  data: DATA_DIR,
  style: STYLE_DIR,
  inbox: INBOX_DIR,
  qq: QQ_EXE,
};

const key = String(process.argv[2] ?? '').trim();

// all = 一次全给，键名大写：批处理里 for /f "tokens=1,* delims==" 一行就能收完
if (key === 'all') {
  for (const [k, v] of Object.entries(map)) process.stdout.write(`${k.toUpperCase()}=${v}\n`);
} else {
  const v = map[key];
  if (!v) {
    process.stderr.write(`用法: node scripts/print-dir.mjs ${Object.keys(map).join('|')}|all\n`);
    process.exit(2);
  }
  process.stdout.write(v + '\n');
}
