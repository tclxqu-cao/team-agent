import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_CLIENT_DOWNLOAD_BYTES,
  decodeTextChunk,
  mimeTypeForPath,
  readFileForClientDownload,
  shareFileWithNativePicker,
} from "./FilePreview";
import { WEB_THEMES } from "./themes";

const filePreviewSource = readFileSync(new URL("./FilePreview.tsx", import.meta.url), "utf8");

describe("FilePreview client download", () => {
  it("reads an allowed file in chunks and assembles one browser blob", async () => {
    const source = Buffer.from("presentation-bytes");
    const progress: number[] = [];
    const rpc = vi.fn(async (type: string, params?: Record<string, unknown>) => {
      if (type === "fs:stat") return { size: source.length, dir: false };
      const offset = Number(params?.offset ?? 0);
      const length = Number(params?.length ?? source.length);
      const chunk = source.subarray(offset, offset + length);
      return {
        data: chunk.toString("base64"),
        bytes: chunk.length,
        offset,
        eof: offset + chunk.length >= source.length,
        size: source.length,
      };
    });
    const gatewayRpc = <T,>(type: string, params?: Record<string, unknown>, _timeoutMs?: number) => (
      rpc(type, params) as Promise<T>
    );

    const blob = await readFileForClientDownload("/tmp/deck.pptx", gatewayRpc, (value) => progress.push(value), 5);

    expect(Buffer.from(await blob.arrayBuffer()).toString()).toBe("presentation-bytes");
    expect(rpc).toHaveBeenCalledWith("fs:stat", { path: "/tmp/deck.pptx" });
    expect(progress.at(-1)).toBe(100);
  });

  it("rejects oversized files before reading content", async () => {
    const rpc = vi.fn(async () => ({ size: MAX_CLIENT_DOWNLOAD_BYTES + 1, dir: false }));
    const gatewayRpc = <T,>() => rpc() as Promise<T>;

    await expect(readFileForClientDownload("/tmp/huge.bin", gatewayRpc)).rejects.toThrow("文件超过 256M");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("surfaces file read failures", async () => {
    const rpc = vi.fn(async () => {
      throw new Error("gateway unavailable");
    });

    await expect(readFileForClientDownload("/tmp/report.pdf", rpc)).rejects.toThrow("gateway unavailable");
  });

  it("shares the original file through the native picker", async () => {
    const file = { name: "report.pdf" } as File;
    const canShare = vi.fn(() => true);
    const share = vi.fn(async () => {});

    await expect(shareFileWithNativePicker(file, { canShare, share })).resolves.toBe("shared");
    expect(canShare).toHaveBeenCalledWith({ files: [file] });
    expect(share).toHaveBeenCalledWith({ files: [file], title: "report.pdf" });
  });

  it("keeps native share cancellation silent", async () => {
    const file = { name: "report.pdf" } as File;
    const cancelled = Object.assign(new Error("cancelled"), { name: "AbortError" });

    await expect(shareFileWithNativePicker(file, {
      canShare: () => true,
      share: vi.fn(async () => { throw cancelled; }),
    })).resolves.toBe("cancelled");
  });

  it.each([
    { canShare: undefined, share: undefined },
    { canShare: () => false, share: vi.fn(async () => {}) },
  ])("falls back when native file sharing is unavailable", async (client) => {
    const file = { name: "report.pdf" } as File;

    await expect(shareFileWithNativePicker(file, client)).resolves.toBe("unsupported");
  });

  it("provides useful MIME types for shared files", () => {
    expect(mimeTypeForPath("/tmp/report.PDF")).toBe("application/pdf");
    expect(mimeTypeForPath("/tmp/deck.pptx")).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
    expect(mimeTypeForPath("/tmp/archive.unknown")).toBe("application/octet-stream");
  });

  it("inherits preview surfaces and text colors from the selected shell skin", () => {
    expect(WEB_THEMES.map((theme) => theme.cssVars["--ui-color-scheme"])).toEqual(["light", "dark", "dark"]);
    expect(filePreviewSource).toContain('background: "var(--ui-term-col-bg, #101014)"');
    expect(filePreviewSource).toContain('background: "var(--ui-tree-bg, #121218)"');
    expect(filePreviewSource).toContain('color: "var(--ui-text, #e8e8ee)"');
    expect(filePreviewSource).toContain('"var(--ui-history-item-text, var(--ui-text, #d6d6de))"');
    expect(filePreviewSource).not.toContain('background: "#101014"');
    expect(filePreviewSource).not.toContain('color: "#e8e8ee"');
  });

  it("loads text progressively while keeping diff and editing on demand", () => {
    expect(filePreviewSource).toContain('"fs:inspect-text-status"');
    expect(filePreviewSource).toContain('"fs:read"');
    expect(filePreviewSource).toContain("length: 256 * 1024");
    expect(filePreviewSource).toContain('"fs:inspect-text"');
    expect(filePreviewSource).toContain('"fs:write-text"');
    expect(filePreviewSource).toContain('aria-label="编辑文件"');
    expect(filePreviewSource).toContain('aria-label={saving ? "正在保存" : "保存修改"}');
    expect(filePreviewSource).toContain('<DiffPreview rows={parsedDiff.rows} />');
    expect(filePreviewSource).toContain('onClick={selectDiffView}');
    expect(filePreviewSource).toContain('setView("file")');
    expect(filePreviewSource).toContain("new IntersectionObserver");
    expect(filePreviewSource).toContain("chunkInFlightRef.current");
    expect(filePreviewSource).toContain("generation !== generationRef.current");
    expect(filePreviewSource).toContain("textChunks.map");
  });

  it("preserves UTF-8 characters split across preview chunks", () => {
    const bytes = Buffer.from("A你B", "utf8");
    const decoder = new TextDecoder("utf-8", { fatal: false });

    expect(decodeTextChunk(decoder, bytes.subarray(0, 2).toString("base64"), false)).toBe("A");
    expect(decodeTextChunk(decoder, bytes.subarray(2).toString("base64"), true)).toBe("你B");
  });

  it("uses ticketed browser streaming and native readiness events for rich media", () => {
    expect(filePreviewSource).toContain('"fs:preview-open"');
    expect(filePreviewSource).toContain('"fs:preview-close"');
    expect(filePreviewSource).not.toContain('rpc<MediaPreviewResult>("fs:dataurl"');
    expect(filePreviewSource).toContain("onLoad={() => markMediaReady(mediaUrl)}");
    expect(filePreviewSource).toContain("onLoadedMetadata={() => markMediaReady(mediaUrl)}");
    expect(filePreviewSource).toContain("onError={() => markMediaFailed(mediaUrl)}");
    expect(filePreviewSource).toContain("activeMediaUrlRef.current !== expectedUrl");
  });

  it("shows stable skin-aware feedback for initial and incremental loading", () => {
    expect(filePreviewSource).toContain('label="正在加载文件"');
    expect(filePreviewSource).toContain('"正在加载更多"');
    expect(filePreviewSource).toContain("ref={loadMoreRef}");
    expect(filePreviewSource).toContain('color: "var(--ui-tab-accent, #7aa2f7)"');
    expect(filePreviewSource).not.toContain("继续加载");
  });

  it("keeps an active draft when the watched file changes", () => {
    expect(filePreviewSource).toContain("if (kind === \"text\" && editingRef.current)");
    expect(filePreviewSource).toContain("setExternalChange(true)");
    expect(filePreviewSource).toContain("expectedMtime: meta.mtime");
    expect(filePreviewSource).toContain("expectedSize: meta.size");
  });

  it("places a native file share action between download and close", () => {
    const downloadButton = filePreviewSource.indexOf('aria-label={downloadProgress === null ? "下载到当前设备"');
    const shareButton = filePreviewSource.indexOf('aria-label="分享文件"');
    const closeButton = filePreviewSource.indexOf('aria-label="关闭预览"');

    expect(filePreviewSource).toContain("Share2");
    expect(filePreviewSource).toContain("当前浏览器不支持直接分享文件，已改为下载");
    expect(downloadButton).toBeGreaterThan(-1);
    expect(shareButton).toBeGreaterThan(downloadButton);
    expect(closeButton).toBeGreaterThan(shareButton);
  });
});
