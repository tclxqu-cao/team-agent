/**
 * DOM event fired on window when the web shell's tab-bar "远程桌面" button asks
 * the embedded renderer to open the browser-live panel. The web shell bridge
 * (packages/webapp presentation/web-shell-live.ts) translates its postMessage
 * into this event; see ChatView for the listener.
 *
 * Kept in a dependency-free module so the webapp can import the constant
 * without pulling React types into its typecheck program.
 */
export const OPEN_BROWSER_LIVE_EVENT = "agentroam:open-browser-live";
