import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../packages/cli/package.json', import.meta.url));
const QRCode = require('qrcode-terminal/vendor/QRCode');
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;
const LOCAL_ADDRESS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const DESKTOP_TOKEN_HEADER = ['x-agentroam', 'desktop-token'].join('-');
const DESKTOP_PATH = /^\/(?:api|ws|web|app|_next)(?:\/|$)/;

function backendOrigin(backend) {
  const backendUrl = new URL(backend);
  if (backendUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(backendUrl.hostname)) {
    throw new Error('开发配对后端必须是本机 HTTP 服务');
  }
  backendUrl.hostname = '127.0.0.1';
  return backendUrl.origin;
}

function isLocalWebRequest(req) {
  return LOCAL_HOST.test(req.headers.host || '')
    && LOCAL_ADDRESS.has(req.socket.remoteAddress);
}

async function findService(serviceOrigin, registry, request = fetch) {
  for (const file of await readdir(registry)) {
    if (!file.endsWith('.json')) continue;
    try {
      const descriptor = JSON.parse(await readFile(join(registry, file), 'utf8'));
      if (descriptor.url !== serviceOrigin || typeof descriptor.token !== 'string') continue;
      const identity = await request(`${serviceOrigin}/api/desktop/identity`, {
        headers: { [DESKTOP_TOKEN_HEADER]: descriptor.token },
        signal: AbortSignal.timeout(5000),
      });
      if (identity.ok) return descriptor;
    } catch {}
  }
  return null;
}

/**
 * Trust only a browser request whose Host and socket are both loopback. Vite
 * still reaches the gateway over loopback when Tailscale Serve proxies a
 * remote request, so the Host check is required to keep remote users paired.
 */
export function devLocalWebAuthorization({
  backend = 'http://127.0.0.1:3000',
  registry,
  request = fetch,
} = {}) {
  const serviceOrigin = backendOrigin(backend);
  const discoveryDir = registry || process.env.AGENTROAM_DISCOVERY_DIR || join(homedir(), '.agentroam/services');
  let cachedService = null;
  let cachedAt = 0;
  return { name: 'local-web-authorization', configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const pathname = req.url?.split('?')[0] || '';
      if (pathname === '/' && ['GET', 'HEAD'].includes(req.method || 'GET') && isLocalWebRequest(req)) {
        res.writeHead(302, { location: '/web', 'cache-control': 'no-store' });
        res.end();
        return;
      }
      if (!DESKTOP_PATH.test(pathname) || !isLocalWebRequest(req)) return next();
      try {
        if (!cachedService || Date.now() - cachedAt >= 5000) {
          cachedService = await findService(serviceOrigin, discoveryDir, request);
          cachedAt = Date.now();
        }
        if (cachedService) req.headers[DESKTOP_TOKEN_HEADER] = cachedService.token;
      } catch {}
      next();
    });
  } };
}

/**
 * Local development UI only; this middleware is not served by the remote gateway.
 * @param {{backend?: string, accessUrl?: string, request?: typeof fetch}} [options]
 */
export function devMobilePairing({ backend = 'http://127.0.0.1:3000', accessUrl, request = fetch } = {}) {
  const serviceOrigin = backendOrigin(backend);
  return { name: 'local-mobile-pairing', configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url?.split('?')[0] !== '/api/local-mobile-pairing') return next();
      const reply = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(value));
      };
      const host = req.headers.host;
      if (!isLocalWebRequest(req) || req.headers.origin !== `http://${host}`) return reply(403, { error: '请在本机 localhost 页面生成手机二维码' });
      if (req.method !== 'POST') return reply(405, { error: 'POST required' });
      try {
        const desktopToken = req.headers[DESKTOP_TOKEN_HEADER];
        const status = await request(`${serviceOrigin}/api/web-auth/status`, {
          headers: {
            cookie: req.headers.cookie || '',
            ...(typeof desktopToken === 'string' ? { [DESKTOP_TOKEN_HEADER]: desktopToken } : {}),
          },
          signal: AbortSignal.timeout(5000),
        });
        const auth = await status.json();
        if (!status.ok || !auth.authenticated || auth.locked) return reply(401, { error: '请先配对登录本机网页版' });
        if (!accessUrl) return reply(503, { error: '请设置 AGENT_MOBILE_ACCESS_URL 为手机可访问的地址' });
        const url = new URL(accessUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url['pass' + 'word'] || ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(url.hostname)) return reply(400, { error: '手机访问地址无效' });
        const registry = process.env.AGENTROAM_DISCOVERY_DIR || join(homedir(), '.agentroam/services');
        const d = await findService(serviceOrigin, registry, request);
        if (!d) return reply(503, { error: '没有找到运行中的本机服务' });
        const r = await request(`${d.url}/api/pairing/admin/qr`, { method: 'POST', headers: {
          [DESKTOP_TOKEN_HEADER]: d.token, 'content-type': 'application/json',
        }, body: '{}', signal: AbortSignal.timeout(5000) });
        if (!r.ok) return reply(503, { error: '没有找到运行中的本机服务' });
        const { grant, expiresAt } = await r.json();
        if (!/^[A-Za-z0-9_-]{43}$/.test(grant || '') || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return reply(503, { error: '没有找到运行中的本机服务' });
        const pairingUrl = `${url.origin}/web/#pair=${grant}`;
        const qr = new QRCode(-1, 1); qr.addData(pairingUrl); qr.make();
        const n = qr.getModuleCount(), cells = [];
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) cells.push(`M${x+4} ${y+4}h1v1h-1z`);
        return reply(200, { pairingUrl, expiresAt, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n+8} ${n+8}"><path fill="white" d="M0 0h${n+8}v${n+8}H0z"/><path fill="black" d="${cells.join('')}"/></svg>` });
      } catch { reply(503, { error: '生成二维码失败，请检查本机服务后重试' }); }
    });
  } };
}
