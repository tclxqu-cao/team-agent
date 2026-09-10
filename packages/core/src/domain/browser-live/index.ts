/** @deprecated 领域语言已迁移到 `../live-view/`；Browser* 命名仅为兼容别名，wire 协议名不变。 */
export type { LiveViewSource as BrowserBackend } from "../live-view/entities.js";
export type { LiveViewTransport as BrowserTransport } from "../live-view/entities.js";
export type { LiveViewAvailability as BrowserLiveAvailability } from "../live-view/entities.js";
export type { LiveViewOwnershipState as BrowserOwnershipState } from "../live-view/entities.js";
export type { LiveViewViewport as BrowserViewport } from "../live-view/entities.js";
export type { LiveViewSessionView as BrowserLiveSessionView } from "../live-view/entities.js";
export type { LiveViewInput as BrowserInput } from "../live-view/entities.js";
export type { LiveViewEvent as BrowserLiveEvent } from "../live-view/entities.js";
export type { LiveViewPeer as BrowserLivePeer } from "../live-view/entities.js";
export { LiveViewRegistry as BrowserLiveRegistry } from "../live-view/live-view-registry.js";
export type { PublishLiveSession as PublishBrowserSession } from "../live-view/live-view-registry.js";
