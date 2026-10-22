import test from 'node:test';
import assert from 'node:assert/strict';
import { spherePoint, projectPoint, arcPoint } from '../public/globe.js';
import { readFile } from 'node:fs/promises';

test('geographic projection preserves sphere radius', () => {
  for (const lon of [-180, -90, 0, 104, 180]) {
    const point = spherePoint(lon, 31);
    assert.ok(Math.abs(Math.hypot(...point) - 1) < 1e-10);
    assert.ok(Math.abs(Math.hypot(...projectPoint(point, 1.2)) - 1) < 1e-10);
  }
});
test('connection arcs meet their nodes and rise above the surface', () => {
  const host = spherePoint(104, 31), peer = spherePoint(139, 36);
  for (const [value, expected] of [[0, host], [1, peer]]) {
    arcPoint(host, peer, value).forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-10));
  }
  assert.ok(Math.hypot(...arcPoint(host, peer, .5)) > 1.1);
  assert.deepEqual(arcPoint(host, host, .5), host);
});
test('local geographic samples contain valid coordinates', async () => {
  const points = JSON.parse(await readFile(new URL('../public/assets/globe-land.json', import.meta.url)));
  assert.ok(points.length > 4000);
  assert.ok(points.every(([lon, lat]) => lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90));
});
