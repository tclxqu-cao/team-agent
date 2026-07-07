// ── @agent/sdk ──
// Web Component SDK for embedding AI agent chat into any web app.
//
// Usage (CDN):
//   <script type="module" src="https://cdn.../agent-sdk.umd.js"></script>
//   <agent-chat token="xxx" server="https://..."></agent-chat>
//
// Usage (npm):
//   import '@agent/sdk';
//   // or: import { defineCustomElements } from '@agent/sdk';
//   //     defineCustomElements();

import './components/AgentChat';
import './components/AgentFab';

export { AgentChat } from './components/AgentChat';
export { AgentFab } from './components/AgentFab';
export { AgentClient } from './client/AgentClient';
export { ChatStore } from './store/ChatStore';
export type { AgentEvent, ChatMessage, Session, ToolCall, AskUserQuestion, RemoteToolRegistration } from './client/types';

/**
 * Explicitly register custom elements.
 * Not strictly necessary — elements are auto-registered on import.
 * Provided for explicit control in environments where you want
 * to defer registration.
 */
export function defineCustomElements(): void {
  // Elements are already registered via @customElement decorator.
  // This function exists as an explicit API for documentation purposes.
  if (!customElements.get('agent-chat')) {
    // Force module evaluation (already imported above)
    void 0;
  }
}
