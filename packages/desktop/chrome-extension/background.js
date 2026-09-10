import { ChromeTabBridge } from "./bridge-client.js";
import { AutoConnect } from "./auto-connect.js";

const controller = new AutoConnect(chrome, new ChromeTabBridge(chrome), async () => {
  try {
    const response = await fetch(chrome.runtime.getURL("bootstrap.json"), { cache: "no-store" });
    if (!response.ok) throw new Error();
    return await response.json();
  } catch { throw new Error("bootstrap-unavailable"); }
});
const started = controller.start();
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  void (async () => {
    await started;
    if (message.type === "pause") return controller.setPaused(true);
    if (message.type === "resume") return controller.setPaused(false);
    return controller.status();
  })().then((result) => reply({ ok: true, result }), () => reply({ ok: false, error: "连接暂不可用，请重试" }));
  return true;
});
void started.catch(() => {});
