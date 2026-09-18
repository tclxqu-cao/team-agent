import React from "react";
import ReactDOM from "react-dom/client";
import { SharedServiceRoot } from "./SharedServiceRoot";
import "./styles/global.css";
import "./styles/composer.css";

// Global renderer error capture: forward errors into the desktop main
// process's per-day log file through the preload bridge. Reporting must
// never affect the app — every failure path is swallowed.
(function installRendererErrorReporting() {
  const report = (level: "error" | "warn", message: string, error?: unknown): void => {
    try {
      const described = error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack?.slice(0, 8000) }
        : undefined;
      void window.clientLogApi?.report({ level, message, error: described, data: { href: location.href } });
    } catch {
      // nothing left to do — never re-enter the app from a reporter
    }
  };
  window.addEventListener("error", (event) => report("error", event.message || "window error", event.error));
  window.addEventListener("unhandledrejection", (event) => report("error", `unhandledRejection: ${String(event.reason)}`, event.reason));
})();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SharedServiceRoot />
  </React.StrictMode>,
);
