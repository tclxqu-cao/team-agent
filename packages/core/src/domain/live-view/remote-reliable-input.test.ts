import { describe, expect, it } from 'vitest';
import { RemoteReliableInputLedger } from './remote-reliable-input.js';

describe('reliable input receipts', () => {
  it('orders cross-port arrivals and reuses a single native dispatch and result', async () => {
    const calls: string[] = []; let finish!: (value: string) => void;
    const ledger = new RemoteReliableInputLedger<string, string>(async value => {
      calls.push(value); return value === 'first' ? new Promise(resolve => { finish = resolve; }) : value;
    }, () => 0);
    const second = ledger.offer(2, 7, 'second', 'second');
    expect(calls).toEqual([]);
    const first = ledger.offer(1, 3, 'first', 'first');
    expect(ledger.offer(1, 3, 'first', 'first')).toBe(first);
    expect(calls).toEqual(['first']); finish('native-ack');
    expect(await first).toBe('native-ack'); expect(await second).toBe('second');
    expect(await ledger.offer(1, 3, 'first', 'first')).toBe('native-ack');
    await expect(ledger.offer(1, 3, 'changed', 'first')).rejects.toMatchObject({ code: 'EINVAL' });
    expect(calls).toEqual(['first', 'second']);
  });
  it('rejects expired and evicted ids without executing again and bounds pending gaps', async () => {
    let now = 0, calls = 0;
    const ledger = new RemoteReliableInputLedger<number, number>(async value => { calls++; return value; }, () => now);
    await expect(ledger.offer(65, 65, '65', 65)).rejects.toMatchObject({ code: 'EBUSY' });
    await ledger.offer(1, 1, '1', 1); now = 15_000;
    await expect(ledger.offer(1, 1, '1', 1)).rejects.toMatchObject({ code: 'ESTALE' });
    for (let i = 2; i <= 131; i++) await ledger.offer(i, i, String(i), i);
    await expect(ledger.offer(2, 2, '2', 2)).rejects.toMatchObject({ code: 'ESTALE' });
    expect(calls).toBe(131);
  });
  it('cancels queued work on revoke and retains safe completed receipts', async () => {
    const ledger = new RemoteReliableInputLedger<string, string>(async value => value, () => 0);
    await ledger.offer(1, 1, 'a', 'a');
    const waiting = ledger.offer(3, 3, 'c', 'c'); const rejected = expect(waiting).rejects.toMatchObject({ code: 'ESTALE' });
    ledger.close(); await rejected;
    expect(await ledger.offer(1, 1, 'a', 'a')).toBe('a');
    await expect(ledger.offer(2, 2, 'b', 'b')).rejects.toMatchObject({ code: 'ESTALE' });
  });
});
