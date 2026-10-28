/**
 * lib/routes.js —— 面板的 HTTP 通道（Host 侧，零依赖）
 *
 * 为什么不用 host.call：那是 dsh-cordis-host-runner 给"动态沙箱插件"的 harness.handle
 * 通道，已安装 bundle 拿不到；官方 UI 包走各自的 api/typert 通道，
 * webServer 注册的同源 HTTP 路由。这里照同一套做：
 *
 *   client.js  ──fetch('/plugins/jalibreak/api/<method>')──▶  webServer prefix 路由
 *                                                             ├─ connection.requestRejection 围栏
 *                                                             └─ hub.* 控制器
 *
 * 每条路由先过宿主围栏（Host/Origin 反 DNS rebinding + 登录 token cookie），
 * 再谈业务；响应统一 {ok:true,value} / {ok:false,error:{message}}，与 dsh-memory 同形。
 */

import { createHub } from './hub.js';
import { createArm, attachArmSection, armText } from './arm.js';
import { attachLiveTransport } from './live.js';
import { decide as decideGate, DEFAULT_GATE } from './gate.js';

export const ROUTE_PREFIX = '/plugins/jalibreak/api';

const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

const ok = (res, value) => sendJson(res, 200, { ok: true, value: value === undefined ? null : value });
const bad = (res, status, message, code) => sendJson(res, status, { ok: false, error: { message: String(message), code: code ?? (status === 400 ? 'BAD_REQUEST' : 'ERROR') } });

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk?.length ?? 0;
    if (size > MAX_BODY_BYTES) {
      req.resume?.();
      const err = new Error('请求体超过 64 KiB');
      err.status = 413;
      throw err;
    }
    chunks.push(Buffer.from(chunk));
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    const err = new Error('请求体不是合法 JSON');
    err.status = 400;
    throw err;
  }
}

/** 宿主围栏：返回 undefined 表示放行，返回数字表示该 HTTP 状态码拒绝。 */
function fenceOf(ctx) {
  // cordis 的属性守卫会拒绝未 inject 的服务（"cannot get property ... without inject"），
  // 所以只能走 ctx.get()——它按文档「Read a service from the store without the inject requirement」。
  let connection;
  try {
    connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined;
  } catch {
    connection = undefined;
  }
  if (!connection || typeof connection.requestRejection !== 'function') return () => undefined;
  return (req) => {
    try {
      const rejection = connection.requestRejection(req);
      return typeof rejection === 'number' ? rejection : undefined;
    } catch {
      return undefined;
    }
  };
}

/**
 * 在给定 ctx 上注册 prefix 路由。返回 {hub, dispose}；webServer 缺失时返回 dispose=null。
 */
