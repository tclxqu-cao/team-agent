(() => {
  const scan = document.getElementById("scan"), cancel = document.getElementById("scan-cancel"), section = document.getElementById("scanner"), video = document.getElementById("camera");
  if (!scan || !video) return;
  let stream, running = false, generation = 0, decoder;
  const stopCamera = () => { generation++; running = false; stream?.getTracks().forEach(track => track.stop()); stream = null; video.srcObject = null; section.hidden = true; scan.disabled = false; };
  const fail = message => { stopCamera(); showForm(message); };
  function parse(raw) {
    if (raw.length > 2048) throw new Error();
    if (raw.startsWith("{")) {
      const value = JSON.parse(raw), server = new URL(value.server);
      if (value.type !== "agentroam-pair" || value.version !== 1 || server.username || server.password || server.search || server.hash || server.pathname !== "/" || !/^[A-Za-z0-9_-]{43}$/.test(value.grant)) throw new Error();
      raw = server.origin + "/pair#pair=" + value.grant;
    }
    const url = new URL(raw);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/pair" || url.search || !/^#pair=[A-Za-z0-9_-]{43}$/.test(url.hash)) throw new Error();
    return url;
  }
  function loadDecoder() {
    if (window.jsQR) return Promise.resolve();
    return decoder ||= new Promise((resolve, reject) => {
      const script = document.createElement("script"); script.src = "/pwa/qr-decoder.js";
      const failed = () => { clearTimeout(timer); decoder = null; script.remove(); reject(new Error()); };
      const timer = setTimeout(failed, 10_000);
      script.onload = () => { clearTimeout(timer); resolve(); }; script.onerror = failed; document.head.append(script);
    });
  }
  scan.addEventListener("click", async () => {
    if (running || scan.disabled) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { showForm("相机扫码需要 HTTPS。也可以用手机系统相机扫描电脑二维码，或手输配对码。"); return; }
    const attempt = ++generation; scan.disabled = true; section.hidden = false;
    try {
      await loadDecoder();
      if (attempt !== generation) return;
      const camera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      if (attempt !== generation) { camera.getTracks().forEach(track => track.stop()); return; }
      stream = camera; video.srcObject = camera;
      let playTimer;
      try { await Promise.race([video.play(), new Promise((_, reject) => { playTimer = setTimeout(() => reject(new Error("Camera produced no frames")), 10_000); })]); }
      finally { clearTimeout(playTimer); }
      if (attempt !== generation) return;
      running = true;
      const canvas = document.createElement("canvas"), context = canvas.getContext("2d", { willReadFrequently: true });
      const tick = () => {
        if (!running || attempt !== generation) return;
        try {
          if (video.videoWidth && video.videoHeight) {
            canvas.width = Math.min(video.videoWidth, 640); canvas.height = Math.round(video.videoHeight * canvas.width / video.videoWidth);
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height), code = window.jsQR(pixels.data, pixels.width, pixels.height);
            if (code) {
              let target; try { target = parse(code.data); } catch { fail("这不是 AgentRoam 授权二维码，请在电脑上重新生成。"); return; }
              stopCamera();
              if (target.origin === location.origin) void exchangeQr(target.hash.slice(6));
              else location.assign(target.href);
              return;
            }
          }
          setTimeout(tick, 250);
        } catch { fail("二维码识别失败，请重试或手输配对码。"); }
      };
      tick();
    } catch (error) {
      if (attempt === generation) fail(error?.name === "NotAllowedError" ? "相机权限未开启，请在浏览器设置中允许相机，或手输配对码。" : "无法启动扫码，请检查相机与网络后重试。");
    }
  });
  cancel.addEventListener("click", stopCamera);
  document.getElementById("pair").addEventListener("submit", stopCamera);
  window.addEventListener("pagehide", stopCamera);
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopCamera(); });
})();
