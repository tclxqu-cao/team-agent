// Serialized into the selected provider tab. Keep this function self-contained.
export function pageAction(siteId, action, payload = {}) {
  const origins = { chatgpt: "https://chatgpt.com", gemini: "https://gemini.google.com", grok: "https://grok.com" };
  if (location.origin !== origins[siteId] || /^\/(auth|login|signin|sign-in|signup)(\/|$)/i.test(location.pathname)
    || document.querySelector('input[type="password"],input[autocomplete="one-time-code"]')) throw new Error("chrome-auth-required");
  const hidden = (el) => el.matches('[hidden],[aria-hidden="true"],.sr-only,.srOnly,.cdk-visually-hidden,.visually-hidden')
    || getComputedStyle(el).display === "none" || getComputedStyle(el).visibility === "hidden";
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && !hidden(el) && style.opacity !== "0"
      && (!el.checkVisibility || el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  };
  const specs = {
    chatgpt: { input: ['#prompt-textarea', 'form [contenteditable="true"]'], send: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label*="发送"]'], turns: '[data-message-author-role="user"],[data-message-author-role="assistant"]', stop: 'button[data-testid="stop-button"],button[aria-label*="Stop streaming"]' },
    gemini: { input: ['rich-textarea [contenteditable="true"]', '.ql-editor[contenteditable="true"]'], send: ['button.send-button', 'button[aria-label*="发送"]', 'button[aria-label*="Send message"]'], turns: 'user-query,model-response', stop: 'button[aria-label*="Stop response"],button[aria-label*="停止回答"],button.stop-button' },
    grok: { input: ['textarea[aria-label]', 'textarea', '[contenteditable="true"][role="textbox"]', '[contenteditable="true"]'], send: ['button[type="submit"]', 'button[aria-label*="Send"]', 'button[aria-label*="Submit"]', 'button[aria-label*="发送"]'], turns: '[data-message-author-role], [data-role="user"], [data-role="assistant"], [data-testid="user-message"], [data-testid="assistant-message"], .message-bubble, .response-content-markdown', stop: 'button[aria-label*="Stop"],button[aria-label*="停止"]' },
  };
  const spec = specs[siteId];
  if (!spec) throw new Error("chrome-site-unsupported");
  const find = (selectors) => selectors.flatMap((sel) => [...document.querySelectorAll(sel)]).find(visible);
  const input = find(spec.input);
  const draft = () => (input?.value ?? input?.innerText ?? "").trim();
  const text = (el) => (el?.innerText ?? el?.textContent ?? "").trim();
  const markdown = (node) => {
    if (node.nodeType === 3) return node.textContent ?? "";
    if (node.nodeType !== 1 || (node.matches('button,script,style,svg') || hidden(node))) return "";
    if (node.tagName === "PRE") {
      const code = node.querySelector("code") ?? node;
      const language = [...code.classList].find((name) => name.startsWith("language-"))?.slice(9) ?? "";
      const body = code.textContent ?? "";
      const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)));
      return `\n${fence}${language}\n${body}\n${fence}\n`;
    }
    if (node.tagName === "TABLE") {
      const rows = [...node.querySelectorAll("tr")].map((row) => [...row.querySelectorAll("th,td")].map((cell) => text(cell).replace(/\|/g, "\\|")));
      if (!rows.length) return "";
      return '\n' + rows.map((row, i) => '| ' + row.join(' | ') + ' |' + (i === 0 ? '\n| ' + row.map(() => '---').join(' | ') + ' |' : '')).join('\n') + '\n';
    }
    const children = [...node.childNodes].map(markdown).join("");
    if (node.tagName === "CODE") return '`' + children + '`';
    if (["STRONG", "B"].includes(node.tagName)) return '**' + children + '**';
    if (["EM", "I"].includes(node.tagName)) return '*' + children + '*';
    if (node.tagName === "A") {
      const href = node.getAttribute("href") ?? "";
      try { const url = new URL(href, location.href); if (['http:', 'https:'].includes(url.protocol)) return `[${children}](${url.href})`; } catch {}
      return children;
    }
    if (node.tagName === "IMG") return node.alt ? `[图片：${node.alt}]` : "[图片]";
    if (node.tagName === "BR") return '\n';
    if (node.tagName === "LI") return '\n- ' + children.trim();
    if (/^(P|DIV|H[1-6]|UL|OL|BLOCKQUOTE)$/.test(node.tagName)) return '\n' + children + '\n';
    return children;
  };
  const plainText = (node) => {
    if (node.nodeType === 3) return node.textContent ?? "";
    if (node.nodeType !== 1 || node.matches("button,script,style,svg") || hidden(node)) return "";
    if (node.tagName === "BR") return "\n";
    const value = [...node.childNodes].map(plainText).join("");
    return /^(P|DIV|PRE|LI|H[1-6])$/.test(node.tagName) ? "\n" + value + "\n" : value;
  };
  const all = [...document.querySelectorAll(spec.turns)].filter(visible);
  const turns = all.filter((el) => !all.some((parent) => parent !== el && parent.contains(el)));
  const messages = turns.map((el, index) => {
    const author = el.getAttribute('data-message-author-role') ?? el.getAttribute('data-role');
    const isUser = author === 'user' || el.tagName === 'USER-QUERY' || el.getAttribute('data-testid') === 'user-message'
      || (siteId === 'grok' && !author && el.getAttribute('data-testid') !== 'assistant-message' && el.matches('.message-bubble') && !el.querySelector('.response-content-markdown,.markdown,.prose'));
    const bodySelectors = siteId === 'gemini' && isUser
      ? ['.query-text', '.query-content'] : ['.response-content-markdown', '.markdown-main-panel', '.markdown', '.query-text', '.query-content'];
    const body = bodySelectors.flatMap(sel => [...el.querySelectorAll(sel)]).find(visible) ?? el;
    // ChatGPT virtualizes older turns. Its message ID survives index/count changes.
    const messageId = el.getAttribute('data-message-id') || null;
    return { id: `${index}:${messageId ?? el.id ?? ''}`.slice(0,512), messageId, role: isUser ? 'user' : 'assistant', content: markdown(body).replace(/\n{3,}/g, '\n\n').trim().slice(0, 50_000), plainText: plainText(body).trim().slice(0, 50_000) };
  }).filter((message) => message.content);
  const enabled = el => !el.disabled && el.getAttribute("aria-disabled") !== "true";
  const stopButtons = [...document.querySelectorAll(spec.stop)].filter(visible);
  const generating = stopButtons.some(enabled);
  // 站点把长回复截断后挂出的「继续生成」控件：只按可见按钮精确文案匹配，
  // 裸「继续」不匹配，避免误点点击后会变成用户消息的推荐 chip。
  const continueLabels = ['继续生成', '继续回答', 'continue', 'continue generation', 'continue generating', 'continue response'];
  const isContinueLabel = (el) => continueLabels.includes((text(el) || el.getAttribute("aria-label") || "").toLowerCase());
  const continueButtons = [...document.querySelectorAll("button,[role='button']")].filter((el) => visible(el) && isContinueLabel(el));
  const recent = messages.slice(-100);
  let total = recent.reduce((sum, message) => sum + message.content.length, 0);
  while (total > 1_000_000 && recent.length) total -= recent.shift().content.length;
  // Gemini announces rejected optimistic sends through its live region/snackbar.
  // Return only the numeric website error, never arbitrary page text.
  let websiteError = null;
  if (siteId === 'gemini') {
    for (const el of document.querySelectorAll('[role="alert"],[aria-live],.cdk-live-announcer-element,mat-snack-bar-container,.mat-mdc-snack-bar-container')) {
      const match = /(?:出了点问题|发生错误|Something went wrong)\s*[（(](\d{1,6})[)）]/i.exec(el.textContent ?? '');
      if (match) { websiteError = `chrome-gemini-error-${match[1]}`; break; }
    }
  }
  const snapshot = {
    conversationId: location.pathname.slice(0, 512), messages: recent,
    userCount: messages.filter((message) => message.role === 'user').length,
    generating, composerAvailable: !!input, draft: draft(), websiteError,
    pendingContinue: continueButtons.some(enabled),
    debug: { visible: document.visibilityState === "visible", focused: document.hasFocus(),
      turnCount: turns.length, userCount: messages.filter(m => m.role === "user").length,
      assistantCount: messages.filter(m => m.role === "assistant").length,
      stopButtons: stopButtons.map(el => ({ enabled: enabled(el), testId: el.getAttribute("data-testid"), label: el.getAttribute("aria-label") })),
      continueButtons: continueButtons.map(el => ({ enabled: enabled(el), label: text(el).slice(0, 20) })),
      composerTag: input?.tagName ?? null, draftLength: draft().length },
  };
  if (action === 'snapshot') return snapshot;
  if (action === 'continue') {
    const button = continueButtons.find(enabled);
    if (generating || !button) return { clicked: false };
    button.scrollIntoView({ block: 'nearest' });
    button.click();
    return { clicked: true };
  }
  if (!input) throw new Error('chrome-input-not-found');
  if (generating) throw new Error('chrome-generating');
  if (action === 'prepare') {
    if (draft() && draft() !== String(payload.text ?? '').trim()) throw new Error('chrome-existing-draft');
    input.focus();
    if (typeof input.select === 'function') input.select();
    else { const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(input); selection.removeAllRanges(); selection.addRange(range); }
    return snapshot;
  }
  if (action === 'focus') { input.focus(); return { focused: document.activeElement === input || input.contains(document.activeElement) }; }
  if (action === 'submit-target') {
    if (draft() !== String(payload.text ?? '').trim()) throw new Error('chrome-input-not-applied');
    const candidates = spec.send.flatMap((sel) => [...document.querySelectorAll(sel)]).filter(visible);
    const button = candidates.find((el) => enabled(el) && !el.matches(spec.stop));
    if (button) { button.scrollIntoView({ block: 'nearest' }); const r = button.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (hit !== button && !button.contains(hit)) throw new Error('chrome-send-obscured');
      return { kind: 'button', x, y }; }
    return { kind: candidates.length ? 'disabled' : 'enter' };
  }
  throw new Error('chrome-action-unsupported');
}
