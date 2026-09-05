import { describe, expect, it } from "vitest";
import type { Message } from "../model/entities.js";
import { SessionQueryIndexCache } from "./SessionQueryIndexCache.js";

const messages = (content: string): Message[] => [{ role: "user", content }];

describe("SessionQueryIndexCache", () => {
  it("reuses the cached index for an unchanged revision", () => {
    const cache = new SessionQueryIndexCache(2);
    const first = cache.getOrCreate("one", messages("hello"));
    const second = cache.getOrCreate("one", messages("hello"));
    expect(second).toBe(first);
  });

  it("replaces changed revisions and evicts the least recently used session", () => {
    const cache = new SessionQueryIndexCache(2);
    const oldOne = cache.getOrCreate("one", messages("one"));
    const oldTwo = cache.getOrCreate("two", messages("two"));
    cache.getOrCreate("one", messages("one"));
    cache.getOrCreate("three", messages("three"));

    expect(cache.getOrCreate("one", messages("one"))).toBe(oldOne);
    const newTwo = cache.getOrCreate("two", messages("two"));
    expect(newTwo).not.toBe(oldTwo);
    expect(newTwo).not.toBe(cache.getOrCreate("two", messages("changed")));
  });
});
