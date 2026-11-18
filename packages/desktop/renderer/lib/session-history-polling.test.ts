import { afterEach, expect, it, vi } from "vitest";
import { refreshSessionHistoryWhenReady, startSessionHistoryPolling } from "./session-history-polling";

afterEach(() => vi.useRealTimers());

it("keeps the initial snapshot instead of immediately requesting it again", () => {
  vi.useFakeTimers();
  const refresh = vi.fn();
  const stop = startSessionHistoryPolling(refresh, () => true);
  expect(refresh).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1_999);
  expect(refresh).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(refresh).toHaveBeenCalledTimes(1);
  stop();
});

it("waits through a slow initial read and then follows later history changes", () => {
  vi.useFakeTimers();
  let initialReadPending = true;
  const refresh = vi.fn();
  const stop = startSessionHistoryPolling(refresh, () => !initialReadPending);
  vi.advanceTimersByTime(5_000);
  expect(refresh).not.toHaveBeenCalled();
  initialReadPending = false;
  vi.advanceTimersByTime(1_000);
  expect(refresh).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(2_000);
  expect(refresh).toHaveBeenCalledTimes(2);
  stop();
});

it("stops refreshing when the reader switches away from the session", () => {
  vi.useFakeTimers();
  const refresh = vi.fn();
  const stop = startSessionHistoryPolling(refresh, () => true);
  vi.advanceTimersByTime(2_000);
  stop();
  vi.advanceTimersByTime(10_000);
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("reads a resumed session immediately even without another transcript change", () => {
  vi.useFakeTimers();
  const refresh = vi.fn();
  const stop = refreshSessionHistoryWhenReady(refresh, () => true);
  vi.advanceTimersByTime(10_000);
  expect(refresh).toHaveBeenCalledTimes(1);
  stop();
});

it("defers a resume read until the initial snapshot has settled", () => {
  vi.useFakeTimers();
  let ready = false;
  const refresh = vi.fn();
  const stop = refreshSessionHistoryWhenReady(refresh, () => ready);
  vi.advanceTimersByTime(1_000);
  expect(refresh).not.toHaveBeenCalled();
  ready = true;
  vi.advanceTimersByTime(50);
  expect(refresh).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1_000);
  expect(refresh).toHaveBeenCalledTimes(1);
  stop();
});

it("cancels a deferred resume read when the session is hidden or replaced", () => {
  vi.useFakeTimers();
  let ready = false;
  const refresh = vi.fn();
  const stop = refreshSessionHistoryWhenReady(refresh, () => ready);
  stop();
  ready = true;
  vi.advanceTimersByTime(1_000);
  expect(refresh).not.toHaveBeenCalled();
});
