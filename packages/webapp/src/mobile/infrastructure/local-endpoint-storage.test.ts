import { afterEach, describe, expect, it } from "vitest";
import { LocalEndpointStorage } from "./local-endpoint-storage";
import { ServerEndpoint } from "../domain/server-endpoint";

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("LocalEndpointStorage", () => {
  afterEach(() => {
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  it("round-trips a saved endpoint across instances", () => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new MemoryStorage() });
    new LocalEndpointStorage().save(ServerEndpoint.parse("http://10.0.0.5:3000")!);

    expect(new LocalEndpointStorage().load()?.toString()).toBe("http://10.0.0.5:3000");
  });

  it("treats corrupted or missing entries as absent", () => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new MemoryStorage() });
    localStorage.setItem("webapp.mobile.serverEndpoint.v1", ":::garbage:::");

    expect(new LocalEndpointStorage().load()).toBeNull();
    expect(new LocalEndpointStorage().load()).toBeNull();
  });

  it("clear removes the persisted endpoint", () => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new MemoryStorage() });
    const storage = new LocalEndpointStorage();
    storage.save(ServerEndpoint.parse("http://10.0.0.5:3000")!);

    storage.clear();

    expect(storage.load()).toBeNull();
  });
});
