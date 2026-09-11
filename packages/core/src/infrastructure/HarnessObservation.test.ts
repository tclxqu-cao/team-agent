import { it, expect } from 'vitest';
import { diagnosticValue, diagnosticHash } from './HarnessObservation.js';
it('redacts secrets, bounds previews and preserves hashes across argument key order', () => {
  const value = diagnosticValue({ apiKey: 'secret', arguments: { text: 'Authorization: Bearer abcdefghijkl sk-abcdefghijk' }, images: ['base64'] });
  expect(JSON.stringify(value)).not.toContain('abcdefghijkl');
  expect(JSON.stringify(value)).not.toContain('sk-abcdefghijk');
  expect(JSON.stringify(value)).not.toContain('base64');
  expect(diagnosticHash({ a: 1, b: 2 })).toBe(diagnosticHash({ b: 2, a: 1 }));
});
