// Start `bun run --cwd packages/webapp dev --host 127.0.0.1 --strictPort`, then:
// Run through ego-browser nodejs; set globalThis.remoteDesktopTestSpace to reuse
// an existing task space when continuing an investigation.
// This runs the actual page/panel with a fixture transport; it does not prove
// that an iOS/Android system keyboard is visible on a physical device.
(async () => {
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(globalThis.remoteDesktopTestSpace ?? "Remote desktop regression");
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
const until = async (read, expected, message) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await read()) === expected) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await read(), expected, message);
};
await page.cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await page.cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await page.goto("http://127.0.0.1:5175/tests/remote-desktop/");
await until(() => page.evaluate(() => document.body.innerText.includes("开始控制")), true, "panel opens");
await page.click('loc=role:button[name="开始控制"]');
await until(() => page.evaluate(() => document.body.innerText.includes("结束控制")), true, "takeover succeeds");
const tap = async () => {
  const point = await page.evaluate(() => {
    const rect = document.querySelector(".browser-live-image-hit-area").getBoundingClientRect();
    return { x: rect.left + rect.width * 0.5, y: rect.top + rect.height * 0.4 };
  });
  await page.cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await page.cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};
const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "浏览器键盘输入");
await tap();
assert.equal(await focused(), true, "first tap focuses IME without learned bounds");
await page.evaluate(() => window.regression.setHit({ editable: false, kind: "control" }));
await tap();
assert.equal(await focused(), true, "control AX reply cannot dismiss password IME");
await page.evaluate(() => window.regression.setHit({ editable: false }));
await tap();
assert.equal(await focused(), true, "blank AX reply cannot dismiss password IME");
await page.click('loc=css:button[aria-label="唤起键盘"]');
await until(focused, false, "toolbar dismisses keyboard explicitly");
await tap();
assert.equal(await focused(), true, "a new touch reopens keyboard");
await page.click('loc=css:button[aria-label="放大桌面画面"]');
await page.click('loc=css:button[aria-label="放大桌面画面"]');
const snapshot = () => page.evaluate(() => {
  const viewport = document.querySelector(".browser-live-viewport");
  return {
    zoom: document.querySelector("output").textContent,
    left: viewport.scrollLeft,
    controlling: document.body.innerText.includes("结束控制"),
    takeovers: window.regression.calls.filter(call => call.method === "browser:takeover").length,
    unwatches: window.regression.calls.filter(call => call.method === "browser:unwatch").length,
  };
});
await page.evaluate(() => { document.querySelector(".browser-live-viewport").scrollLeft = 70; });
const before = await snapshot();
assert.equal(before.zoom, "150%");
assert.equal(before.left, 70);
// Hide while IME is focused, so both focus cleanup and viewer retention run.
await tap();
await page.evaluate(() => window.regression.visible(false));
await until(() => page.evaluate(() => document.querySelector(".browser-live-backdrop").getAttribute("aria-hidden")), "true", "inactive tab is hidden");
await until(focused, false, "inactive tab releases local IME focus");
await page.evaluate(() => window.regression.visible(true));
await until(() => page.evaluate(() => document.querySelector(".browser-live-backdrop").getAttribute("aria-hidden")), "false", "tab is visible again");
assert.deepEqual(await snapshot(), before, "tab round trip preserves viewer, control, zoom and pan");
await page.click('loc=css:button[aria-label="关闭浏览器直播"]');
await until(() => page.evaluate(() => !!document.querySelector(".browser-live-backdrop")), false, "explicit close removes panel");
await until(() => page.evaluate(() => window.regression.calls.filter(call => call.method === "browser:unwatch").length), before.unwatches + 1, "explicit close releases viewer");
console.log("PASS: first-touch IME, lock-screen AX replies, manual dismiss/reopen, hidden-tab focus, control/zoom/pan retention and explicit close");
})();
