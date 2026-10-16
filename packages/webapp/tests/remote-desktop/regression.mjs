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
  // Let the 420ms field-scroll adjustment settle before choosing a coordinate;
  // otherwise a zoomed tap can hit the footer instead of the picture.
  await new Promise(resolve => setTimeout(resolve, 500));
  const point = await page.evaluate(() => {
    const rect = document.querySelector(".browser-live-image-hit-area").getBoundingClientRect();
    const host = document.querySelector(".browser-live-viewport").getBoundingClientRect();
    // A zoomed picture extends underneath the footer; hit its visible part.
    const point = {
      x: Math.max(host.left + 4, Math.min(host.right - 4, rect.left + rect.width * 0.5)),
      y: Math.max(host.top + 4, Math.min(host.bottom - 4, rect.top + rect.height * 0.4)),
    };
    if (!document.elementFromPoint(point.x, point.y)?.closest(".browser-live-image-hit-area")) throw new Error("test tap is outside the visible picture");
    return point;
  });
  // These timestamps exercise short-tap classification. The automation calls
  // may be throttled ~1s apart; they do NOT verify a real 60ms network race.
  const timestamp = Date.now() / 1000;
  await page.cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point], timestamp });
  await page.cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [], timestamp: timestamp + 0.06 });
};
const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "浏览器键盘输入");
// The high-level click helper miscalculates coordinates after scrolling the
// narrow toolbar. Resolve its visible DOM rect, then dispatch a browser click.
const clickButton = async (label) => {
  const point = await page.evaluate((label) => {
    const button = document.querySelector(`button[aria-label="${label}"]`);
    button.scrollIntoView({ block: "nearest", inline: "nearest" });
    const rect = button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, label);
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 });
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1 });
};
await page.evaluate(() => {
  window.regression.setHit({ editable: false });
  window.focusEvents = [];
  document.addEventListener("focusin", event => window.focusEvents.push(event.target.className));
  window.gestureFocus = [];
  document.addEventListener("pointerup", event => {
    if (event.pointerType === "touch") window.gestureFocus.push(document.activeElement?.classList.contains("browser-live-mobile-input"));
  });
});
await tap();
await new Promise(resolve => setTimeout(resolve, 100));
assert.equal(await focused(), false, "background tap does not focus IME");
assert.equal(await page.evaluate(() => window.focusEvents.includes("browser-live-mobile-input")), false, "background tap never flashes IME focus");
await page.evaluate(() => window.regression.setHit({ editable: true, bounds: { x: 400, y: 300, w: 600, h: 80 } }));
await tap();
await until(focused, true, "confirmed text field focuses IME");
assert.equal(await page.evaluate(() => window.gestureFocus.at(-1)), true, "preflight focuses confirmed field before pointerup leaves the user gesture");
await page.evaluate(() => {
  window.imeBlurs = 0;
  document.querySelector(".browser-live-mobile-input").addEventListener("blur", () => window.imeBlurs++);
});
await tap();
assert.equal(await page.evaluate(() => window.imeBlurs), 0, "repeated field taps must not blur an existing typing session");
await page.evaluate(() => window.regression.setHit({ editable: false, kind: "control" }));
await tap();
assert.equal(await focused(), true, "control AX reply cannot dismiss password IME");
await page.evaluate(() => window.regression.setHit({ editable: false }));
await tap();
assert.equal(await focused(), true, "blank AX reply cannot dismiss password IME");
await clickButton('唤起键盘');
await until(focused, false, "toolbar dismisses keyboard explicitly");
await page.evaluate(() => window.regression.setHit({ editable: true, bounds: { x: 400, y: 300, w: 600, h: 80 } }));
await tap();
await until(focused, true, "a confirmed field reopens keyboard");
await clickButton('唤起键盘');
await until(focused, false, "dismiss while a confirmed field is cached");
await page.evaluate(() => window.regression.setHit({ editable: false, kind: "control" }));
await tap();
await new Promise(resolve => setTimeout(resolve, 100));
assert.equal(await focused(), false, "a control replacing a cached field must not reopen the keyboard");
await page.evaluate(() => window.regression.setHit({ editable: true, bounds: { x: 400, y: 300, w: 600, h: 80 } }));
await tap();
await until(focused, true, "a newly confirmed field restores IME");
await page.evaluate(() => { document.querySelector(".browser-live-zoom").scrollLeft = 0; });
await clickButton('放大桌面画面');
await clickButton('放大桌面画面');
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
// Simulate the reduced viewport after the software keyboard opens.
await page.cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 420, deviceScaleFactor: 3, mobile: true });
await clickButton('唤起键盘');
await until(focused, true, "toolbar focuses zoomed IME");
const bounds = await page.evaluate(() => {
  const input = document.querySelector(".browser-live-mobile-input").getBoundingClientRect();
  return { top: input.top, bottom: input.bottom, left: input.left, right: input.right, width: innerWidth, height: innerHeight };
});
assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.height && bounds.left >= 0 && bounds.right <= bounds.width, "IME stays inside visible viewport at 150% zoom");
await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: 190, y: 220, button: "left", buttons: 1, clickCount: 1 });
await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: 190, y: 220, button: "left", buttons: 0, clickCount: 1 });
assert.equal(await focused(), true, "compatibility mouse events retain IME focus");
const before = await snapshot();
assert.equal(before.zoom, "150%");
assert.ok(before.left >= 0);
// Hide while IME is focused, so both focus cleanup and viewer retention run.
await page.evaluate(() => window.regression.visible(false));
await until(() => page.evaluate(() => document.querySelector(".browser-live-backdrop").getAttribute("aria-hidden")), "true", "inactive tab is hidden");
await until(focused, false, "inactive tab releases local IME focus");
await page.evaluate(() => window.regression.visible(true));
await until(() => page.evaluate(() => document.querySelector(".browser-live-backdrop").getAttribute("aria-hidden")), "false", "tab is visible again");
assert.deepEqual(await snapshot(), before, "tab round trip preserves viewer, control, zoom and pan");
// A delayed editable reply cannot reopen the keyboard after leaving the tab.
if (await focused()) await clickButton('唤起键盘');
await until(focused, false, "dismiss before delayed reply");
await page.evaluate(() => { window.regression.setHitDelay(2500); window.regression.setHit({ editable: true }); });
// This case tests reply cancellation, not native gesture permission. Dispatch
// directly to the mounted surface so a resized/clipped image cannot redirect
// the test tap onto the footer's End control button.
await page.evaluate(() => {
  const surface = document.querySelector(".browser-live-image-hit-area");
  const rect = surface.getBoundingClientRect();
  const options = { bubbles: true, pointerType: "touch", pointerId: 99, clientX: rect.left + 10, clientY: rect.top + 10 };
  const capture = surface.setPointerCapture;
  surface.setPointerCapture = () => {};
  try {
    surface.dispatchEvent(new PointerEvent("pointerdown", options));
    surface.dispatchEvent(new PointerEvent("pointerup", options));
  } finally { surface.setPointerCapture = capture; }
});
await page.evaluate(() => window.regression.visible(false));
await new Promise(resolve => setTimeout(resolve, 2600));
assert.equal(await focused(), false, "late hit reply cannot refocus inactive tab");
await page.evaluate(() => { window.regression.setHitDelay(0); window.regression.visible(true); });
await clickButton('关闭浏览器直播');
await until(() => page.evaluate(() => !!document.querySelector(".browser-live-backdrop")), false, "explicit close removes panel");
await until(() => page.evaluate(() => window.regression.calls.filter(call => call.method === "browser:unwatch").length), before.unwatches + 1, "explicit close releases viewer");
console.log("PASS: no background IME flash, confirmed fields, uncertain AX retention, zoomed keyboard viewport, compatibility mouse focus, hidden-tab focus and control/zoom/pan retention");
})();
