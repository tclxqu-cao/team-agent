import { describe, expect, it } from "vitest";
import {
  AI_HUB_SITES,
  buildSiteOpenUrl,
  findAiHubSite,
  normalizeSelection,
  siteSupportsPromptUrl,
} from "./aiHubSites";

describe("aiHubSites", () => {
  it("包含四个预设站点", () => {
    expect(AI_HUB_SITES.map((site) => site.id)).toEqual(["deepseek", "gemini", "chatgpt", "grok"]);
  });

  it("ChatGPT 与 Grok 支持 ?q= 预填，DeepSeek/Gemini 不支持", () => {
    expect(siteSupportsPromptUrl("chatgpt")).toBe(true);
    expect(siteSupportsPromptUrl("grok")).toBe(true);
    expect(siteSupportsPromptUrl("deepseek")).toBe(false);
    expect(siteSupportsPromptUrl("gemini")).toBe(false);
  });

  it("buildSiteOpenUrl 对支持站点编码问题文本", () => {
    expect(buildSiteOpenUrl("chatgpt", "帮我写周报")).toBe("https://chatgpt.com/?q=" + encodeURIComponent("帮我写周报"));
    expect(buildSiteOpenUrl("grok", "a b&c")).toBe("https://grok.com/?q=" + encodeURIComponent("a b&c"));
  });

  it("buildSiteOpenUrl 对不支持站点回退首页（空文本同理）", () => {
    expect(buildSiteOpenUrl("deepseek", "随便")).toBe("https://chat.deepseek.com/");
    expect(buildSiteOpenUrl("gemini", "")).toBe("https://gemini.google.com/app");
    expect(buildSiteOpenUrl("chatgpt", "   ")).toBe("https://chatgpt.com/");
  });

  it("未知站点返回空串", () => {
    expect(buildSiteOpenUrl("nope", "x")).toBe("");
    expect(findAiHubSite("nope")).toBeUndefined();
  });

  it("normalizeSelection 过滤非法 id", () => {
    expect(normalizeSelection(["chatgpt", "bogus", "grok"])).toEqual(["chatgpt", "grok"]);
  });

  it("normalizeSelection 空值回退前两个站点", () => {
    expect(normalizeSelection(null)).toEqual(["deepseek", "gemini"]);
    expect(normalizeSelection([])).toEqual(["deepseek", "gemini"]);
    expect(normalizeSelection(["x"])).toEqual(["deepseek", "gemini"]);
  });
});
