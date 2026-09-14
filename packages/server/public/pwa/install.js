(() => {
  if (!window.isSecureContext || window.parent !== window) return;
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/service-worker.js", { scope: "/", updateViaCache: "none" }).catch(() => {});
  let installPrompt;
  let installed = matchMedia("(display-mode: standalone)").matches || Boolean(navigator.standalone);
  const mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const announce = () => window.dispatchEvent(new CustomEvent("agentroam:pwa-state", { detail: { available: !installed && (mobile || Boolean(installPrompt)) } }));
  window.addEventListener("agentroam:pwa-query", announce);
  window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); installPrompt = event; announce(); });
  window.addEventListener("appinstalled", () => { installed = true; installPrompt = null; announce(); });
  window.addEventListener("agentroam:pwa-install", async () => {
    if (installed) return;
    if (installPrompt) {
      const prompt = installPrompt; installPrompt = null;
      try { await prompt.prompt(); await prompt.userChoice; announce(); return; } catch { /* Show manual instructions if the browser declines the API. */ }
    }
    window.dispatchEvent(new Event("agentroam:pwa-guide"));
  });
  announce();
})();
