import { describe, expect, it, vi } from "vitest";
import { requestArtifactFileContextMenu } from "./artifact-file-context-menu";

describe("artifact file context-menu dispatch", () => {
  it.each(["/Users/test/Word 优化版.docx", "~/Downloads/report.docx", "C:\\work\\report.docx", "\\\\host\\share\\report.docx"])("routes a local file to the device menu: %s", async (path) => {
    const event = { preventDefault: vi.fn() };
    const menu = vi.fn(async () => ({ shown: true as const }));
    await expect(requestArtifactFileContextMenu(event, path, menu)).resolves.toEqual({ shown: true });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(menu).toHaveBeenCalledWith(path);
  });

  it.each(["https://example.com/report.docx", "file:///tmp/report.docx", "report.docx", "javascript:alert(1)", "/tmp/bad\nname"])("leaves unsupported paths to the default browser action: %s", (path) => {
    const event = { preventDefault: vi.fn() };
    const menu = vi.fn();
    expect(requestArtifactFileContextMenu(event, path, menu)).toBeNull();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(menu).not.toHaveBeenCalled();
  });

  it("does not take over right-click without the desktop bridge and preserves host errors", async () => {
    const event = { preventDefault: vi.fn() };
    expect(requestArtifactFileContextMenu(event, "/tmp/report.docx")).toBeNull();
    expect(event.preventDefault).not.toHaveBeenCalled();
    const menu = vi.fn(async (): Promise<{ shown: true }> => { throw new Error("文件不存在或无法访问"); });
    await expect(requestArtifactFileContextMenu(event, "/tmp/report.docx", menu)).rejects.toThrow("文件不存在或无法访问");
  });

  it("passes the displayed text and line separately from the artifact path", async () => {
    const event = { preventDefault: vi.fn() };
    const menu = vi.fn(async () => ({ shown: true as const }));
    const path = "C:\\工作区\\Refund SDK\\branch.ts";
    const options = { label: "feature_req_refund_work_order_submit_hook_cq_261118", line: 24 };
    await requestArtifactFileContextMenu(event, path, menu, options);
    expect(menu).toHaveBeenCalledWith(path, options);
  });
});
