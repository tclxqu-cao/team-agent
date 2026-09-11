import { beforeEach, describe, expect, it, vi } from 'vitest';

const rows = vi.hoisted(() => new Map<string, string>());
vi.mock('../SQLiteDatabase.js', () => ({
  getDatabase: () => ({ db: {
    prepare: () => ({
      all: () => [...rows].map(([key, value]) => ({ key, value })),
      run: (key: string, value: string) => rows.set(key, value),
    }),
    transaction: (fn: () => void) => fn,
  } }),
}));
import { SQLiteSettingsStore } from '../SQLiteSettingsStore.js';

beforeEach(() => rows.clear());
describe('context window persistence', () => {
  it('round trips exactly 8192 tokens while retaining the existing K token storage contract', () => {
    const store = new SQLiteSettingsStore('/tmp');
    store.saveAll({ ...store.getAll(), contextWindow: 8192 / 1000 });
    expect(rows.get('contextWindow')).toBe('8.192');
    expect(store.getAll().contextWindow * 1000).toBe(8192);
  });
  it('preserves existing integer K token settings', () => {
    rows.set('contextWindow', '100');
    expect(new SQLiteSettingsStore('/tmp').getAll().contextWindow).toBe(100);
  });
});
