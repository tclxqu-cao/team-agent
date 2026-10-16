const { selectAssets } = await import(
  `./releases.js${new URL(import.meta.url).search}`
);
const { releaseSnapshot } = await import(
  `./release-snapshot.js${new URL(import.meta.url).search}`
);
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
if ("IntersectionObserver" in window) {
  document.documentElement.classList.add("js");
  const observer = new IntersectionObserver(
    (entries) =>
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
          observer.unobserve(entry.target);
        }
      }),
    { threshold: 0.06 },
  );
  document.querySelectorAll(".reveal").forEach((el) => observer.observe(el));
}
let toastTimer;
function toast(message) {
  const element = document.querySelector(".toast");
  element.textContent = message;
  element.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("visible"), 2600);
}
document.querySelectorAll("[data-copy]").forEach((button) =>
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      toast("命令已复制，去电脑终端运行吧。");
    } catch {
      toast("复制未成功，请选中命令后手动复制。");
    }
  }),
);
const dialog = document.querySelector(".lightbox");
document.querySelectorAll("[data-lightbox]").forEach((button) =>
  button.addEventListener("click", () => {
    const image = dialog.querySelector("img");
    image.src = `assets/${button.dataset.lightbox}`;
    image.alt = button.querySelector("img").alt;
    dialog.showModal();
    document.body.style.overflow = "hidden";
  }),
);
function closeLightbox() {
  dialog.close();
}
dialog.querySelector("button").addEventListener("click", closeLightbox);
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) closeLightbox();
});
dialog.addEventListener("close", () => {
  document.body.style.overflow = "";
});
const cosmos = document.querySelector(".cosmos");
if (cosmos && matchMedia("(pointer: fine)").matches) {
  let frame;
  window.addEventListener(
    "pointermove",
    (event) => {
      if (reducedMotion.matches || window.scrollY > innerHeight) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        cosmos.style.translate = `${(event.clientX / innerWidth - 0.5) * 12}px ${(event.clientY / innerHeight - 0.5) * 8}px`;
      });
    },
    { passive: true },
  );
}
const status = document.querySelector("[data-release-status]");
if (status) {
  try {
    let releases = releaseSnapshot;
    let live = false;
    try {
      const response = await fetch(
        "https://api.github.com/repos/tclxqu-cao/team-agent/releases?per_page=20",
        {
          headers: { Accept: "application/vnd.github+json" },
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!response.ok) throw new Error(`GitHub ${response.status}`);
      const fetched = await response.json();
      if (!Array.isArray(fetched))
        throw new Error("Unexpected release response");
      releases = fetched;
      live = true;
    } catch {
      // Keep verified published downloads available when the public API is limited.
    }
    const assetsByEdition = { lite: selectAssets(releases, "lite"), full: selectAssets(releases, "full") };
    status.textContent = !live
      ? "已显示最近确认发布的安装包，可直接下载。最新发布也可前往 GitHub Releases 查看。"
      : releases.length
      ? "安装包直接来自 GitHub Releases，按平台匹配最新可用版本。"
      : "桌面和 Android 安装包尚未公开发布。现在可先用下方 CLI 安装，手机通过浏览器连接。";
    const labels = {
      mac: "下载 macOS",
      windows: "下载 Windows",
      android: "下载 Android APK",
    };
    document.querySelectorAll("[data-platform]").forEach((link) => {
      const platform = link.dataset.platform;
      const edition = link.dataset.edition || "lite";
      const asset = assetsByEdition[edition]?.[platform];
      const caption = document.querySelector(`[data-version="${platform}"][data-edition="${edition}"]`);
      const suffix = platform === "android" ? "" : edition === "lite" ? " 简易版" : " 全量版";
      if (asset) {
        link.href = asset.browser_download_url;
        link.textContent = `${labels[platform]}${suffix} ↗`;
        if (caption) caption.textContent = `${asset.tag} · ${(asset.size / 1048576).toFixed(1)} MB`;
      } else {
        if (caption) caption.textContent =
          platform === "android"
            ? "尚无公开 APK · 可先使用浏览器 / PWA"
            : "尚无公开安装包 · 可先使用下方 CLI";
      }
    });
  } catch {
    status.textContent =
      "暂时无法读取 GitHub 发布列表，可直接前往 Releases 查看。CLI 安装方式见下方。";
  }
}
