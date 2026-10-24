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
if (!globalThis.remoteDesktopEmbeddedOnly) {
await page.goto("http://127.0.0.1:5175/tests/remote-desktop/");
await until(() => page.evaluate(() => document.body.innerText.includes("开始控制")), true, "panel opens");
await page.evaluate(() => window.regression.setSkin("pearl"));
await page.click('loc=role:button[name="开始控制"]');
await until(() => page.evaluate(() => document.body.innerText.includes("结束控制")), true, "takeover succeeds");
const controlLayout = await page.evaluate(() => {
  const cue = document.querySelector(".browser-live-control-cue");
  cue.querySelector("span").textContent = "当前输入会发送到本机 · P2P 直连 · H264 · 1280×720@17 · 2.6Mbps · 15ms · 控制 19ms";
  const footer = document.querySelector(".browser-live-footer").getBoundingClientRect();
  const status = document.querySelector(".browser-live-location").getBoundingClientRect();
  const button = document.querySelector(".browser-live-footer button").getBoundingClientRect();
  const picture = document.querySelector(".browser-live-viewport").getBoundingClientRect();
  const message = cue.getBoundingClientRect();
  return { footerHeight: footer.height, sameRow: Math.abs(status.y + status.height / 2 - button.y - button.height / 2) < 2, cueHeight: message.height, cueBottom: message.bottom, pictureTop: picture.top };
});
assert.ok(controlLayout.footerHeight <= 64, "mobile control footer stays compact");
assert.equal(controlLayout.sameRow, true, "control status and end button share a row");
assert.ok(controlLayout.cueHeight <= 20 && controlLayout.cueBottom <= controlLayout.pictureTop, "long connection diagnostics stay above the picture in one line");
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
    const button = [...document.querySelectorAll(`button[aria-label="${label}"]`)].find(button => button.getClientRects().length);
    if (!button) throw new Error(`No visible button: ${label}`);
    button.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    const rect = button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, label);
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 });
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1 });
};
await clickButton('移动桌面画面');
assert.equal(await page.evaluate(() => document.querySelector('button[aria-label="移动桌面画面"]').getAttribute('aria-pressed')), 'true');
await clickButton('唤起键盘');
await until(focused, true, "native keyboard target receives focus while panning");
assert.equal(await page.evaluate(() => document.querySelector('button[aria-label="移动桌面画面"]').getAttribute('aria-pressed')), 'false', "typing exits pan mode without immediately blurring");
await page.keyboard.insertText('键盘回归');
await until(() => page.evaluate(() => window.regression.calls.filter(call => call.method === 'browser:input' && call.params.input.text === '键盘回归').length), 1, "native input sends committed text once");
await page.keyboard.press('Enter');
assert.equal(await page.evaluate(() => window.regression.calls.filter(call => call.method === 'browser:input' && call.params.input.key === 'Enter' && call.params.input.action === 'down').length), 1, "native input keeps remote special keys");
await clickButton('唤起键盘');
await until(focused, false, "keyboard control dismisses the native target");
// Exercise iPhone's in-page fullscreen path as well as the compact footer.
await page.evaluate(() => { document.querySelector(".browser-live-panel").requestFullscreen = undefined; });
await page.click('loc=role:button[name="全屏"]');
await until(() => page.evaluate(() => !!document.querySelector(".browser-live-panel.is-fullscreen")), true, "in-page fullscreen opens");
assert.equal(await page.evaluate(() => !!document.querySelector(".browser-live-footer")), false, "fullscreen releases the footer space");
await clickButton('快捷键条');
const quickKeysLayout = await page.evaluate(() => {
  const keys = document.querySelector(".browser-live-quickkeys").getBoundingClientRect();
  const picture = document.querySelector(".browser-live-viewport").getBoundingClientRect();
  return { keysBottom: keys.bottom, pictureTop: picture.top, cueHidden: getComputedStyle(document.querySelector(".browser-live-control-cue")).display === "none" };
});
assert.ok(quickKeysLayout.keysBottom <= quickKeysLayout.pictureTop && quickKeysLayout.cueHidden, "expanded shortcuts and diagnostics cannot overlap the picture");
await clickButton('快捷键条');
await clickButton('退出全屏');
await until(() => page.evaluate(() => !!document.querySelector(".browser-live-footer")), true, "exiting fullscreen restores compact controls");
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
}

