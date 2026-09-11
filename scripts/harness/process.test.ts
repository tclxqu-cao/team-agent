import { describe, it, expect } from 'vitest';
import { runCommand } from './process.js';

describe('independent Harness process runner', () => {
  it('collects real child output and nonzero exits', async () => {
    const lines: string[] = [];
    const result = await runCommand([process.execPath, '-e', 'console.log("event"); process.exitCode=7'], {
      cwd: process.cwd(), timeoutMs: 5000, onLine: line => lines.push(line),
    });
    expect(result.code).toBe(7); expect(lines).toEqual(['event']);
  });
  it('terminates a stuck child within its budget', async () => {
    const start = Date.now();
    const result = await runCommand([process.execPath, '-e', 'setInterval(()=>{},1000)'], {
      cwd: process.cwd(), timeoutMs: 250,
    });
    expect(result.timedOut).toBe(true); expect(result.code).toBe(124);
    expect(Date.now() - start).toBeLessThan(2500);
  });
  it('respects cancellation without reporting a repairable failure', async () => {
    const controller = new AbortController();
    const result = runCommand([process.execPath, '-e', 'setInterval(()=>{},1000)'], {
      cwd: process.cwd(), timeoutMs: 5000, signal: controller.signal,
    });
    controller.abort();
    await expect(result).rejects.toThrow('cancelled');
  });
});
