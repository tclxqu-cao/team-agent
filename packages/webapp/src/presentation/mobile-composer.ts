/**
 * Mobile composer adapter for the web shell.
 *
 * The shared ChatView renders [attach][mic][screenshot]…[send "发送"]. The
 * phone layout exposes a single native <details>/<summary> "+" control and an
 * icon-only round send button. Using the browser's native disclosure state
 * avoids synthetic click/pointer differences across Chrome on iOS/desktop —
 * the browser itself toggles the menu, no JS event handling involved.
 *
 * Loop safety: the observer watches only the composer row, every DOM write
 * is guarded by a divergence check, and row replacement is reconciled from a
 * slow interval — no observer can ever fire on its own writes.
 */

const PLUS_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const ARROW_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
const STOP_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

const HIDE_CLASS = "webapp-composer-hide";
const CONTROL_CLASS = "webapp-plus-control";
const SEND_CLASS = "webapp-native-send";
const STOP_CLASS = "webapp-native-stop";

function createNativePlusControl(): HTMLDetailsElement {
  const control = document.createElement("details");
  control.className = CONTROL_CLASS;

  const summary = document.createElement("summary");
  summary.setAttribute("aria-label", "添加附件、图片或语音");
  summary.innerHTML = PLUS_SVG;

  const menu = document.createElement("div");
  menu.className = "webapp-plus-menu";
  menu.innerHTML = `
    <button data-act="attach" type="button">附件 / 图片</button>
    <button data-act="mic" type="button">语音输入</button>`;

  menu.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!target) return;
    event.stopPropagation();
    control.open = false;

    const row = control.parentElement;
    const attach = row?.querySelector<HTMLButtonElement>(":scope > button:nth-of-type(1)");
    const mic = row?.querySelector<HTMLButtonElement>(":scope > button:nth-of-type(2)");
    if (target.dataset.act === "attach" && attach && !attach.disabled) attach.click();
    if (target.dataset.act === "mic" && mic && !mic.disabled) mic.click();
  });

  // Tap anywhere else closes the menu.
  document.addEventListener("pointerdown", (event) => {
    if (!control.open) return;
    if (event.target instanceof Node && control.contains(event.target)) return;
    control.open = false;
  }, true);

  control.append(summary, menu);
  return control;
}

function ensureNativeAction(
  row: Element,
  className: string,
  label: string,
  icon: string,
): HTMLButtonElement {
  let proxy = row.querySelector<HTMLButtonElement>(`:scope > .${className}`);
  if (!proxy) {
    proxy = document.createElement("button");
    proxy.type = "button";
    proxy.className = className;
    proxy.addEventListener("click", () => {
      const targetSelector = proxy!.dataset.target === "stop"
        ? ":scope > button[data-webapp-original-stop='1']"
        : ":scope > button[data-webapp-original-primary='1']";
      const input = row.querySelector<HTMLInputElement>("input:not([type='file'])");
      if (proxy!.dataset.target !== "primary") {
        row.querySelector<HTMLButtonElement>(targetSelector)?.click();
        return;
      }
      if (!input?.value.trim()) return;

      const current = row.querySelector<HTMLButtonElement>(targetSelector);
      // Normal path: React already mirrored the visible input value. Invoke it
      // immediately so mobile taps cannot be lost to focus/IME transitions.
      if (current && !current.disabled) {
        current.click();
        return;
      }

      // Fallback for the narrow window where mobile IME has painted the text
      // but React has not committed it yet.
      input.dispatchEvent(new CompositionEvent("compositionend", {
        bubbles: true,
        data: input.value,
      }));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const committed = row.querySelector<HTMLButtonElement>(targetSelector);
        if (committed && !committed.disabled) committed.click();
        else {
          input.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            bubbles: true,
            cancelable: true,
          }));
        }
      }));
    });
    row.appendChild(proxy);
  }
  proxy.dataset.target = className === STOP_CLASS ? "stop" : "primary";
  proxy.innerHTML = icon;
  proxy.setAttribute("aria-label", label);
  proxy.setAttribute("title", label);
  const input = row.querySelector<HTMLInputElement>("input:not([type='file'])");
  // Never set the native disabled attribute on the proxy: mobile users may
  // tap immediately after an IME commit, before the 500ms reconciliation
  // tick. Keep it clickable and express inactive state through data/CSS.
  const inactive = className !== STOP_CLASS && !input?.value.trim();
  proxy.dataset.inactive = inactive ? "1" : "0";
  proxy.setAttribute("aria-disabled", inactive ? "true" : "false");
  proxy.disabled = false;
  return proxy;
}

/** Idempotent DOM pass — writes only on real divergence. */
function applyComposer(): void {
  const row = document.querySelector(".composer-input-row");
  if (!row) return;
  const buttons = row.querySelectorAll<HTMLButtonElement>(":scope > button");
  if (buttons.length < 4) return;
  const [attach, mic, screenshot] = buttons;

  attach.classList.add(HIDE_CLASS);
  attach.setAttribute("aria-hidden", "true");
  attach.tabIndex = -1;
  mic.classList.add(HIDE_CLASS);
  mic.setAttribute("aria-hidden", "true");
  mic.tabIndex = -1;
  screenshot.classList.add(HIDE_CLASS);
  screenshot.setAttribute("aria-hidden", "true");
  screenshot.tabIndex = -1;

  if (!row.querySelector(`:scope > .${CONTROL_CLASS}`)) {
    row.insertBefore(createNativePlusControl(), row.firstElementChild);
  }

  // After the three hidden utility buttons:
  // - idle: one send button
  // - running: queue-send button + stop button
  const actionButtons = [...buttons].slice(3);
  const queueOrSend = actionButtons.find((button) =>
    !(button.title || "").includes("停止"),
  );
  const stop = actionButtons.find((button) =>
    (button.title || "").includes("停止"),
  );

  if (queueOrSend) {
    const isQueue = (queueOrSend.title || "").includes("排队") || (queueOrSend.textContent || "").includes("排队");
    queueOrSend.dataset.webappOriginalPrimary = "1";
    queueOrSend.classList.add(HIDE_CLASS);
    queueOrSend.setAttribute("aria-hidden", "true");
    queueOrSend.tabIndex = -1;
    ensureNativeAction(
      row,
      SEND_CLASS,
      isQueue ? "排队发送" : "发送",
      ARROW_SVG,
    );
  }

  if (stop) {
    stop.dataset.webappOriginalStop = "1";
    stop.classList.add(HIDE_CLASS);
    stop.setAttribute("aria-hidden", "true");
    stop.tabIndex = -1;
    ensureNativeAction(row, STOP_CLASS, "停止生成", STOP_SVG);
  } else {
    row.querySelector(`:scope > .${STOP_CLASS}`)?.remove();
  }
}

export function installMobileComposer(): void {
  let started = false;
  const connect = (attempt = 0): void => {
    const row = document.querySelector(".composer-input-row");
    if (row) {
      applyComposer();
      if (!started) {
        started = true;
        // Deliberately use a low-frequency timer, not MutationObserver.
        // React remounts buttons while a run transitions idle/running; DOM
        // writes from an observer can observe themselves and starve the UI.
        setInterval(applyComposer, 500);
      }
    } else if (attempt < 40) {
      setTimeout(() => connect(attempt + 1), 300);
    }
  };
  connect();
}
