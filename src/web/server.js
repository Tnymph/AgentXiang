// 本地 Web 服务：只监听 127.0.0.1，同网段的其他设备访问不到
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as log from '../logger.js';
import { safeJoin } from '../logger.js';
import { match } from './router.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  let file;
  try {
    file = safeJoin(PUBLIC_DIR, rel);
  } catch {
    res.writeHead(403); res.end('forbidden'); return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  // 本地管理界面，文件随时可能被改动，绝不让浏览器缓存——
  // 否则改了前端代码还得让你手动强刷，很容易以为改动没生效。
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store, must-revalidate',
    Pragma: 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400); res.end(); return; }
    const pathname = url.pathname;

    if (!pathname.startsWith('/api/')) {
      serveStatic(res, pathname);
      return;
    }

    // 跨站保护：浏览器发跨域请求时会带 Origin，指的不是本站就拒绝。这样别的网页
    // 没法在后台调这些接口（改配置、启停进程）。非浏览器客户端不带 Origin，不受影响。
    const origin = req.headers.origin;
    if (origin && origin !== 'http://' + req.headers.host) {
      sendJson(res, 403, { error: '跨站请求被拒绝' });
      return;
    }

    const m = match(req.method, pathname);
    if (!m) { sendJson(res, 404, { error: '没有这个接口' }); return; }

    try {
      const body = req.method === 'GET' ? {} : await readBody(req);
      const query = Object.fromEntries(url.searchParams.entries());
      const out = await m.handler({ params: m.params, body, query, req });
      // 处理器可以返回原始字节（比如二维码图片）
      if (out && out.__raw) {
        res.writeHead(out.__raw.status ?? 200, {
          'Content-Type': out.__raw.contentType ?? 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(out.__raw.buffer);
        return;
      }
      sendJson(res, out?.__status ?? 200, out ?? {});
    } catch (e) {
      log.warn('web', '接口出错', { path: pathname, err: String(e.message) });
      sendJson(res, 400, { error: String(e.message) });
    }
  });
}

export async function startServer({ host = '127.0.0.1', port = 6188 } = {}) {
  await import('./api.js');          // 导入即注册全部接口路由
  // 端口可能还被上一个进程占着：点了「重启」之后新旧进程有一瞬间交接，
  // 开机自启时也可能撞上残留进程。重试几次比直接失败友好得多。
  for (let attempt = 1; ; attempt++) {
    const server = createServer();
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve());
      });
      log.info('web', 'listening', { url: `http://${host}:${port}` });
      return server;
    } catch (e) {
      if (e.code !== 'EADDRINUSE' || attempt >= 8) throw e;
      log.warn('web', 'port busy, retrying', { port, attempt });
      await new Promise((r) => setTimeout(r, 700));
    }
  }
}
