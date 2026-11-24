export type ChromeHubSiteId = "chatgpt" | "gemini" | "grok";

export interface ChromeHubTab {
  siteId: ChromeHubSiteId;
  tabId: number;
  url: string;
}

export interface ChromeHubStatus {
  compatible?: boolean;
  paused?: boolean;
  connected: boolean;
  tabs: ChromeHubTab[];
}

export interface ChromeHubFrame {
  siteId: ChromeHubSiteId;
  data: string;
  width: number;
  height: number;
}

export type ChromeHubInput =
  | { kind: "pointer"; action: "down" | "up" | "move" | "wheel"; x: number; y: number; deltaX?: number; deltaY?: number; button?: "left" | "right" | "middle" }
  | { kind: "key"; action: "down" | "up"; key: string; code: string; modifiers: number }
  | { kind: "text"; text: string };

export interface ChromeHubMessage { id: string; role: "user" | "assistant"; content: string }

export interface ChromeHubConversation {
  siteId: ChromeHubSiteId;
  conversationId: string;
  revision: number;
  messages: ChromeHubMessage[];
  generating: boolean;
  composerAvailable: boolean;
  receivedAt: number;
}

export type ChromeBridgeEvent =
  | { type: "chrome-status"; status: ChromeHubStatus }
  | { type: "chrome-conversation"; conversation: ChromeHubConversation }
  | { type: "chrome-page-error"; siteId: string; error: string }
  | { type: "chrome-frame"; frame: ChromeHubFrame };
