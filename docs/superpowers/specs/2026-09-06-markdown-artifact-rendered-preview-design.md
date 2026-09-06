# Markdown 交付物渲染预览设计

## 目标

Web 文件预览中的眼睛按钮对 Markdown 文件展示排版后的页面，而不是浏览器直接输出 `text/markdown` 原文。源码视图、编辑、Diff、下载和分享保持不变，用户仍可用同一个眼睛按钮在渲染预览与源码之间切换。

## 方案选择

采用服务端 ticket 路由渲染 Markdown。服务端读取已通过路径授权的 `.md` 文件，用成熟 Markdown 解析器生成完整 HTML 文档，再由现有 sandbox iframe 展示。这样可复用 HTML 交付物已经验证过的相对资源解析、短期 ticket、路径复验和隔离边界。

不采用浏览器原生 `text/markdown`，因为主流浏览器只显示源文本。也不在 `FilePreview` 主页面直接插入生成的 HTML，避免把不可信内容放进控制台自身 DOM，并避免额外维护客户端分块拼接后的重新渲染状态。

## 渲染与安全边界

- 支持常用 Markdown：标题、段落、列表、引用、链接、图片、表格、任务列表和代码块。
- Markdown 内嵌原生 HTML 按文本处理，不执行内嵌脚本、事件处理器或 iframe。
- 渲染文档使用独立 iframe；CSP 禁止脚本，只允许渲染所需的内联样式和受限图片/媒体资源。
- 相对图片等资源继续通过同一 ticket 的子路径读取，并再次经过 `HostPathPolicy` 校验。
- 外部链接可点击，但不能取得 Web 控制台的 cookie、存储或同源能力。
- 渲染页提供内置响应式排版样式，在桌面和移动端都限制正文宽度、处理长代码和宽表格溢出。

## 数据流

点击 Markdown 的眼睛按钮后，`FilePreview` 仍调用 `fs:preview-open` 获取短期 URL，但像 HTML 一样追加经过编码的文件名。ticket HTTP 路由识别主 Markdown 文件，将其转换为 `text/html; charset=utf-8` 响应；同一 URL 下的相对资源请求仍按原文件目录解析并以原始 MIME 流式返回。

JSON、XML、CSV、源码、配置和日志继续使用浏览器原始预览；HTML 继续使用现有 HTML 预览行为。只有 Markdown 家族扩展名改变。

## 错误与容量

- 文件不存在、越权或 ticket 过期时沿用现有 403/404 行为。
- Markdown 读取或解析失败时返回受隔离的错误页，外层预览继续提供重试。
- 对渲染读取设置明确上限，避免超大 Markdown 阻塞服务；超过上限时保留源码渐进式阅读，并在渲染视图显示容量提示。

## 实现范围

- `packages/server/ws-server.mjs`：区分 Markdown 主文档请求，生成安全 HTML 响应并设置专用 CSP。
- `packages/server/lib/`：放置可单测的 Markdown 文档渲染和响应逻辑。
- `packages/server/app/web/FilePreview.tsx`：Markdown 渲染预览使用带文件名的 ticket URL，并更新眼睛按钮提示。
- `packages/server/app/web/FilePreview.test.ts` 及服务端测试：覆盖格式渲染、HTML 转义、脚本禁用、相对资源、软链接和容量边界。
- `packages/server/package.json` 与锁文件：复用仓库当前已锁定的 `marked@15.0.12` 作为服务端直接依赖。

## 验证

- 单元测试确认 Markdown 标题、表格、代码块和相对图片被渲染，原生 HTML/脚本不执行。
- 回归 HTML、JSON、源码、图片和 PDF 预览行为。
- 运行 Server 类型检查、相关测试、WebApp 与 Server 生产构建及 `git diff --check`。
- 使用真实浏览器在桌面和 `390x844` 下点击 Markdown 眼睛按钮，确认显示排版效果、可切回源码、相对图片可加载且无横向溢出。
