import { mkdir, rm, cp, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { pages } from "./pages.mjs";
import { site, mark, githubIcon } from "./site.mjs";
import { releaseSnapshot } from "../public/release-snapshot.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const dist = resolve(root, "dist");
const assetHash = createHash("sha256");
for (const file of ["app.js", "style.css", "motion.js", "motion.css", "globe.js", "assets/globe-land.json"]) {
  assetHash.update(await readFile(resolve(root, "public", file)));
}
const scriptVersion = encodeURIComponent(`${releaseSnapshot.map((release) => release.tag_name).join(",") || "unreleased"}-${assetHash.digest("hex").slice(0, 12)}`);
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(resolve(root, "public"), dist, { recursive: true });
const stylesheet = await readFile(resolve(dist, "style.css"), "utf8");
await writeFile(resolve(dist, "style.css"), stylesheet.replace('"./motion.css"', `"./motion.css?v=${scriptVersion}"`));
for (const page of pages) {
  const nav = pages
    .map(
      (p) =>
        `<a href="${p.file}" ${p.file === page.file ? 'aria-current="page"' : ""}>${p.label}</a>`,
    )
    .join("");
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#090f14"><meta name="description" content="AgentRoam 把本机 AI Agent、终端、文件和远程桌面放进一个工作台。从桌面开始，在手机、平板和浏览器继续。"><meta property="og:title" content="${page.title} · AgentRoam"><meta property="og:description" content="电脑继续跑。你，自由漫游。"><meta property="og:type" content="website"><meta property="og:image" content="https://tclxqu-cao.github.io/team-agent/assets/social.webp"><title>${page.title} · AgentRoam</title><link rel="icon" href="assets/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="style.css?v=${scriptVersion}"><script type="module" src="app.js?v=${scriptVersion}"></script></head><body><a class="skip-link" href="#main">跳到正文</a><header class="header"><a class="brand" href="index.html" aria-label="AgentRoam 首页">${mark}<span>Agent<span class="brand-light">Roam</span></span></a><nav aria-label="主导航">${nav}</nav><div class="header-actions"><a class="github-link" href="${site.repository}" target="_blank" rel="noopener noreferrer" aria-label="GitHub 项目">${githubIcon}</a><a class="nav-download" href="download.html">下载 <span aria-hidden="true">↗</span></a></div></header><main id="main">${page.content}</main><footer><a class="brand" href="index.html">${mark}<span>AgentRoam</span></a><p>让 AI 留在电脑，让你自由漫游。</p><div>${nav}<a href="${site.repository}" target="_blank" rel="noopener noreferrer">GitHub ↗</a></div><small>© ${new Date().getFullYear()} AgentRoam · Built for the way you work.</small></footer><dialog class="lightbox" aria-label="产品截图预览"><button class="lightbox-close" aria-label="关闭预览">关闭 ×</button><img alt=""></dialog><div class="toast" role="status" aria-live="polite"></div></body></html>`;
  await writeFile(resolve(dist, page.file), html);
}
await writeFile(resolve(dist, ".nojekyll"), "");
await writeFile(
  resolve(dist, "404.html"),
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>页面未找到 · AgentRoam</title><body style="background:#090f14;color:#f2f4f5;font:20px system-ui;padding:10vw"><h1>这个坐标还没有页面。</h1><a style="color:#68e6c5" href="./">返回 AgentRoam 首页 ↗</a></body></html>',
);
console.log(`Built ${pages.length} pages → ${dist}`);
