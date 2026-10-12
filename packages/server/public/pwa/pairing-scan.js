let decoder;
function loadDecoder() {
  if (window.jsQR) return Promise.resolve();
  return decoder ||= new Promise((resolve, reject) => {
    const script = document.createElement("script"); script.src = "/pwa/qr-decoder.js";
    const failed = () => { clearTimeout(timer); decoder = null; script.remove(); reject(new Error("二维码识别器加载失败，请重试。")); };
    const timer = setTimeout(failed, 10_000);
    script.onload = () => { clearTimeout(timer); resolve(); }; script.onerror = failed; document.head.append(script);
  });
}

export function supportsLiveCamera() {
  return Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia);
}

/** A native photo capture input also works on ordinary HTTP mobile pages. */
export async function decodePairingImage(file) {
  if (!file || (file.type && !file.type.startsWith("image/"))) throw new Error("请选择二维码照片。");
  if (file.size > 20 * 1024 * 1024) throw new Error("照片过大，请重新拍摄二维码。");
  await loadDecoder();
  const image = new Image(), source = URL.createObjectURL(file);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("照片加载超时，请重新拍摄。")), 10_000);
      image.onload = () => { clearTimeout(timer); resolve(); };
      image.onerror = () => { clearTimeout(timer); reject(new Error("无法读取照片，请重新拍摄二维码。")); };
      image.src = source;
    });
    const canvas = document.createElement("canvas"), context = canvas.getContext("2d", { willReadFrequently: true });
    for (const limit of [1600, 1024, 640]) {
      const scale = Math.min(1, limit / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(pixels.data, pixels.width, pixels.height);
      if (code) return code.data;
    }
    throw new Error("照片中没有识别到二维码，请靠近电脑屏幕重新拍摄。");
  } finally { image.onload = null; image.onerror = null; URL.revokeObjectURL(source); }
}

/** Shared by the pairing landing page and the global computer switcher. */
export function createPairingScanner(video, onResult, onError) {
  let stream, generation = 0, timer;
  const stop = () => {
    generation++;
    clearTimeout(timer);
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
  };
  const fail = (attempt, error) => {
    if (attempt !== generation) return;
    stop();
    onError(error?.name === "NotAllowedError" ? "相机权限未开启，请允许相机或粘贴二维码链接。" : error?.message || "无法启动扫码，请重试。");
  };
  const start = async () => {
    stop();
    const attempt = generation;
    if (!supportsLiveCamera()) {
      onError("实时扫码需要 HTTPS，请使用拍照扫码。");
      return;
    }
    try {
      await loadDecoder();
      if (attempt !== generation) return;
      const camera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      if (attempt !== generation) { camera.getTracks().forEach(track => track.stop()); return; }
      stream = camera; video.srcObject = camera;
      let playTimer;
      try { await Promise.race([video.play(), new Promise((_, reject) => { playTimer = setTimeout(() => reject(new Error("相机没有返回画面，请重试。")), 10_000); })]); }
      finally { clearTimeout(playTimer); }
      if (attempt !== generation) return;
      const canvas = document.createElement("canvas"), context = canvas.getContext("2d", { willReadFrequently: true });
      const tick = () => {
        if (attempt !== generation) return;
        try {
          if (video.videoWidth && video.videoHeight) {
            canvas.width = Math.min(video.videoWidth, 640); canvas.height = Math.round(video.videoHeight * canvas.width / video.videoWidth);
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height), code = window.jsQR(pixels.data, pixels.width, pixels.height);
            if (code) { stop(); onResult(code.data); return; }
          }
          timer = setTimeout(tick, 250);
        } catch (error) { stop(); onError(error?.message || "二维码识别失败，请重试。"); }
      };
      tick();
    } catch (error) { fail(attempt, error); }
  };
  const visibility = () => { if (document.hidden) stop(); };
  window.addEventListener("pagehide", stop);
  document.addEventListener("visibilitychange", visibility);
  return { start, stop, dispose() { stop(); window.removeEventListener("pagehide", stop); document.removeEventListener("visibilitychange", visibility); } };
}
