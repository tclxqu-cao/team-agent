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
    if (el && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none") { input = el; break; }
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

// CDP 主路径先写入并聚焦；提交阶段再按稳定语义定位真实发送控件，
// 找不到时由主进程通过 Input.dispatchKeyEvent 发送受信任的 Enter 键。
export function buildFillInputScript(adapter: HubAdapterId | undefined, text: string): string {
  const spec = ADAPTER_SELECTORS[adapter ?? "generic"];
  return `(() => {
  const TEXT = ${JSON.stringify(text)};
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 12 && getComputedStyle(el).visibility !== "hidden";
  };
${inputLocatorScript(spec.inputs.length > 0, JSON.stringify(spec.inputs))}
  if (!input) throw new Error("input-not-found");
  const baseline = {
    url: location.href,
    userCount: document.querySelectorAll('[data-message-author-role="user"], user-query').length,
    outputCount: document.querySelectorAll('[data-message-author-role="assistant"], .ds-markdown, model-response').length,
    inputLength: TEXT.length,
  };
  input.focus();
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
  return baseline;
})()`;
}

export function buildSubmissionProbeScript(baseline: { url: string; userCount: number; outputCount: number; inputLength: number }): string {
  return `(() => {
    const before = new URL(${JSON.stringify(baseline.url)});
    const navigated = location.href !== before.href;
    const startedFromHome = before.pathname === "/" || before.pathname === "";
    const userCount = document.querySelectorAll('[data-message-author-role="user"], user-query').length;
    const outputCount = document.querySelectorAll('[data-message-author-role="assistant"], .ds-markdown, model-response').length;
    const input = document.querySelector("#chat-input, textarea, [contenteditable='true'], [contenteditable='']");
    const inputLength = String(input?.value || input?.textContent || "").length;
  const hasSourceAttachment = [...document.querySelectorAll("button")]
    .some((button) => String(button.innerText || "").includes("粘贴原文至输入框"));
  const composerSubmitted = ${baseline.inputLength} > 0 && inputLength === 0 && !hasSourceAttachment;
  const conversationAdvanced = userCount > ${baseline.userCount} || outputCount > ${baseline.outputCount} || composerSubmitted;
  // DeepSeek may turn a long prompt into a source attachment on the first
  // click. Navigation alone only means the conversation shell was created;
  // the attachment still needs a second submit before the model can answer.
  const attachmentPending = hasSourceAttachment
    && userCount <= ${baseline.userCount}
    && outputCount <= ${baseline.outputCount};
  return { submitted: !attachmentPending && (navigated || (!startedFromHome && conversationAdvanced)), navigated, userCount, outputCount, inputLength, hasSourceAttachment };
})()`;
}

export const SEND_TARGET_SCRIPT = `(() => {
  const input = document.querySelector("#chat-input, textarea, [contenteditable='true'], [contenteditable='']");
  if (!input) return null;
  const inputRect = input.getBoundingClientRect();
  const semantic = [
    "button[type='submit']:not([disabled])",
    "button[data-testid='send-button']:not([disabled])",
    "button[aria-label*='发送']:not([disabled])",
    "button[aria-label*='Send']:not([disabled])",
    "[role='button'].ds-button--primary.ds-button--filled.ds-button--circle:not(.ds-button--disabled)",
  ];
  const candidates = semantic.flatMap((selector) => [...document.querySelectorAll(selector)]);
  const target = candidates
    .filter((el, index) => candidates.indexOf(el) === index)
    .map((el) => ({ el, rect: el.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width > 0 && rect.height > 0
      && rect.left >= inputRect.left
      && rect.top >= inputRect.top - 180
      && rect.top <= inputRect.bottom + 180)
    .sort((a, b) => b.rect.right - a.rect.right)[0];
  if (!target) return null;
  target.el.click();
  return { clicked: true };
})()`;

// executeJavaScript(script, true) 执行异步 IIFE；失败时由主进程走剪贴板回退。
export function buildAdapterScript(adapter: HubAdapterId | undefined, text: string): string {
  const spec = ADAPTER_SELECTORS[adapter ?? "generic"];
  const useExplicit = spec.inputs.length > 0;
  return `(async () => {
  const TEXT = ${JSON.stringify(text)};
  const SEND_SELECTORS = ${JSON.stringify(spec.sends)};
  const beforeUrl = location.href;
  const countUserMessages = () => document.querySelectorAll('[data-message-author-role="user"], user-query').length;
  const beforeUserCount = countUserMessages();
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
  await new Promise((resolve) => setTimeout(resolve, 700));
  // 发送：优先点击发送按钮，找不到则向输入框派发 Enter
  for (const sel of SEND_SELECTORS) {
    const candidates = document.querySelectorAll(sel);
    const button = [...candidates].find((b) => !b.disabled && b.getBoundingClientRect().width > 0);
    if (button) {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 700));
      if (location.href !== beforeUrl || countUserMessages() > beforeUserCount) return true;
    }
  }
  // DOM class names on AI sites are frequently hashed. As a shared fallback,
  // locate the enabled control nearest the input's lower-right edge. This
  // handles both ordinary text and sites that convert long text into an
  // attachment card while retaining the send arrow in the same composer.
  const findNearbyButton = () => {
    const inputRect = input.getBoundingClientRect();
    return [...document.querySelectorAll("button, [role='button']")]
      .filter((button) => visible(button) && !button.disabled)
      .map((button) => ({ button, rect: button.getBoundingClientRect() }))
      .filter(({ rect }) => {
        const centerY = rect.top + rect.height / 2;
        return centerY >= inputRect.top - 160
          && centerY <= inputRect.bottom + 160
          && rect.left >= inputRect.left + inputRect.width * 0.55;
      })
      .sort((left, right) => (right.rect.right - left.rect.right) || (right.rect.bottom - left.rect.bottom))[0]?.button;
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const nearbyButton = findNearbyButton();
    if (nearbyButton) nearbyButton.click();
    else {
      const keyOptions = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      input.dispatchEvent(new KeyboardEvent("keydown", keyOptions));
      input.dispatchEvent(new KeyboardEvent("keyup", keyOptions));
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (location.href !== beforeUrl || countUserMessages() > beforeUserCount) return true;
  }
  throw new Error("submit-not-confirmed");
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

// 站点把长回复截断后挂出的「继续生成」控件：只按可见按钮的精确文案匹配，
// 不依赖随机 hash class（站点改版常漂移）。裸「继续」不匹配 —— 部分站点把
// 同文案的推荐 chip 点击后会变成用户消息，误点会污染会话。
const CONTINUE_LABELS = ['继续生成', '继续回答', 'continue', 'continue generation', 'continue generating', 'continue response'];
const CONTINUE_FINDER_SNIPPET = `
  const continueLabels = ${JSON.stringify(CONTINUE_LABELS)};
  const findContinueButton = () => {
    const candidates = [...document.querySelectorAll("button, [role='button']")].filter((el) => {
      const label = String(el.innerText || el.getAttribute("aria-label") || "").trim().toLowerCase();
      if (!continueLabels.includes(label)) return false;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0
        && style.visibility !== "hidden" && style.display !== "none"
        && style.opacity !== "0" && style.pointerEvents !== "none";
    });
    const inViewport = candidates.filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.bottom > 0 && rect.right > 0
        && rect.top < document.documentElement.clientHeight
        && rect.left < document.documentElement.clientWidth;
    });
    return (inViewport.length ? inViewport : candidates).at(-1);
  };`;

// 只探测不点击：随会话抽取一起返回 pendingContinue，供 Provider 判断生成被截断。
export function buildContinueProbeScript(): string {
  return `(() => {${CONTINUE_FINDER_SNIPPET}
  return { pendingContinue: Boolean(findContinueButton()) };
})()`;
}

// 无 CDP 的旧运行时回退：触发 DOM click 后由主进程继续确认页面状态变化。
export const CONTINUE_BUTTON_SCRIPT = `(() => {${CONTINUE_FINDER_SNIPPET}
  const button = findContinueButton();
  if (!button) return { clicked: false };
  button.click();
  return { clicked: true };
})()`;

// CDP 可信鼠标事件需要视口坐标。这里只定位并校验命中目标，不先触发 DOM click，
// 避免同一次续写被合成 click 与真实鼠标事件重复提交。
export const CONTINUE_TARGET_SCRIPT = `(() => {${CONTINUE_FINDER_SNIPPET}
  const button = findContinueButton();
  if (!button) return { found: false };
  button.scrollIntoView({ block: "nearest", inline: "nearest" });
  const rect = button.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(x, y);
  const clickable = !hit || hit === button || button.contains(hit);
  return { found: true, clickable, x, y };
})()`;

// 会话抽取：站点专属选择器优先（ChatGPT 角色属性 / Gemini 自定义元素 / DeepSeek markdown 组），
// 全部落空返回空列表由调用方展示"暂不支持"。纯同步只读 DOM，不注入任何内容。
// debug 字段带页面 URL/标题与各策略命中数，站点改版时便于远程定位选择器漂移。
export const CONVERSATION_EXTRACT_SCRIPT = `(() => {
  const LIMIT_TURNS = 30;
  // Keep the complete in-progress message inside the relay's text budget.
  // A small prefix cap makes a long response look stable while the page is
  // still generating, so the provider can return reasoning or a partial answer.
  const LIMIT_CHARS = 100000;
  const clean = (t) => String(t || "")
    .replace(/\\r\\n/g, "\\n")
    .replace(/[ \\t]+\\n/g, "\\n")
    .replace(/\\n{3,}/g, "\\n\\n")
    .trim()
    .slice(0, LIMIT_CHARS);
  const out = [];${CONTINUE_FINDER_SNIPPET}
  const pendingContinue = Boolean(findContinueButton());
  const stopLabels = ["停止生成", "停止回答", "stop", "stop generating", "stop response"];
  const generating = [...document.querySelectorAll("button,[role='button']")].some((el) => {
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || getComputedStyle(el).visibility === "hidden" || getComputedStyle(el).display === "none") return false;
    const label = String(el.innerText || el.getAttribute("aria-label") || "").trim().toLowerCase();
    return stopLabels.some((candidate) => label === candidate || label.includes(candidate));
  });
  const push = (role, el) => { const text = clean(el.innerText); if (text) out.push({ role, text }); };
  const deepSeekText = (el) => {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('annotation[encoding="application/x-tex"]').forEach((annotation) => {
      const source = annotation.textContent;
      const rendered = annotation.closest(".katex, math, mjx-container") || annotation.parentElement;
      if (source != null && rendered) rendered.replaceWith(document.createTextNode("$" + source + "$"));
    });
    const protocolText = clean(clone.textContent);
    if (/"type"\\s*:\\s*"tool_call"/.test(protocolText)) return protocolText;
    const markdown = (node) => {
      if (node.nodeType === 3) return node.textContent || "";
      if (node.nodeType !== 1 || node.matches("button,script,style,svg")) return "";
      if (node.tagName === "PRE") {
        const code = node.querySelector("code") || node;
        const languageClass = [...code.classList].find((name) => name.startsWith("language-"));
        const language = languageClass ? languageClass.slice(9) : "";
        const body = code.textContent || "";
        const tick = String.fromCharCode(96);
        const runs = [...body.matchAll(new RegExp(tick + "+", "g"))].map((match) => match[0].length + 1);
        const fence = tick.repeat(Math.max(3, ...runs));
        return "\\n" + fence + language + "\\n" + body + "\\n" + fence + "\\n";
      }
      if (node.tagName === "TABLE") {
        const rows = [...node.querySelectorAll("tr")].map((row) => [...row.querySelectorAll("th,td")]
          .map((cell) => String(cell.innerText || cell.textContent || "").trim().replace(/\\|/g, "\\\\|")));
        if (!rows.length) return "";
        return "\\n" + rows.map((row, index) => "| " + row.join(" | ") + " |"
          + (index === 0 ? "\\n| " + row.map(() => "---").join(" | ") + " |" : "")).join("\\n") + "\\n";
      }
      const children = [...node.childNodes].map(markdown).join("");
      if (node.tagName === "CODE") return String.fromCharCode(96) + children + String.fromCharCode(96);
      if (["STRONG", "B"].includes(node.tagName)) return "**" + children + "**";
      if (["EM", "I"].includes(node.tagName)) return "*" + children + "*";
      if (node.tagName === "A") {
        const href = node.getAttribute("href") || "";
        try {
          const url = new URL(href, location.href);
          if (["http:", "https:"].includes(url.protocol)) return "[" + children + "](" + url.href + ")";
        } catch {}
        return children;
      }
      if (node.tagName === "IMG") return node.alt ? "[图片：" + node.alt + "]" : "[图片]";
      if (node.tagName === "BR") return "\\n";
      if (node.tagName === "LI") {
        const ordered = node.parentElement?.tagName === "OL";
        const index = ordered ? [...node.parentElement.children].indexOf(node) + 1 : 0;
        return "\\n" + (ordered ? index + ". " : "- ") + children.trim();
      }
      if (/^H[1-6]$/.test(node.tagName)) return "\\n" + "#".repeat(Number(node.tagName.slice(1))) + " " + children.trim() + "\\n";
      if (node.tagName === "BLOCKQUOTE") return "\\n" + children.trim().split("\\n").map((line) => "> " + line).join("\\n") + "\\n";
      if (/^(P|DIV|UL|OL)$/.test(node.tagName)) return "\\n" + children + "\\n";
      return children;
    };
    return clean(markdown(clone));
  };
  const debug = {
    url: location.href.slice(0, 200),
    title: document.title.slice(0, 80),
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
    scroll: { x: window.scrollX, y: window.scrollY },
    gptCount: document.querySelectorAll('[data-message-author-role]').length,
    gemCount: document.querySelectorAll("user-query, model-response").length,
    dsCount: document.querySelectorAll(".ds-markdown").length,
    bodyChars: (document.body?.innerText || "").length,
    bodyPreview: (document.body?.innerText || "").slice(0, 500),
    textareaCount: document.querySelectorAll("textarea").length,
    editableCount: document.querySelectorAll("[contenteditable='true'],[contenteditable='']").length,
    inputRects: [...document.querySelectorAll("textarea, [contenteditable='true'],[contenteditable='']")].map((el) => {
      const rect = el.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, valueLength: String(el.value || el.textContent || "").length };
    }),
    controls: [...document.querySelectorAll("button, [role='button']")].map((el) => {
      const rect = el.getBoundingClientRect();
      return { tag: el.tagName, type: el.getAttribute("type"), aria: el.getAttribute("aria-label"), disabled: Boolean(el.disabled), left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    }).filter((item) => item.width > 0 && item.height > 0).slice(-30),
    hasSourceAttachment: [...document.querySelectorAll("button")]
      .some((button) => String(button.innerText || "").includes("粘贴原文至输入框")),
  };
  const gpt = document.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]');
  if (gpt.length > 0) {
    gpt.forEach((el) => push(el.getAttribute("data-message-author-role") === "user" ? "user" : "assistant", el));
    return { strategy: "chatgpt", messages: out.slice(-LIMIT_TURNS), generating, pendingContinue, debug };
  }
  const gem = document.querySelectorAll("user-query, model-response");
  if (gem.length > 0) {
    gem.forEach((el) => push(el.tagName.toLowerCase() === "user-query" ? "user" : "assistant", el));
    return { strategy: "gemini", messages: out.slice(-LIMIT_TURNS), generating, pendingContinue, debug };
  }
  const ds = document.querySelectorAll(".ds-markdown");
  if (ds.length > 0) {
    // DeepSeek renders reasoning and the final answer as separate ds-markdown
    // nodes that may have different parents. Collect all of them in document
    // order; injected user bubbles are intentionally recovered by the
    // provider's pre-send baseline rather than guessed from obfuscated classes.
    ds.forEach((el) => { const text = deepSeekText(el); if (text) out.push({ role: "assistant", text }); });
    return { strategy: "deepseek", messages: out.slice(-LIMIT_TURNS), generating, pendingContinue, debug };
  }
  // Providers without stable message classes still need protocol recovery.
  // Only use this fallback when no ordered provider messages were found;
  // otherwise an old tool_call elsewhere in the page would mask a newer final
  // answer after the tool result has been sent back.
  const toolCallCandidates = [...document.querySelectorAll("body *")]
    .map((el) => ({ text: clean(el.innerText) }))
    .filter(({ text }) => text.startsWith("{") && text.includes('"type"') && text.includes('"tool_call"'))
    .sort((left, right) => left.text.length - right.text.length);
  for (const candidate of toolCallCandidates) {
    try {
      const parsed = JSON.parse(candidate.text);
      if (parsed && parsed.type === "tool_call" && typeof parsed.name === "string") {
        return { strategy: "tool-protocol", messages: [{ role: "assistant", text: candidate.text }], generating, pendingContinue, debug };
      }
    } catch {}
  }
  return { strategy: "none", messages: [], generating, pendingContinue, debug };
})()`;
