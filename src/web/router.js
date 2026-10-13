// 路由注册表：单独成模块，避免 server 与 api 相互导入造成的循环依赖
const routes = [];

/** 注册一条路由，路径支持 :param */
export function route(method, pattern, handler) {
  const segs = pattern.split('/').filter(Boolean);
  routes.push({ method, segs, handler });
}

/** 按方法与路径查找 handler，返回 { handler, params } 或 null */
export function match(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== method) continue;
    if (r.segs.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < r.segs.length; i++) {
      const s = r.segs[i];
      if (s.startsWith(':')) params[s.slice(1)] = decodeURIComponent(parts[i]);
      else if (s !== parts[i]) { ok = false; break; }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

export function routeCount() {
  return routes.length;
}
