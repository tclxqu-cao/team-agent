import { afterEach, describe, expect, it, vi } from "vitest";
import { reloadDeployedBuild } from "./reload-deployed-build";

afterEach(() => vi.unstubAllGlobals());

describe("deployed build reload", () => {
  it("reloads the same-origin shell together with its embedded renderer", () => {
    const parentReload = vi.fn(); const selfReload = vi.fn();
    vi.stubGlobal("window", { location: { origin: "http://100.121.10.115:3000", reload: selfReload }, parent: { location: { origin: "http://100.121.10.115:3000", reload: parentReload } } });
    reloadDeployedBuild();
    expect(parentReload).toHaveBeenCalledOnce();
    expect(selfReload).not.toHaveBeenCalled();
  });

  it("reloads only the renderer when a native parent is in another origin", () => {
    const reload = vi.fn();
    vi.stubGlobal("window", { location: { origin: "https://agent.test", reload }, parent: { get location() { throw new Error("cross-origin frame"); } } });
    reloadDeployedBuild();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("keeps standalone pages self-contained", () => {
    const reload = vi.fn();
    const win: Record<string, unknown> = { location: { origin: "https://agent.test", reload } };
    win.parent = win; vi.stubGlobal("window", win);
    reloadDeployedBuild();
    expect(reload).toHaveBeenCalledOnce();
  });
});
