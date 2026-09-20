import { describe, expect, it } from "vitest";
import { WdaDriver } from "../src/drivers/wda.js";

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

const ROUTES: Array<{
  match: (url: string, method: string) => boolean;
  respond: (json: (v: unknown, status?: number) => Response) => Response;
}> = [
  {
    match: (url, method) => url.endsWith("/session") && method === "POST",
    respond: (json) => json({ sessionId: "s1" }),
  },
  {
    match: (url, method) => url.includes("/actions") && method === "POST",
    respond: (json) => json(null),
  },
  { match: (url) => url.includes("/screenshot"), respond: (json) => json("aPNGbase64==") },
  { match: (url) => url.includes("/window/rect"), respond: (json) => json({ width: 393, height: 852 }) },
  { match: (url) => url.includes("/wda/pressButton"), respond: (json) => json(null) },
  {
    match: (url, method) => url.includes("/element") && method === "POST",
    respond: (json) => json({ "element-6066-11e4-a52e-4f735466cecf": "el-9" }),
  },
  { match: (url) => url.includes("/value"), respond: (json) => json(null) },
  { match: (url) => url.includes("/wda/apps/launch"), respond: (json) => json(null) },
  { match: (url) => url.includes("/wda/activeAppInfo"), respond: (json) => json({ bundleId: "com.360buy.jdmall3" }) },
  { match: (url) => url.endsWith("/status"), respond: (json) => json({ build: { version: "8.5" } }) },
];

function makeDriver(): { driver: WdaDriver; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method, body });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify({ value }), { status, headers: { "content-type": "application/json" } });
    for (const route of ROUTES) {
      if (route.match(url, method)) return route.respond(json);
    }
    return json({ error: "no route" }, 404);
  };
  return { driver: new WdaDriver({ baseUrl: "http://127.0.0.1:8100", fetchImpl: impl }), calls };
}

function actionSteps(call: Call | undefined): Array<Record<string, unknown>> {
  expect(call).toBeDefined();
  return (call!.body as { actions: Array<{ actions: Array<Record<string, unknown>> }> }).actions[0].actions;
}

describe("WdaDriver", () => {
  it("状态检查", async () => {
    const { driver } = makeDriver();
    const status = await driver.status();
    expect(status.ok).toBe(true);
  });

  it("tap 走 W3C pointer actions", async () => {
    const { driver, calls } = makeDriver();
    await driver.tap(120, 340);
    const steps = actionSteps(calls.find((c) => c.url.includes("/actions")));
    expect(steps[0]).toMatchObject({ type: "pointerMove", x: 120, y: 340 });
    expect(steps.some((s) => s.type === "pointerDown")).toBe(true);
  });

  it("swipe 插值多个 move 步骤", async () => {
    const { driver, calls } = makeDriver();
    await driver.swipe(200, 600, 200, 200, 300);
    const moves = actionSteps(calls.find((c) => c.url.includes("/actions"))).filter(
      (s) => s.type === "pointerMove",
    );
    expect(moves).toHaveLength(7); // 起点 + 6 段插值
    expect(moves[moves.length - 1]).toMatchObject({ x: 200, y: 200 });
  });

  it("screenshot 返回解码字节", async () => {
    const { driver } = makeDriver();
    const png = await driver.screenshot();
    expect(Buffer.from(png).equals(Buffer.from("aPNGbase64==", "base64"))).toBe(true);
  });

  it("screenSize 读 window/rect", async () => {
    const { driver } = makeDriver();
    expect(await driver.screenSize()).toEqual({ width: 393, height: 852 });
  });

  it("ASCII 输入走 key actions，中文走元素设值", async () => {
    const { driver, calls } = makeDriver();
    await driver.inputText("iphone 15");
    expect(calls.some((c) => c.url.includes("/actions"))).toBe(true);
    await driver.inputText("苹果手机");
    const el = calls.find((c) => c.url.includes("/element") && !c.url.includes("value"));
    expect(el?.body).toMatchObject({ using: "-ios predicate string" });
    const value = calls.find((c) => c.url.includes("/value"));
    expect(value?.body).toMatchObject({ text: "苹果手机" });
  });

  it("home 键走 pressButton，back 报错提示", async () => {
    const { driver, calls } = makeDriver();
    await driver.pressKey("home");
    expect(calls.some((c) => c.url.includes("/wda/pressButton"))).toBe(true);
    await expect(driver.pressKey("back")).rejects.toThrow(/不支持 back/);
  });

  it("launchApp 走 wda/apps/launch", async () => {
    const { driver, calls } = makeDriver();
    await driver.launchApp("com.360buy.jdmall3");
    expect(calls.find((c) => c.url.includes("/wda/apps/launch"))?.body).toEqual({
      bundleId: "com.360buy.jdmall3",
    });
  });

  it("currentApp 读 activeAppInfo", async () => {
    const { driver } = makeDriver();
    expect(await driver.currentApp()).toBe("com.360buy.jdmall3");
  });
});
