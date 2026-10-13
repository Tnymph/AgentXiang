// 给变声单独建一个环境（别和 CosyVoice 的依赖打架），装 uziproj/rvc。
// 前置：<tools>/miniconda3 与 <tools>/mingit 已在位（装法见 docs/文件与路径总账.md 第 10 节）。
// 用法：node scripts/install-rvc.mjs   （装完再跑 node scripts/get-rvc-assets.mjs 取公共模型）
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { TOOLS_DIR } from '../src/paths.js';

const CONDA = path.join(TOOLS_DIR, 'miniconda3/Scripts/conda.exe');
const MINGIT = path.join(TOOLS_DIR, 'mingit/cmd');
const ENV = 'rvc';
const PY = path.join(TOOLS_DIR, `miniconda3/envs/${ENV}/python.exe`);
const MIRROR = ['-i', 'https://pypi.tuna.tsinghua.edu.cn/simple', '--trusted-host', 'pypi.tuna.tsinghua.edu.cn'];

const run = (cmd, args, label, env = {}) => {
  const t0 = Date.now();
  const r = cp.spawnSync(cmd, args, { encoding: 'utf8', timeout: 3600000, maxBuffer: 1 << 24, env: { ...process.env, ...env } });
  const out = (String(r.stdout ?? '') + String(r.stderr ?? '')).split(/\r?\n/).filter((l) => l.trim());
  console.log(`\n=== ${label}：退出码 ${r.status}，${((Date.now() - t0) / 60000).toFixed(1)} 分钟 ===`);
  console.log(out.slice(-6).join('\n').slice(0, 1200));
  return r.status === 0;
};

run(CONDA, ['create', '-y', '-n', ENV, 'python=3.10'], '建环境 rvc');
run(PY, ['-m', 'pip', 'install', 'torch==2.1.2', 'torchaudio==2.1.2', '--index-url', 'https://download.pytorch.org/whl/cu121'], '装 torch（变声用 2.1.2）');
// git 要能被 pip 找到（MinGit 没在 PATH 里）
run(PY, ['-m', 'pip', 'install', 'git+https://github.com/uziproj/rvc.git', ...MIRROR], '装 uziproj/rvc', { PATH: `${MINGIT};${process.env.PATH}` });
run(PY, ['-c', 'import rvc, torch; print("rvc OK, cuda=", torch.cuda.is_available())'], '校验 rvc');
console.log('\n环境目录:', fs.existsSync(path.join(TOOLS_DIR, `miniconda3/envs/${ENV}`)) ? '已建 ✓' : '✗ 没建起来');
