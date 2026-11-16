import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { devMobilePairing } from './dev-mobile-pairing.mjs';

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
