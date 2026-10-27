import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import RunFailureNotice from "./RunFailureNotice";

describe("RunFailureNotice", () => {
  it("shows the original quota failure, a historical label, and a model-switch action", () => {
    const switchModel = vi.fn();
    const message = "WorkBuddy AI: usage exceeds frequency limit (429)";
    const html = renderToStaticMarkup(createElement(RunFailureNotice, { message, historical: true, onSwitchModel: switchModel }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("上次执行失败");
    expect(html).toContain(message);
    expect(html).toContain("切换模型</button>");
    expect(html).toContain("不会自动重试");
    expect(switchModel).not.toHaveBeenCalled();
  });

  it("does not suggest changing the model to fix a failed runtime connection", () => {
    const html = renderToStaticMarkup(createElement(RunFailureNotice, { message: "fetch failed", onSwitchModel: vi.fn() }));
    expect(html).toContain("连接失败");
    expect(html).toContain("fetch failed");
    expect(html).toContain("切换模型不能解决此连接错误");
    expect(html).not.toContain("切换模型</button>");
  });

  it("preserves reload and cancellation controls without offering an unavailable model picker", () => {
    const html = renderToStaticMarkup(createElement(RunFailureNotice, { message: "quota exceeded" },
      createElement("button", { type: "button" }, "重新加载"),
    ));
    expect(html).toContain("重新加载</button>");
    expect(html).not.toContain("切换模型</button>");
    expect(html).toContain("flex-wrap:wrap");
    expect(html).toContain("overflow-wrap:anywhere");
  });

  it("wires snapshot recovery and the existing composer picker into the shared web/desktop view", () => {
    const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
    expect(source.match(/latestSessionRunError\(detail\)/g)).toHaveLength(2);
    expect(source).toContain("restoredRunError?.sessionId === viewSessionId");
    expect(source).toContain("if (runningSessionRef.current !== targetSid)");
    expect(source).toContain("supportsNativeModelSelection && nativeModelCatalogReady && nativeModelPickerReady ? () => {");
    expect(source).toContain("ref={modelPickerRef}");
    expect(source).toContain("openRunErrorModelPicker(modelPickerRef.current)");
  });
});
