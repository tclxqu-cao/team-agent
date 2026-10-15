# @agent/website

AgentRoam 独立静态官网：产品首页、下载、快速上手。无需安装前端依赖，不依赖产品服务，官网不进入 CLI 或桌面运行包。

```sh
node packages/website/src/build.mjs
node --test packages/website/src/website.test.mjs
node packages/website/src/preview.mjs
```

预览：http://127.0.0.1:4178/team-agent/ 。产物：`packages/website/dist`。

部署由 `.github/workflows/website-pages.yml` 在 `main` 的官网改动后执行。GitHub Pages 的 Source 应设置为 GitHub Actions。正式地址：https://tclxqu-cao.github.io/team-agent/ 。

`public/releases.js` 按 GitHub Releases 匹配 macOS ARM64 DMG、Windows x64 EXE/MSI 和 Android APK，支持 preview 发布。未发布或 API 不可用时保留真实 Releases 入口，不制造下载链接。iOS 使用 Safari/PWA，不把源码或模拟器包当成可安装 IPA。

界面图片来自本地真实运行截图，私人项目名称和路径已遮蔽。`public/assets/sources.json` 记录来源和处理。外部字体不可达时使用系统字体。动效尊重减少动态效果偏好。
