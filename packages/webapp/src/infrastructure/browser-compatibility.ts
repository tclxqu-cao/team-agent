// Native Android shells use the installed system WebView, which can predate
// the array APIs used by the shared renderer even on a supported Android OS.
import "core-js/actual/array/at";
import "core-js/actual/array/find-last";
import "core-js/actual/array/find-last-index";
import "core-js/actual/structured-clone";

export function installBrowserCompatibility(): void {
  if (typeof AbortSignal.timeout === "function") return;

  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    writable: true,
    value: (milliseconds: number): AbortSignal => {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
      }, milliseconds);
      return controller.signal;
    },
  });
}
