import { expect, it, vi } from "vitest";
import { MessageIntake } from "./MessageIntake";

it("shares source collection with delivery refreshes and allows the next poll after completion", async () => {
  let finish!: () => void;
  const source = { collect: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })), discover: vi.fn(async () => ({ sources: [] })) };
  const intake = new MessageIntake({ insert: vi.fn() }, source);
  const first = intake.collect();
  const verificationRefresh = intake.collect();
  expect(first).toBe(verificationRefresh);
  await Promise.resolve();
  expect(source.collect).toHaveBeenCalledTimes(1);
  finish(); await first;
  source.collect.mockResolvedValueOnce();
  await intake.collect();
  expect(source.collect).toHaveBeenCalledTimes(2);
});
it("releases a failed collection without starting a competing read", async () => {
  const source = { collect: vi.fn().mockRejectedValueOnce(new Error("source unavailable")).mockResolvedValue(undefined), discover: vi.fn(async () => ({ sources: [] })) };
  const intake = new MessageIntake({ insert: vi.fn() }, source);
  await expect(intake.collect()).rejects.toThrow("source unavailable");
  await intake.collect();
  expect(source.collect).toHaveBeenCalledTimes(2);
});