export function attachRoutes(ctx, { base, resolveRoot, logger } = {}) {
  const hub = createHub({ ctx, base, resolveRoot, logger });
  const fence = fenceOf(ctx);
  const root = (() => {
    try {
      return typeof resolveRoot === 'function' ? resolveRoot(null, base) : (base?.root ?? null);
    } catch {
      return base?.root ?? null;
    }
  })();
  const arm = root ? createArm({ root }) : null;
  // 段要挂在**根 ctx** 上：systemPrompt 按调用方 scope 合并段，插件 fiber 的子 scope 不一定
  // 在 agent 会话的祖先链里；ctx.root 是全局层，任何会话装配都能看到。
  let armScope = ctx;
  try {
    if (ctx?.root && typeof ctx.root === 'object') armScope = ctx.root;
  } catch {
    armScope = ctx;
  }
  const armSection = arm ? attachArmSection(armScope, arm, { logger }) : { registered: false, reason: 'no-root' };
  const liveTransport = arm ? attachLiveTransport(arm, { root, logger }) : { registered: false, reason: 'no-root' };
  try {
    ctx.effect?.(() => () => {
      liveTransport.dispose();
      armSection.dispose?.();
    }, 'aecot: live conversation hooks');
  } catch {}

  const handle = async (req, res) => {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://aecot.local');
    } catch {
      bad(res, 400, '非法 URL');
      return;
    }
    const path = url.pathname.startsWith(ROUTE_PREFIX) ? url.pathname.slice(ROUTE_PREFIX.length) || '/' : '/';
    const method = (req.method ?? 'GET').toUpperCase();

    const rejection = fence(req);
    if (rejection !== undefined) {
      res.statusCode = rejection;
      res.end();
      return;
    }

    try {
      if (method === 'GET' && (path === '/' || path === '/ping')) {
        ok(res, { pong: true, prefix: ROUTE_PREFIX, time: new Date().toISOString() });
        return;
      }
      if (method === 'GET' && path === '/state') {
        ok(res, await hub.state());
        return;
      }
      if (method === 'GET' && path === '/progress') {
        ok(res, await hub.progress(url.searchParams.get('id') ?? undefined));
        return;
      }
      if (method === 'GET' && path === '/runs') {
        ok(res, await hub.runs(Math.max(1, Math.min(100, Number(url.searchParams.get('limit') ?? 12))), url.searchParams.get('root')));
        return;
      }
      if (method === 'GET' && path === '/taxonomy') {
        ok(res, hub.taxonomy());
        return;
      }
      if (method === 'GET' && path === '/profiles') {
        ok(res, await hub.profiles({ id: url.searchParams.get('id') ?? undefined, limit: Number(url.searchParams.get('limit') ?? 20), root: url.searchParams.get('root') }));
        return;
      }
      if (method === 'POST' && path === '/profile') {
        ok(res, await hub.collect(await readJson(req), { signal: undefined }));
        return;
      }
      if (method === 'GET' && path === '/export') {
        ok(res, await hub.exportRun(url.searchParams.get('id'), url.searchParams.get('format') ?? 'markdown', url.searchParams.get('root')));
        return;
      }
      if (method === 'POST' && path === '/run') {
        const body = await readJson(req);
        ok(res, await hub.start(body, { source: 'ui' }));
        return;
      }
      if (method === 'POST' && path === '/stop') {
        await readJson(req);
        ok(res, hub.stop());
        return;
      }
      if (method === 'POST' && path === '/preview') {
        ok(res, hub.preview(await readJson(req)));
        return;
      }
      if (method === 'POST' && path === '/judge') {
        ok(res, await hub.judge(await readJson(req)));
        return;
      }
      if (method === 'POST' && path === '/screen') {
        ok(res, await hub.screen(await readJson(req)));
        return;
      }
      if (method === 'POST' && path === '/probe') {
        ok(res, await hub.probe(await readJson(req)));
        return;
      }
      if (method === 'GET' && path === '/arm') {
        if (!arm) throw new Error('破甲开关不可用（root 未解析）');
        await arm.ready();
        ok(res, {
          armed: arm.armed,
          section: armSection.registered === true,
          sectionReason: armSection.reason ?? null,
          sectionName: armSection.registered ? 'aecot:armed' : null,
          transport: liveTransport.registered === true,
          strategy: 'static-hcot-v1',
          file: arm.file,
          preview: armText().slice(0, 400),
          gate: liveTransport.gate?.summary?.() ?? null,
        });
        return;
      }
      if (method === 'POST' && path === '/arm') {
        if (!arm) throw new Error('破甲开关不可用（root 未解析）');
        const body = await readJson(req);
        const armed = await arm.set(body?.on ?? !arm.armed);
        logger?.info?.(`[aecot] 破甲模式 ${armed ? 'ON' : 'OFF'}`);
        ok(res, { armed, section: armSection.registered === true, file: arm.file });
        return;
      }
      if (method === 'GET' && path === '/gate') {
        ok(res, { registered: liveTransport.registered === true, ...(liveTransport.gate?.summary?.() ?? {}) });
        return;
      }
      if (method === 'POST' && path === '/gate') {
        const body = await readJson(req);
        const goal = String(body?.goal ?? '').trim();
        if (liveTransport.gate?.decide) {
          ok(res, { goal, registered: true, decision: liveTransport.gate.decide(goal) });
          return;
        }
        const offline = decideGate(goal);
        ok(res, { goal, registered: false, decision: offline });
        return;
      }
      bad(res, 404, `未知接口 ${method} ${path}`, 'NOT_FOUND');
    } catch (err) {
      bad(res, Number(err?.status) || 500, err?.message ?? String(err));
    }
  };

  let dispose = null;
  const register = (host) => {
    let webServer;
    try {
      webServer = typeof host?.get === 'function' ? host.get('webServer') : undefined;
    } catch {
      webServer = undefined;
    }
    if (!webServer || typeof webServer.register !== 'function') {
      logger?.warn?.('[aecot] webServer 不可用：面板 API 未注册（模型工具与 CLI 不受影响）');
      console.log('[aecot] webServer 不可用：面板 API 未注册');
      return null;
    }
    try {
      dispose = webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => Promise.resolve(handle(req, res)).catch((err) => {
          try {
            bad(res, 500, err?.message ?? String(err));
          } catch {
            /* 响应已发出 */
          }
        }),
      });
      logger?.info?.(`[aecot] 面板 API 已注册 ${ROUTE_PREFIX}`);
      console.log(`[aecot] 面板 API 已注册 ${ROUTE_PREFIX}`);
      return dispose;
    } catch (err) {
      logger?.warn?.(`[aecot] 路由注册失败: ${err?.message ?? err}`);
      console.log(`[aecot] 路由注册失败: ${err?.message ?? err}`);
      return null;
    }
  };

  return { hub, arm, armSection, liveTransport, handle, register, get dispose() { return dispose; }, get registered() { return Boolean(dispose); } };
}

/** 把路由挂到插件生命周期上：优先 ctx.inject(['webServer'])，退化为直接取服务，最差只留工具。 */
export function mountRoutes(ctx, opts = {}) {
  const routes = attachRoutes(ctx, opts);
  const { logger } = opts;
  const attach = (host) => {
    const dispose = routes.register(host);
    if (!dispose) return null;
    try {
      if (typeof host.effect === 'function') host.effect(() => dispose, 'aecot: panel routes');
    } catch {
      /* effect 不可用时靠 webServer 的 dispose 兜底 */
    }
    return dispose;
  };

  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (sub) => {
        attach(sub);
      });
      return routes;
    }
  } catch (err) {
    logger?.warn?.(`[aecot] ctx.inject 不可用，退化为直接挂载: ${err?.message ?? err}`);
  }
  attach(ctx);
  return routes;
}
