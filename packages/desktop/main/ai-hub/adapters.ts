import type { HubAdapterId } from "./config";

// 站点 DOM 会随改版漂移：选择器是尽力而为，主进程侧有剪贴板粘贴回退兜底。
const ADAPTER_SELECTORS: Record<HubAdapterId, { inputs: string[]; sends: string[] }> = {
  deepseek: { inputs: ["#chat-input", "textarea"], sends: [] },
  chatgpt: {
    inputs: ["#prompt-textarea", "form div[contenteditable='true']"],
    sends: ["button[data-testid='send-button']", "button[aria-label='Send prompt']", "button[aria-label*='发送']"],
  },
  gemini: {
    inputs: ["rich-textarea div[contenteditable='true']", "div.ql-editor[contenteditable='true']", "div[contenteditable='true']"],
    sends: ["button[aria-label*='发送']", "button[aria-label*='Send']", "button.send-button"],
  },
  grok: {
    inputs: ["textarea[aria-label]", "textarea", "div[contenteditable='true']"],
    sends: ["button[type='submit']", "button[aria-label*='Submit']"],
  },
  generic: { inputs: [], sends: [] }, // generic 走"视口内最大可见输入框"启发式
};

function inputLocatorScript(useExplicitSelectors: boolean, inputsJson: string): string {
  if (!useExplicitSelectors) {
    return `
  let input = null;
  {
    let best = null, bestArea = 0;
    for (const el of document.querySelectorAll("textarea, [contenteditable='true'], [contenteditable='']")) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = el; }
    }
    input = best;
  }`;
  }
  return `
  let input = null;
  const INPUT_SELECTORS = ${inputsJson};
  for (const sel of INPUT_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && visible(el)) { input = el; break; }
  }`;
}

// 图片粘贴前只聚焦站点输入框，保留站点已有草稿。
export function buildFocusInputScript(adapter: HubAdapterId | undefined): string {
  const spec = ADAPTER_SELECTORS[adapter ?? "generic"];
  return `(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 12 && getComputedStyle(el).visibility !== "hidden";
  };
${inputLocatorScript(spec.inputs.length > 0, JSON.stringify(spec.inputs))}
  if (!input) throw new Error("input-not-found");
  input.focus();
  return true;
})()`;
}

// executeJavaScript(script, true) 执行异步 IIFE；失败时由主进程走剪贴板回退。
export function buildAdapterScript(adapter: HubAdapterId | undefined, text: string): string {
  const spec = ADAPTER_SELECTORS[adapter ?? "generic"];
  const useExplicit = spec.inputs.length > 0;
  return `(async () => {
  const TEXT = ${JSON.stringify(text)};
  const SEND_SELECTORS = ${JSON.stringify(spec.sends)};
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 12 && getComputedStyle(el).visibility !== "hidden";
  };
${inputLocatorScript(useExplicit, JSON.stringify(spec.inputs))}
  if (!input) throw new Error("input-not-found");
  input.focus();
  // 写入文本：textarea/input 用 native setter + input 事件（兼容 React 受控组件）；contenteditable 用 insertText
  if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
    const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(input, TEXT);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    const selection = window.getSelection();
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(input);
    selection.addRange(range);
    if (!document.execCommand("insertText", false, TEXT)) {
      input.textContent = TEXT;
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
  }
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  // 发送：优先点击发送按钮，找不到则向输入框派发 Enter
  for (const sel of SEND_SELECTORS) {
    const candidates = document.querySelectorAll(sel);
    const button = [...candidates].find((b) => !b.disabled && b.getBoundingClientRect().width > 0);
    if (button) { button.click(); return true; }
  }
  const keyOptions = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
  input.dispatchEvent(new KeyboardEvent("keydown", keyOptions));
  input.dispatchEvent(new KeyboardEvent("keyup", keyOptions));
  return true;
})()`;
}

// 剪贴板回退路径：webContents.paste() 之后向当前焦点元素派发 Enter
export const ENTER_DISPATCH_SCRIPT = `(() => {
  const el = document.activeElement;
  if (!el) return false;
  const options = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent("keydown", options));
  el.dispatchEvent(new KeyboardEvent("keyup", options));
  return true;
})()`;

// 会话抽取：站点专属选择器优先（ChatGPT 角色属性 / Gemini 自定义元素 / DeepSeek markdown 组），
// 全部落空返回空列表由调用方展示"暂不支持"。纯同步只读 DOM，不注入任何内容。
// debug 字段带页面 URL/标题与各策略命中数，站点改版时便于远程定位选择器漂移。
export const CONVERSATION_EXTRACT_SCRIPT = `(() => {
  const LIMIT_TURNS = 30;
  const LIMIT_CHARS = 6000;
  const clean = (t) => String(t || "").replace(/\\n{3,}/g, "\\n\\n").trim().slice(0, LIMIT_CHARS);
  const out = [];
  const push = (role, el) => { const text = clean(el.innerText); if (text) out.push({ role, text }); };
  const debug = {
    url: location.href.slice(0, 200),
    title: document.title.slice(0, 80),
    gptCount: document.querySelectorAll('[data-message-author-role]').length,
    gemCount: document.querySelectorAll("user-query, model-response").length,
    dsCount: document.querySelectorAll(".ds-markdown").length,
    bodyChars: (document.body?.innerText || "").length,
  };
  const gpt = document.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]');
  if (gpt.length > 0) {
    gpt.forEach((el) => push(el.getAttribute("data-message-author-role") === "user" ? "user" : "assistant", el));
    return { strategy: "chatgpt", messages: out.slice(-LIMIT_TURNS), debug };
  }
  const gem = document.querySelectorAll("user-query, model-response");
  if (gem.length > 0) {
    gem.forEach((el) => push(el.tagName.toLowerCase() === "user-query" ? "user" : "assistant", el));
    return { strategy: "gemini", messages: out.slice(-LIMIT_TURNS), debug };
  }
  const ds = document.querySelectorAll(".ds-markdown");
  if (ds.length > 0) {
    const container = ds[0].parentElement;
    if (container) {
      for (const child of container.children) {
        if (child.querySelector(":scope .ds-markdown")) push("assistant", child);
        else push("user", child);
      }
      return { strategy: "deepseek", messages: out.slice(-LIMIT_TURNS), debug };
    }
  }
  return { strategy: "none", messages: [], debug };
})()`;
