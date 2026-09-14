(() => {
  if (!window.isSecureContext) return;
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/service-worker.js", { scope: "/", updateViaCache: "none" }).catch(() => {});
  if (matchMedia("(display-mode: standalone)").matches || navigator.standalone || window.parent !== window) return;
  let installPrompt;
  const trigger = document.createElement("button");
  trigger.textContent = "添加到主屏幕";
  trigger.type = "button";
  trigger.style.cssText = "position:fixed;right:12px;top:calc(env(safe-area-inset-top,0px) + 10px);z-index:99999;width:auto;margin:0;padding:8px 12px;border:1px solid #497269;border-radius:20px;background:#102821;color:#b5ecda;font:13px system-ui;cursor:pointer";
  trigger.hidden = !/iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); installPrompt = event; trigger.hidden = false; });
  window.addEventListener("appinstalled", () => trigger.remove());
  trigger.addEventListener("click", async () => {
    const panel = document.createElement("dialog");
    panel.style.cssText = "max-width:340px;margin:auto;padding:24px;border:1px solid #497269;border-radius:16px;background:#102019;color:#eaf2f3;font:15px/1.8 system-ui";
    const title = document.createElement("h2"); title.textContent = "像 App 一样打开";
    const copy = document.createElement("p"); copy.textContent = "iPhone：在 Safari 点分享，选择“添加到主屏幕”。Android：在浏览器菜单选择“安装应用”或“添加到主屏幕”。";
    const note = document.createElement("p"); note.textContent = "从主屏幕打开后，如果提示未授权，请在电脑生成新二维码，再在此页面扫码。无需苹果签名。";
    const close = document.createElement("button"); close.textContent = "知道了"; close.type = "button"; close.onclick = () => { panel.close(); panel.remove(); };
    panel.append(title, copy, note);
    if (installPrompt) {
      const install = document.createElement("button"); install.type = "button"; install.textContent = "立即安装";
      install.onclick = async () => { await installPrompt?.prompt(); installPrompt = null; panel.close(); panel.remove(); };
      panel.append(install);
    }
    panel.append(close); document.body.append(panel); panel.addEventListener("cancel", () => panel.remove()); panel.showModal();
  });
  document.body.append(trigger);
})();
