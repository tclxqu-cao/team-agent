import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MAX_CLIENT_DOWNLOAD_BYTES, readFileForClientDownload } from "./FilePreview";
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

  it("inherits preview surfaces and text colors from the selected shell skin", () => {
    expect(WEB_THEMES.map((theme) => theme.cssVars["--ui-color-scheme"])).toEqual(["light", "dark", "dark"]);
    expect(filePreviewSource).toContain('background: "var(--ui-term-col-bg, #101014)"');
    expect(filePreviewSource).toContain('background: "var(--ui-tree-bg, #121218)"');
    expect(filePreviewSource).toContain('color: "var(--ui-text, #e8e8ee)"');
    expect(filePreviewSource).toContain('"var(--ui-history-item-text, var(--ui-text, #d6d6de))"');
    expect(filePreviewSource).not.toContain('background: "#101014"');
    expect(filePreviewSource).not.toContain('color: "#e8e8ee"');
  });

  it("loads a Git-aware text preview and exposes edit and save controls", () => {
    expect(filePreviewSource).toContain('"fs:inspect-text"');
    expect(filePreviewSource).toContain('"fs:write-text"');
    expect(filePreviewSource).toContain('aria-label="编辑文件"');
    expect(filePreviewSource).toContain('aria-label={saving ? "正在保存" : "保存修改"}');
    expect(filePreviewSource).toContain('<DiffPreview rows={parsedDiff.rows} />');
    expect(filePreviewSource).toContain('setView(result.patch ? "diff" : "file")');
  });

  it("keeps an active draft when the watched file changes", () => {
    expect(filePreviewSource).toContain("if (kind === \"text\" && editingRef.current)");
    expect(filePreviewSource).toContain("setExternalChange(true)");
    expect(filePreviewSource).toContain("expectedMtime: meta.mtime");
    expect(filePreviewSource).toContain("expectedSize: meta.size");
  });
});
