import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { devLocalWebAuthorization, devMobilePairing } from './dev-mobile-pairing.mjs';

async function fixture(auth, run) {
  let calls = 0;
  const plugin = devMobilePairing({ request: async () => { calls++; return Response.json(auth); } });
  let handler;
  plugin.configureServer({ middlewares: { use(fn) { handler = fn; } } });
  const server = createServer((req, res) => handler(req, res, () => { res.writeHead(404).end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://localhost:${server.address().port}`;
  try { await run(origin, () => calls); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('rejects cross-origin requests before reading any service credential', async () => {
  await fixture({ authenticated: true }, async (origin, calls) => {
    const r = await fetch(origin + '/api/local-mobile-pairing', { method: 'POST', headers: { origin: 'https://evil.example' } });
    assert.equal(r.status, 403); assert.equal(calls(), 0);
  });
});
test('rejects an unpaired browser', async () => {
  await fixture({ authenticated: false }, async origin => {
    const r = await fetch(origin + '/api/local-mobile-pairing', { method: 'POST', headers: { origin } });
    assert.equal(r.status, 401);
  });
});
test('rejects paired devices while remote access is locked', async () => {
  await fixture({ authenticated: true, locked: true }, async origin => {
    const r = await fetch(origin + '/api/local-mobile-pairing', { method: 'POST', headers: { origin } });
    assert.equal(r.status, 401);
  });
});
test('reports missing access configuration before issuing an invitation', async () => {
  await fixture({ authenticated: true }, async (origin, calls) => {
    const r = await fetch(origin + '/api/local-mobile-pairing', { method: 'POST', headers: { origin } });
    assert.equal(r.status, 503); assert.equal(calls(), 1);
  });
});
test('refuses a remote backend', () => {
  assert.throws(() => devMobilePairing({ backend: 'http://example.com' }), /本机/);
});

const DESKTOP_TOKEN_HEADER = ['x-agentroam', 'desktop-token'].join('-');

async function invokeLocalAuthorization({ host, remoteAddress, request, path = '/api/web-auth/status' }) {
  const registry = mkdtempSync(join(tmpdir(), 'agentroam-local-auth-'));
  const token = 'a'.repeat(64);
  writeFileSync(join(registry, 'service.json'), JSON.stringify({
    url: 'http://127.0.0.1:3000',
    token,
  }));
  let handler;
  const plugin = devLocalWebAuthorization({
    backend: 'http://127.0.0.1:3000',
    registry,
    request,
  });
  plugin.configureServer({ middlewares: { use(fn) { handler = fn; } } });
  const req = {
    url: path,
    headers: { host },
    socket: { remoteAddress },
  };
  let nextCalled = false;
  await handler(req, {}, () => { nextCalled = true; });
  rmSync(registry, { recursive: true, force: true });
  return { nextCalled, token: req.headers[DESKTOP_TOKEN_HEADER] };
}

test('injects the local service credential for loopback browser requests', async () => {
  const request = async (_url, init) => Response.json(
    { ok: init.headers[DESKTOP_TOKEN_HEADER] === 'a'.repeat(64) },
    { status: init.headers[DESKTOP_TOKEN_HEADER] === 'a'.repeat(64) ? 200 : 401 },
  );
  assert.deepEqual(
    await invokeLocalAuthorization({ host: 'localhost:5185', remoteAddress: '127.0.0.1', request }),
    { nextCalled: true, token: 'a'.repeat(64) },
  );
});

test('authorizes the local web console and remote desktop assets', async () => {
  const request = async () => Response.json({ ok: true });
  for (const path of ['/web', '/app/?view=remote-desktop', '/_next/static/app.js']) {
    assert.equal(
      (await invokeLocalAuthorization({
        host: 'localhost:5185',
        remoteAddress: '127.0.0.1',
        request,
        path,
      })).token,
      'a'.repeat(64),
    );
  }
});

test('redirects local root requests to the full web console', async () => {
  let handler;
  const plugin = devLocalWebAuthorization({ request: async () => Response.json({ ok: true }) });
  plugin.configureServer({ middlewares: { use(fn) { handler = fn; } } });
  let status;
  let location;
  const req = {
    url: '/',
    method: 'GET',
    headers: { host: 'localhost:5185' },
    socket: { remoteAddress: '127.0.0.1' },
  };
  const res = {
    writeHead(code, headers) {
      status = code;
      location = headers.location;
    },
    end() {},
  };
  await handler(req, res, () => {});
  assert.deepEqual({ status, location }, { status: 302, location: '/web' });
});

test('does not inject the local service credential for proxied remote requests', async () => {
  const request = async () => Response.json({ ok: true });
  assert.deepEqual(
    await invokeLocalAuthorization({
      host: 'booshaw-2.tailedbf07.ts.net',
      remoteAddress: '127.0.0.1',
      request,
    }),
    { nextCalled: true, token: undefined },
  );
});

test('does not inject the local service credential for non-loopback clients', async () => {
  const request = async () => Response.json({ ok: true });
  assert.deepEqual(
    await invokeLocalAuthorization({ host: 'localhost:5185', remoteAddress: '192.168.1.20', request }),
    { nextCalled: true, token: undefined },
  );
});

test('skips stale local service descriptors', async () => {
  const registry = mkdtempSync(join(tmpdir(), 'agentroam-stale-service-'));
  writeFileSync(join(registry, 'stale.json'), JSON.stringify({
    url: 'http://127.0.0.1:3000',
    token: 'a'.repeat(64),
  }));
  writeFileSync(join(registry, 'active.json'), JSON.stringify({
    url: 'http://127.0.0.1:3000',
    token: 'b'.repeat(64),
  }));
  let handler;
  const plugin = devLocalWebAuthorization({
    backend: 'http://127.0.0.1:3000',
    registry,
    request: async (_url, init) => Response.json({}, {
      status: init.headers[DESKTOP_TOKEN_HEADER] === 'b'.repeat(64) ? 200 : 401,
    }),
  });
  plugin.configureServer({ middlewares: { use(fn) { handler = fn; } } });
  const req = {
    url: '/api/web-auth/status',
    headers: { host: 'localhost:5185' },
    socket: { remoteAddress: '127.0.0.1' },
  };
  await handler(req, {}, () => {});
  rmSync(registry, { recursive: true, force: true });
  assert.equal(req.headers[DESKTOP_TOKEN_HEADER], 'b'.repeat(64));
});
