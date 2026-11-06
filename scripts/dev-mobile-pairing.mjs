import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../packages/cli/package.json', import.meta.url));
const QRCode = require('qrcode-terminal/vendor/QRCode');

/**
 * Local development UI only; this middleware is not served by the remote gateway.
 * @param {{backend?: string, accessUrl?: string, request?: typeof fetch}} [options]
 */
export function devMobilePairing({ backend = 'http://127.0.0.1:3000', accessUrl, request = fetch } = {}) {
  const backendUrl = new URL(backend);
  if (backendUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(backendUrl.hostname)) {
    throw new Error('开发配对后端必须是本机 HTTP 服务');
  }
  backendUrl.hostname = '127.0.0.1';
  const serviceOrigin = backendUrl.origin;
  return { name: 'local-mobile-pairing', configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url?.split('?')[0] !== '/api/local-mobile-pairing') return next();
      const reply = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(value));
      };
      const host = req.headers.host;
      const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host || '')
        && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      if (!local || req.headers.origin !== `http://${host}`) return reply(403, { error: '请在本机 localhost 页面生成手机二维码' });
      if (req.method !== 'POST') return reply(405, { error: 'POST required' });
      try {
        const status = await request(`${serviceOrigin}/api/web-auth/status`, {
          headers: { cookie: req.headers.cookie || '' }, signal: AbortSignal.timeout(5000),
        });
        const auth = await status.json();
        if (!status.ok || !auth.authenticated || auth.locked) return reply(401, { error: '请先配对登录本机网页版' });
        if (!accessUrl) return reply(503, { error: '请设置 AGENT_MOBILE_ACCESS_URL 为手机可访问的地址' });
        const url = new URL(accessUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url['pass' + 'word'] || ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(url.hostname)) return reply(400, { error: '手机访问地址无效' });
        const registry = process.env.AGENTROAM_DISCOVERY_DIR || join(homedir(), '.agentroam/services');
        for (const file of await readdir(registry)) {
          if (!file.endsWith('.json')) continue;
          let d;
          try { d = JSON.parse(await readFile(join(registry, file), 'utf8')); } catch { continue; }
          if (d.url !== serviceOrigin) continue;
          const r = await request(`${d.url}/api/pairing/admin/qr`, { method: 'POST', headers: {
            'x-agentroam-desktop-token': d.token, 'content-type': 'application/json',
          }, body: '{}', signal: AbortSignal.timeout(5000) });
          if (!r.ok) continue;
          const { grant, expiresAt } = await r.json();
          if (!/^[A-Za-z0-9_-]{43}$/.test(grant || '') || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) continue;
          const pairingUrl = `${url.origin}/app/#pair=${grant}`;
          const qr = new QRCode(-1, 1); qr.addData(pairingUrl); qr.make();
          const n = qr.getModuleCount(), cells = [];
          for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) cells.push(`M${x+4} ${y+4}h1v1h-1z`);
          return reply(200, { pairingUrl, expiresAt, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n+8} ${n+8}"><path fill="white" d="M0 0h${n+8}v${n+8}H0z"/><path fill="black" d="${cells.join('')}"/></svg>` });
        }
        reply(503, { error: '没有找到运行中的本机服务' });
      } catch { reply(503, { error: '生成二维码失败，请检查本机服务后重试' }); }
    });
  } };
}
