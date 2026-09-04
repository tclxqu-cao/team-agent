# 交付物预览原生文件分享 Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Web 端交付物预览中将当前文件交给系统分享面板，并在不支持文件分享时降级为下载。

**Architecture:** 在现有 `FilePreview` 中复用分块文件读取函数，增加一个可独立测试的原生分享适配函数。组件只负责加载状态、错误提示和下载降级，服务端协议保持不变。

**Tech Stack:** React 18、TypeScript、Next.js 14、Lucide React、Vitest

## Global Constraints

- 分享内容必须是文件本身，不上传文件、不生成公网链接。
- 微信、企业微信和 QQ 是否出现由操作系统及已安装应用决定。
- 文件读取沿用 256 MiB 客户端上限。
- 用户取消分享时保持静默，不触发下载。
- 编辑状态不显示分享入口。

---

### Task 1: 原生文件分享适配

**Files:**
- Modify: `packages/server/app/web/FilePreview.tsx`
- Unit tests: `packages/server/app/web/FilePreview.test.ts`

**Interfaces:**
- Consumes: 浏览器 `navigator.canShare`、`navigator.share` 与 `File`
- Produces: `shareFileWithNativePicker(file, client): Promise<"shared" | "cancelled" | "unsupported">` 和 `mimeTypeForPath(path): string`

- [x] **Step 1: 增加 MIME 类型解析与分享结果类型**

为常见图片、音视频、PDF、Office、文本与压缩包扩展名返回具体 MIME；未知扩展名返回 `application/octet-stream`。

- [x] **Step 2: 实现可测试的原生分享适配函数**

```ts
export async function shareFileWithNativePicker(file: File, client: NativeShareClient) {
  if (!client.share || !client.canShare?.({ files: [file] })) return "unsupported";
  try {
    await client.share({ files: [file], title: file.name });
    return "shared";
  } catch (error) {
    if (isAbortError(error)) return "cancelled";
    throw error;
  }
}
```

- [x] **Step 3: 覆盖分享成功、取消和不支持场景**

在 `FilePreview.test.ts` 中传入 Vitest mock client，断言分享参数包含原文件、取消返回 `cancelled`、缺少能力或 `canShare=false` 返回 `unsupported`。

### Task 2: 预览头部分享交互

**Files:**
- Modify: `packages/server/app/web/FilePreview.tsx`
- Unit tests: `packages/server/app/web/FilePreview.test.ts`

**Interfaces:**
- Consumes: `readFileForClientDownload`、`shareFileWithNativePicker`、现有 `HEADER_BUTTON_STYLES`
- Produces: 非编辑态分享按钮、稳定加载/完成状态、下载降级和用户可见错误

- [x] **Step 1: 抽取 Blob 下载动作供下载与分享降级复用**

```ts
function downloadBlob(blob: Blob, path: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName(path);
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
```

- [x] **Step 2: 实现分享状态和点击处理**

点击后读取一次文件并构造保留名称、MIME 和修改时间的 `File`。`shared` 显示短暂完成态，`cancelled` 静默结束，`unsupported` 使用同一 Blob 下载并显示降级提示，其他异常显示分享失败。

- [x] **Step 3: 在下载和关闭之间渲染分享按钮**

使用 Lucide `Share2`；加载时使用固定尺寸 `LoaderCircle`，完成时使用 `Check`。分享或下载进行中时禁用两个文件动作，编辑态沿用现有取消与保存按钮而不显示分享。

- [x] **Step 4: 补充组件契约断言**

断言源码包含 `aria-label="分享文件"`、`Share2`、降级提示，以及分享按钮位于关闭按钮之前。

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/server/app/web/FilePreview.test.ts`
Expected: PASS

Run: `bunx tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --jsx preserve --lib ES2022,DOM --strict --skipLibCheck --esModuleInterop packages/server/app/web/FilePreview.tsx`
Expected: PASS

If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.
