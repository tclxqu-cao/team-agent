import { describe, expect, it } from "vitest";
import { parseRelayMessage, relaySocketPath } from "./relay";

describe("parseRelayMessage", () => {
  it("接受 status 请求", () => {
    expect(parseRelayMessage(JSON.stringify({ id: "r1", type: "status" }))).toEqual({ kind: "status" });
  });

  it("接受合法 broadcast 请求", () => {
    const request = parseRelayMessage(JSON.stringify({ id: "r2", type: "broadcast", text: "你好", siteIds: ["deepseek", "chatgpt"] }));
    expect(request).toEqual({ kind: "broadcast", text: "你好", siteIds: ["deepseek", "chatgpt"], images: [] });
  });

  it("接受文本 + 图片的 broadcast，图片以 data URL 透传", () => {
    const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    const request = parseRelayMessage(JSON.stringify({ type: "broadcast", text: "看这张图", siteIds: ["chatgpt"], images: [image] }));
    expect(request).toEqual({ kind: "broadcast", text: "看这张图", siteIds: ["chatgpt"], images: [image] });
  });

  it("接受纯图片 broadcast（空文本 + 合法图片）", () => {
    const image = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
    const request = parseRelayMessage(JSON.stringify({ type: "broadcast", text: "", siteIds: ["deepseek"], images: [image] }));
    expect(request?.kind).toBe("broadcast");
    expect(request?.kind === "broadcast" && request.text).toBe("");
    expect(request?.kind === "broadcast" && request.images).toEqual([image]);
  });

  it("拒绝坏 JSON / 非对象 / 未知类型", () => {
    expect(parseRelayMessage("{not json")).toBeNull();
    expect(parseRelayMessage("42")).toBeNull();
    expect(parseRelayMessage(JSON.stringify({ type: "nope" }))).toBeNull();
  });

  it("图片校验：非 data:image 前缀 / 超长条目被丢弃，最多保留 4 张", () => {
    const good = "data:image/png;base64,iVBORw0KGgo=";
    const bad = ["not-an-image", "data:text/html;base64,PGI+", `data:image/png;base64,${"A".repeat(4_000_001)}`, 42, null];
    const request = parseRelayMessage(JSON.stringify({
      type: "broadcast",
      text: "hi",
      siteIds: ["deepseek"],
      images: [...bad, good, good, good, good, good],
    }));
    expect(request?.kind === "broadcast" && request.images).toEqual([good, good, good, good]);
  });

  it("broadcast 缺文本 / 纯空白 / 超长文本 / 缺站点为非法", () => {
    const build = (text: string, siteIds: unknown) => JSON.stringify({ type: "broadcast", text, siteIds });
    expect(parseRelayMessage(build("", ["deepseek"]))).toBeNull();
    expect(parseRelayMessage(build("   ", ["deepseek"]))).toBeNull();
    expect(parseRelayMessage(build("x".repeat(20_001), ["deepseek"]))).toBeNull();
    expect(parseRelayMessage(build("hi", "deepseek"))).toBeNull();
    expect(parseRelayMessage(build("hi", []))).toBeNull();
  });

  it("接受 capture 请求并截断站点列表", () => {
    const request = parseRelayMessage(JSON.stringify({ type: "capture", siteIds: ["chatgpt", 3, "grok"] }));
    expect(request).toEqual({ kind: "capture", siteIds: ["chatgpt", "grok"] });
    expect(parseRelayMessage(JSON.stringify({ type: "capture", siteIds: [] }))).toBeNull();
    expect(parseRelayMessage(JSON.stringify({ type: "capture" }))).toBeNull();
  });

  it("siteIds 过滤非字符串并截断到 8 个", () => {
    const request = parseRelayMessage(JSON.stringify({ type: "broadcast", text: "hi", siteIds: ["a", 3, null, "b"] }));
    expect(request).toMatchObject({ kind: "broadcast", siteIds: ["a", "b"] });
    const many = parseRelayMessage(JSON.stringify({ type: "broadcast", text: "hi", siteIds: Array.from({ length: 20 }, (_, i) => `s${i}`) }));
    expect(many?.kind === "broadcast" && many.siteIds).toHaveLength(8);
  });
});

describe("relaySocketPath", () => {
  it("落在指定目录下且以 .sock 结尾", () => {
    const path = relaySocketPath("/tmp/aihub-test");
    expect(path.startsWith("/tmp/aihub-test")).toBe(true);
    expect(path.endsWith("ai-hub-relay.sock")).toBe(true);
  });
});
