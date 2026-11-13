import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ target: {}, legacy: {}, imports: vi.fn() }));
vi.mock("@agent/core", () => ({
  getDatabase: (path: string) => ({ db: path === "target" ? state.target : state.legacy }),
  SQLiteEngineSwitchRepository: class {
    importLegacy() { state.imports(); }
  },
}));
vi.mock("@agent/native-runtime", () => ({ resolveNativeRuntimeDirectory: () => "target" }));
vi.mock("../server-data-dir", () => ({ getServerBaseDir: () => "legacy" }));
import { getEngineSwitchRepository } from "./state";
it("retries a failed legacy import before exposing the authoritative ledger", () => {
  state.imports.mockImplementationOnce(() => { throw new Error("locked legacy database"); });
  expect(() => getEngineSwitchRepository()).toThrow("locked legacy database");
  expect(getEngineSwitchRepository()).toBeDefined();
  expect(state.imports).toHaveBeenCalledTimes(2);
  getEngineSwitchRepository();
  expect(state.imports).toHaveBeenCalledTimes(2);
});