await page.cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await page.goto("http://127.0.0.1:5175/tests/remote-desktop/embedded.html");
await until(() => page.evaluate(() => !!document.querySelector("iframe").contentDocument.querySelector(".browser-live-panel")), true, "embedded panel opens");
await page.evaluate(() => document.querySelector("iframe").contentWindow.regression.setSkin("pearl"));
const clickEmbeddedButton = async (label) => {
  const point = await page.evaluate(label => {
    const frame = document.querySelector("iframe");
    const doc = frame.contentDocument;
    const button = [...doc.querySelectorAll("button")].find(button => button.getAttribute("aria-label") === label || button.textContent === label);
    if (!button) throw new Error(`No embedded button: ${label}`);
    button.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    const bounds = button.getBoundingClientRect();
    const host = frame.getBoundingClientRect();
    return { x: host.left + bounds.left + bounds.width / 2, y: host.top + bounds.top + bounds.height / 2 };
  }, label);
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 });
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1 });
};
await clickEmbeddedButton("开始控制");
await until(() => page.evaluate(() => document.querySelector("iframe").contentDocument.body.innerText.includes("结束控制")), true, "embedded takeover succeeds");
await until(() => page.evaluate(() => document.querySelector("iframe").contentDocument.querySelector('button[aria-label="放大桌面画面"]').disabled), false, "embedded frame is ready to zoom");
for (let step = 0; step < 7; step++) {
  await clickEmbeddedButton("放大桌面画面");
  await until(() => page.evaluate(() => document.querySelector("iframe").contentDocument.querySelector("output").textContent), `${125 + step * 25}%`, "embedded zoom commits before the next press");
}
const embeddedBounds = () => page.evaluate(() => {
  const frame = document.querySelector("iframe");
  const doc = frame.contentDocument;
  const panel = doc.querySelector(".browser-live-panel").getBoundingClientRect();
  const surface = doc.querySelector(".browser-live-viewport").getBoundingClientRect();
  const footer = doc.querySelector(".browser-live-footer").getBoundingClientRect();
  return { top: panel.top, height: panel.height, frameHeight: frame.clientHeight, pictureHeight: surface.height, footerBottom: footer.bottom, zoom: doc.querySelector("output").textContent, controlling: doc.body.innerText.includes("结束控制") };
});
// Safari's iframe can temporarily repeat the top-level pan/keyboard shrink.
await page.evaluate(() => {
  const child = document.querySelector("iframe").contentWindow;
  Object.defineProperty(child, "visualViewport", { configurable: true, value: Object.assign(new EventTarget(), { offsetTop: 210, offsetLeft: 0, width: 390, height: 172 }) });
  window.setRegressionViewport(420, 210);
});
await until(async () => (await embeddedBounds()).height, 382, "keyboard leaves the whole visible iframe usable");
let embedded = await embeddedBounds();
assert.equal(embedded.top, 0, "inherited pan must not leave a blank strip above the panel");
assert.equal(embedded.zoom, "275%", "keyboard does not reset the zoomed picture");
assert.equal(embedded.controlling, true, "keyboard retains remote control");
assert.ok(embedded.pictureHeight > 150, "picture retains space above the keyboard");
assert.ok(embedded.footerBottom <= embedded.frameHeight, "end-control button stays visible");
await page.evaluate(() => {
  const child = document.querySelector("iframe").contentWindow;
  Object.assign(child.visualViewport, { offsetTop: 0, height: 806 });
  window.setRegressionViewport(844);
});
await until(async () => (await embeddedBounds()).height, 806, "closing the keyboard restores the full frame");
embedded = await embeddedBounds();
assert.equal(embedded.top, 0);
assert.ok(embedded.pictureHeight > 500);
console.log("PASS: embedded keyboard pan is applied once, picture and end-control stay visible, closing keyboard restores layout");
await page.evaluate(() => {
  document.querySelector("iframe").contentWindow.regression.setSkin("glass");
  window.setRegressionViewport(420, 210);
});
await until(async () => (await embeddedBounds()).height, 366, "glass panel fits the keyboard's reduced frame with its 8px insets");
embedded = await embeddedBounds();
assert.equal(embedded.top, 8, "glass material cannot introduce a second keyboard pan");
assert.ok(embedded.pictureHeight > 150 && embedded.footerBottom <= embedded.frameHeight, "glass preserves space for picture and end-control");
assert.equal(embedded.zoom, "275%", "theme and keyboard preserve picture zoom");
await page.evaluate(() => window.setRegressionViewport(844));
await until(async () => (await embeddedBounds()).height, 790, "closing keyboard restores glass panel");
console.log("PASS: glass keyboard layout, retained zoom and visible end-control");
})();
