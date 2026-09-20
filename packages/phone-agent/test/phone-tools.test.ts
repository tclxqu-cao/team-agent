import { describe, expect, it } from "vitest";
import { buildPhoneTools, type PhoneToolDeps } from "../src/agent/phone-tools.js";
import { SnapshotStore } from "../src/perception/snapshot.js";
import { buildSnapshot } from "../src/perception/ui-tree.js";
import type { VisionAnnotator } from "../src/perception/vision.js";
import type { PhoneAgentConfig } from "../src/config.js";
import type { PhoneDriver, PressKey, ScreenSize } from "../src/drivers/types.js";

function mockDriver(xml: () => string): PhoneDriver {
  return {
    kind: "adb",
    status: async () => ({ ok: true, detail: "Android Mock (test)" }),
    screenSize: async () => ({ width: 1080, height: 2400 }),
    screenshot: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    uiTreeXml: xml,
    tap: async () => undefined,
    swipe: async () => undefined,
    inputText: async () => undefined,
    pressKey: async (_key: PressKey) => undefined,
    launchApp: async () => undefined,
    listApps: async () => [
      { id: "com.taobao.taobao", name: "" },
      { id: "com.jingdong.app.mall", name: "" },
    ],
    currentApp: async () => "com.taobao.taobao",
  };
}

function makeDeps(xml: () => string) {
  const config = {
    artifactsDir: "/tmp/phone-agent-test",
    snapshotTtlMs: 30_000,
    maxTreeLines: 150,
    allowShell: true,
  } as unknown as PhoneAgentConfig;
  const vision: VisionAnnotator = { enabled: false, annotate: async () => "" };
  const deps: PhoneToolDeps = {
    driver: mockDriver(xml),
    config,
    snapshots: new SnapshotStore(config.snapshotTtlMs),
    vision,
  };
  const tools = buildPhoneTools(deps);
  const byName = (name: string) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`tool ${name} 不存在`);
    return tool;
  };
  return { deps, byName };
}

const TAOBAO_XML = [
  '<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]" text="" content-desc="" resource-id="" clickable="false">',
  '<node class="android.widget.TextView" text="AirPods Pro 2" content-desc="" resource-id="com.taobao.taobao:id/title" clickable="false" bounds="[108,600][972,660]"/>',
  '<node class="android.widget.Button" text="" content-desc="加入购物车" resource-id="add_cart" clickable="true" bounds="[760,2200][1026,2320]"/>',
  '<node class="android.widget.Button" text="" content-desc="立即购买" resource-id="buy_now" clickable="true" bounds="[460,2200][750,2320]"/>',
  "</node></hierarchy>",
].join("");

describe("phone-tools", () => {
  it("phone_status 返回设备与前台 App", async () => {
    const { byName } = makeDeps(() => TAOBAO_XML);
    const r = await byName("phone_status").execute({});
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("Android Mock");
    expect(r.text).toContain("com.taobao.taobao");
    expect(r.text).toContain("1080x2400");
  });

  it("phone_ui_tree 建立快照，phone_tap 按 index 定位中心点", async () => {
    const taps: Array<[number, number]> = [];
    const { byName, deps } = makeDeps(() => TAOBAO_XML);
    deps.driver.tap = async (x: number, y: number) => {
      taps.push([x, y]);
    };
    const tree = await byName("phone_ui_tree").execute({});
    expect(tree.text).toContain("加入购物车");
    const tap = await byName("phone_tap").execute({ index: 2 });
    expect(tap.isError).toBeFalsy();
    // [760,2200][1026,2320] 中心 (893, 2260)
    expect(taps).toEqual([[893, 2260]]);
  });

  it("敏感按钮未确认时拦截，确认后放行", async () => {
    const taps: Array<[number, number]> = [];
    const { byName, deps } = makeDeps(() => TAOBAO_XML);
    deps.driver.tap = async (x: number, y: number) => {
      taps.push([x, y]);
    };
    await byName("phone_ui_tree").execute({});
    const blocked = await byName("phone_tap").execute({ index: 3 });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("用户");
    expect(taps).toHaveLength(0);

    const allowed = await byName("phone_tap").execute({ index: 3, user_approved: true });
    expect(allowed.isError).toBeFalsy();
    expect(taps).toEqual([[605, 2260]]);
  });

  it("过期快照的 index 点击被拒绝", async () => {
    const { byName, deps } = makeDeps(() => TAOBAO_XML);
    await byName("phone_ui_tree").execute({});
    // 把快照时间戳改到 TTL 之外
    const snap = deps.snapshots.get()!;
    snap.capturedAt = Date.now() - 31_000;
    const r = await byName("phone_tap").execute({ index: 2 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/不存在或快照已过期/);
  });

  it("不存在的 index 报错并引导刷新", async () => {
    const { byName } = makeDeps(() => TAOBAO_XML);
    await byName("phone_ui_tree").execute({});
    const r = await byName("phone_tap").execute({ index: 99 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("phone_ui_tree");
  });

  it("phone_swipe 按方向换算坐标", async () => {
    const swipes: Array<[number, number, number, number, number]> = [];
    const { byName, deps } = makeDeps(() => TAOBAO_XML);
    deps.driver.swipe = async (x1, y1, x2, y2, ms) => {
      swipes.push([x1, y1, x2, y2, ms]);
    };
    const r = await byName("phone_swipe").execute({ direction: "up" });
    expect(r.isError).toBeFalsy();
    const [x1, y1, x2, y2] = swipes[0];
    expect(x1).toBe(540);
    expect(y1).toBeGreaterThan(y2); // 向上滑：起点在下半屏
  });

  it("phone_launch_app 支持中文映射", async () => {
    const launched: string[] = [];
    const { byName, deps } = makeDeps(() => TAOBAO_XML);
    deps.driver.launchApp = async (id: string) => {
      launched.push(id);
    };
    const r = await byName("phone_launch_app").execute({ app: "京东" });
    expect(r.isError).toBeFalsy();
    expect(launched).toEqual(["com.jingdong.app.mall"]);
  });

  it("phone_input_text 拒绝空文本", async () => {
    const { byName } = makeDeps(() => TAOBAO_XML);
    const r = await byName("phone_input_text").execute({ text: "" });
    expect(r.isError).toBe(true);
  });

  it("工具清单包含核心工具与 shell 守卫", async () => {
    const { deps } = makeDeps(() => TAOBAO_XML);
    const names = buildPhoneTools(deps).map((t) => t.name);
    for (const expected of [
      "phone_status",
      "phone_ui_tree",
      "phone_screenshot",
      "phone_tap",
      "phone_swipe",
      "phone_input_text",
      "phone_press_key",
      "phone_launch_app",
      "phone_list_apps",
      "phone_wait",
      "phone_shell",
    ]) {
      expect(names).toContain(expected);
    }
  });
});
