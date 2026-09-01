import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { AgentClient } from '../client/AgentClient';
import { ChatStore } from '../store/ChatStore';
import { themeStyles } from '../styles/theme';
import type { AgentEvent, ChatMessage, Session, ToolCall, RemoteToolRegistration } from '../client/types';
import { renderMarkdown } from './markdown';
import './AgentFab';

/** 机器人分组固定展示顺序与标签（与会话按机器人分组功能配套） */
const BOT_GROUP_ORDER = ['customer-agent', 'codex', 'claude-code'] as const;
type BotAgentType = (typeof BOT_GROUP_ORDER)[number];
const BOT_GROUP_LABELS: Record<BotAgentType, string> = {
  'customer-agent': 'Customer Agent',
  codex: 'Codex',
  'claude-code': 'Claude Code',
};

/**
 * Main SDK component — embed as <agent-chat token="..." server="..."></agent-chat>
 * Provides a floating button + chat panel with full agent interaction.
 */
@customElement('agent-chat')
export class AgentChat extends LitElement {
  @property({ type: String }) token = '';
  @property({ type: String }) server = '';
  @property({ type: String }) position: 'bottom-right' | 'bottom-left' = 'bottom-right';
  @property({ type: String }) theme: 'light' | 'dark' | 'auto' = 'auto';
  @property({ type: String }) title = 'AI 助手';
  @property({ type: String }) placeholder = '输入消息...';
  @property({ type: String, attribute: 'session-id' }) sessionIdAttr = '';
  @property({ type: String, attribute: 'project-id' }) projectId = '';
  @property({ attribute: 'remote-tools' }) remoteTools: RemoteToolRegistration[] | string = [];

  @state() private _store = new ChatStore();
  /** 会话列表按机器人（agentType）分组，且每组可折叠 */
  @state() private _groupByBot = false;
  @state() private _collapsedBotGroups: Set<string> = new Set();
  private client: AgentClient | null = null;
  private currentSessionId = '';
  private registrationPromise: Promise<void> = Promise.resolve();
  private registrationError: unknown = null;
  private unsubClient: (() => void) | null = null;
  private unsubStore: (() => void) | null = null;
  private shouldAutoScroll = true;

  static styles = [
    themeStyles,
    css`
      :host {
        all: initial;
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 99999;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }

      /* ── Chat Panel ── */
      .panel {
        pointer-events: auto;
        position: fixed;
        bottom: 96px;
        right: 24px;
        width: 380px;
        height: min(600px, 70vh);
        background: var(--bg-surface);
        border: 1px solid var(--border-default);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-md);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        opacity: 0;
        transform: translateY(20px) scale(0.95);
        transition: opacity 0.25s var(--ease-out), transform 0.25s var(--ease-out);
      }
      :host([position='bottom-left']) .panel {
        right: auto;
        left: 24px;
      }
      .panel.open {
        opacity: 1;
        transform: translateY(0) scale(1);
      }

      /* ── Header ── */
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 12px 14px;
        border-bottom: 1px solid var(--border-subtle);
        background: var(--bg-deepest);
        flex-shrink: 0;
        position: relative;
      }
      .header-title {
        flex: 1;
        min-width: 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .header-actions {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .header-btn,
      .header-close {
        width: 28px; height: 28px;
        border: none; border-radius: 6px;
        background: transparent;
        color: var(--text-muted);
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        transition: background 0.15s, color 0.15s;
      }
      .header-btn:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }
      .header-btn:hover:not(:disabled),
      .header-close:hover {
        background: var(--bg-deep);
        color: var(--text-primary);
      }
      .session-menu {
        position: absolute;
        top: 44px;
        left: 10px;
        right: 10px;
        max-height: 280px;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        background: var(--bg-deepest);
        border: 1px solid var(--border-default);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-md);
        z-index: 1;
      }
      .session-menu-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px;
        border-bottom: 1px solid var(--border-subtle);
      }
      .session-menu-title {
        color: var(--text-secondary);
        font-size: 12px;
        font-weight: 600;
      }
      .session-new-btn {
        height: 28px;
        padding: 0 10px;
        border: none;
        border-radius: 6px;
        background: var(--accent);
        color: white;
        font-size: 12px;
        cursor: pointer;
      }
      .session-new-btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .session-list {
        overflow-y: auto;
        padding: 6px;
      }
      .session-item {
        width: 100%;
        min-height: 40px;
        padding: 7px 8px;
        border: 1px solid transparent;
        border-radius: 8px;
        background: transparent;
        color: var(--text-primary);
        cursor: pointer;
        display: flex;
        flex-direction: column;
        align-items: stretch;
        text-align: left;
      }
      .session-item:hover {
        background: var(--bg-deep);
      }
      .session-item.active {
        border-color: var(--border-glow);
        background: var(--accent-dim);
      }
      .session-item:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .session-item-title {
        font-size: 12px;
        line-height: 1.3;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .session-item-meta {
        margin-top: 2px;
        color: var(--text-muted);
        font-size: 10px;
        line-height: 1.2;
      }
      .session-empty {
        padding: 16px 8px;
        color: var(--text-muted);
        font-size: 12px;
        text-align: center;
      }
      /* ── 会话按机器人分组 ── */
      .bot-toggle {
        width: 26px; height: 26px;
        border: none; border-radius: 6px;
        background: transparent;
        color: var(--text-muted);
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        transition: background 0.15s, color 0.15s;
      }
      .bot-toggle:hover {
        background: var(--bg-deep);
        color: var(--text-primary);
      }
      .bot-toggle.on {
        background: var(--accent-dim);
        color: var(--accent);
      }
      .bot-group-header {
        width: 100%;
        display: flex; align-items: center; gap: 6px;
        padding: 6px 6px 4px;
        border: none;
        background: transparent;
        color: var(--text-muted);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        cursor: pointer;
        text-align: left;
      }
      .bot-group-header:hover {
        color: var(--text-secondary);
      }
      .bot-group-header .chev {
        flex-shrink: 0;
        transition: transform 0.2s ease;
      }
      .bot-group-header.collapsed .chev {
        transform: rotate(-90deg);
      }
      .bot-group-label {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .bot-group-count {
        flex-shrink: 0;
        font-size: 9px;
        padding: 0 5px;
        border-radius: 8px;
        background: var(--bg-deep);
        color: var(--text-muted);
      }
      .bot-group-body {
        padding-bottom: 4px;
      }
      /* ── 机器人分组批量操作 ── */
      .bot-actions {
        display: flex;
        gap: 4px;
        padding: 4px 8px;
        border-bottom: 1px solid var(--border-subtle);
      }
      .bot-actions button {
        flex: 1;
        padding: 3px 0;
        border: 1px solid var(--border-subtle);
        border-radius: 6px;
        background: transparent;
        color: var(--text-muted);
        font-size: 10px;
        line-height: 1.4;
        cursor: pointer;
        transition: color 0.15s, border-color 0.15s;
      }
      .bot-actions button:hover {
        color: var(--text-primary);
        border-color: var(--border-default);
      }

      /* ── Messages ── */
      .messages {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        scrollbar-width: thin;
      }
      .messages::-webkit-scrollbar { width: 6px; }
      .messages::-webkit-scrollbar-thumb {
        background: var(--border-default);
        border-radius: 3px;
      }
      .empty {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-muted);
        font-size: 13px;
      }

      /* ── Message Bubbles ── */
      .msg-user {
        align-self: flex-end;
        max-width: 80%;
        padding: 10px 14px;
        background: var(--accent);
        color: white;
        border-radius: 16px 16px 4px 16px;
        font-size: 13px;
        line-height: 1.5;
        word-break: break-word;
      }
      .msg-assistant {
        align-self: flex-start;
        max-width: 85%;
        padding: 10px 14px;
        background: var(--bg-deep);
        color: var(--text-primary);
        border-radius: 16px 16px 16px 4px;
        font-size: 13px;
        line-height: 1.5;
        word-break: break-word;
      }
      .msg-assistant p { margin: 0 0 6px; }
      .msg-assistant p:last-child { margin-bottom: 0; }
      .msg-assistant ul { margin: 4px 0; padding-left: 18px; }
      .msg-assistant li { margin: 2px 0; }
      .msg-assistant code {
        padding: 1px 5px;
        border: 1px solid var(--border-subtle);
        border-radius: 4px;
        background: var(--bg-surface);
        font-family: 'SF Mono', 'Monaco', monospace;
        font-size: 11.5px;
      }
      .msg-assistant pre {
        margin: 6px 0;
        padding: 8px 10px;
        overflow-x: auto;
        border: 1px solid var(--border-subtle);
        border-radius: 8px;
        background: var(--bg-deepest);
      }
      .msg-assistant pre code {
        padding: 0;
        border: none;
        background: none;
        white-space: pre-wrap;
      }
      .msg-assistant p { margin: 0 0 6px; }
      .msg-assistant p:last-child { margin-bottom: 0; }
      .msg-assistant h3, .msg-assistant h4, .msg-assistant h5, .msg-assistant h6 {
        margin: 8px 0 4px;
        font-size: 13px;
        font-weight: 700;
      }
      .msg-assistant ul { margin: 4px 0; padding-left: 18px; }
      .msg-assistant li { margin: 2px 0; }
      .msg-assistant code {
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: 4px;
        padding: 1px 5px;
        font-family: 'SF Mono', 'Monaco', monospace;
        font-size: 11.5px;
      }
      .msg-assistant pre {
        background: var(--bg-deepest);
        border: 1px solid var(--border-subtle);
        border-radius: 8px;
        padding: 8px 10px;
        margin: 6px 0;
        overflow-x: auto;
      }
      .msg-assistant pre code {
        background: none;
        border: none;
        padding: 0;
        white-space: pre-wrap;
        word-break: break-all;
      }
      .msg-assistant table {
        border-collapse: collapse;
        margin: 6px 0;
        font-size: 12px;
        width: 100%;
      }
      .msg-assistant th, .msg-assistant td {
        border: 1px solid var(--border-default);
        padding: 4px 8px;
        text-align: left;
      }
      .msg-assistant th {
        background: var(--bg-surface);
        font-weight: 600;
      }
      .msg-assistant strong { font-weight: 700; }
      .msg-assistant.streaming::after {
        content: '▋';
        animation: blink 1s infinite;
        color: var(--accent);
      }
      @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }

      .msg-thinking {
        align-self: flex-start;
        padding: 10px 14px;
        background: var(--bg-deep);
        border-radius: 16px 16px 16px 4px;
        color: var(--text-muted);
        font-size: 13px;
        font-style: italic;
      }
      .error-msg {
        align-self: center;
        padding: 8px 16px;
        background: rgba(244, 63, 94, 0.1);
        color: var(--danger);
        border: 1px solid rgba(244, 63, 94, 0.3);
        border-radius: 8px;
        font-size: 12px;
      }

      /* ── Tool Call Card ── */
      .tool-card {
        align-self: flex-start;
        max-width: 85%;
        border: 1px solid var(--border-subtle);
        border-radius: 8px;
        overflow: hidden;
      }
      .tool-header {
        padding: 8px 12px;
        background: var(--bg-deep);
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--text-secondary);
        user-select: none;
      }
      .tool-header:hover { background: var(--bg-surface); }
      .tool-status {
        font-size: 11px;
        margin-left: auto;
      }
      .tool-status.ok { color: var(--success); }
      .tool-status.err { color: var(--danger); }
      .tool-body {
        padding: 8px 12px;
        font-size: 11px;
        color: var(--text-muted);
        font-family: 'SF Mono', 'Monaco', monospace;
        white-space: pre-wrap;
        max-height: 200px;
        overflow-y: auto;
        border-top: 1px solid var(--border-subtle);
      }
      .tool-body.hidden { display: none; }

      /* ── Ask User Card ── */
      .ask-user {
        align-self: flex-start;
        max-width: 85%;
        padding: 12px 14px;
        background: var(--bg-deep);
        border-radius: 12px;
        border: 1px solid var(--border-glow);
      }
      .ask-user-question {
        font-size: 13px;
        color: var(--text-primary);
        margin-bottom: 10px;
      }
      .ask-user-options {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .ask-user-option {
        padding: 8px 12px;
        border: 1px solid var(--border-default);
        border-radius: 8px;
        background: var(--bg-surface);
        color: var(--text-primary);
        font-size: 12px;
        cursor: pointer;
        text-align: left;
        transition: border-color 0.15s, background 0.15s;
      }
      .ask-user-option:hover {
        border-color: var(--accent);
        background: var(--accent-dim);
      }
      .ask-user-option .opt-label { font-weight: 600; }
      .ask-user-option .opt-desc {
        display: block;
        font-size: 11px;
        opacity: 0.7;
        margin-top: 2px;
      }
      .ask-user-input-row {
        display: flex;
        gap: 6px;
      }
      .ask-user-input {
        flex: 1;
        padding: 8px 12px;
        border: 1px solid var(--border-default);
        border-radius: 8px;
        background: var(--bg-surface);
        color: var(--text-primary);
        font-size: 12px;
        outline: none;
        font-family: inherit;
      }
      .ask-user-input:focus { border-color: var(--accent); }
      .ask-user-submit {
        padding: 6px 12px;
        border: none;
        border-radius: 6px;
        background: var(--accent);
        color: white;
        font-size: 12px;
        cursor: pointer;
      }

      /* ── Input Area ── */
      .input-area {
        padding: 12px 16px;
        border-top: 1px solid var(--border-subtle);
        display: flex;
        gap: 8px;
        background: var(--bg-deepest);
        flex-shrink: 0;
      }
      .input-area textarea {
        flex: 1;
        padding: 10px 12px;
        border: 1px solid var(--border-default);
        border-radius: 8px;
        background: var(--bg-surface);
        color: var(--text-primary);
        font-size: 13px;
        font-family: inherit;
        resize: none;
        outline: none;
        transition: border-color 0.2s;
        max-height: 100px;
      }
      .input-area textarea:focus { border-color: var(--accent); }
      .input-area textarea:disabled { opacity: 0.5; }
      .send-btn {
        padding: 0 16px;
        border: none;
        border-radius: 8px;
        background: var(--accent);
        color: white;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: opacity 0.2s;
      }
      .send-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    this._initClient();

    // Restore session ID if provided via attribute
    if (this.sessionIdAttr) {
      this.currentSessionId = this.sessionIdAttr;
      this._store.switchSession(this.sessionIdAttr);
    }
  }

  disconnectedCallback(): void {
    this._cleanup();
    super.disconnectedCallback();
  }

  private _initClient(): void {
    if (!this.token || !this.server) return;
    this.client = new AgentClient({
      server: this.server,
      token: this.token,
    });
    const tools = this.parseRemoteTools();
    this.registrationError = null;
    this.registrationPromise = this.projectId && tools.length > 0
      ? this.client.registerRemoteTools(this.projectId, tools).catch((error) => {
          this.registrationError = error;
        })
      : Promise.resolve();

    this.unsubClient = this.client.onEvent((event) => this._handleEvent(event));
    this.unsubStore = this._store.subscribe(() => {
      this.requestUpdate();
    });
  }

  private parseRemoteTools(): RemoteToolRegistration[] {
    if (Array.isArray(this.remoteTools)) return this.remoteTools;
    if (!this.remoteTools) return [];
    try {
      const parsed = JSON.parse(this.remoteTools);
      return Array.isArray(parsed) ? parsed as RemoteToolRegistration[] : [];
    } catch {
      return [];
    }
  }

  private _cleanup(): void {
    this.unsubClient?.();
    this.unsubStore?.();
    this.client?.destroy();
  }

  private _handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'thinking':
        // Show thinking indicator
        break;
      case 'text_chunk':
        if (event.text) this._store.appendStreamText(event.text);
        break;
      case 'tool_call':
        if (event.toolCall) this._store.addToolCall(event.toolCall);
        break;
      case 'tool_result':
        if (event.result) {
          this._store.updateToolResult(
            event.result.toolCallId,
            event.result.content,
            event.result.isError,
          );
        }
        break;
      case 'ask_user':
        if (event.questionId) {
          this._store.addAskUser(
            event.questionId,
            event.question || '',
            event.options,
            event.multiSelect,
          );
          this._store.setRunning(false);
        }
        break;
      case 'done':
        this._store.finalizeStream(event.finalText);
        this._store.setRunning(false);
        break;
      case 'error':
        this._store.setError(event.message || event.error || '未知错误');
        this._store.setRunning(false);
        break;
    }
  }

  private async _togglePanel(): Promise<void> {
    if (!this._store.isPanelOpen && this.client) {
      await this._loadSessions();
      await this._ensureSession();
    }
    this._store.togglePanel();
  }

  private async _loadSessions(): Promise<void> {
    if (!this.client) return;
    this._store.setLoadingSessions(true);
    try {
      const sessions = await this.client.listSessions(this.projectId || undefined);
      this._store.setSessions(sessions);
    } catch (err) {
      this._store.setError(`加载会话失败: ${err}`);
    } finally {
      this._store.setLoadingSessions(false);
    }
  }

  private async _loadSessionMessages(sessionId: string): Promise<void> {
    if (!this.client) return;
    try {
      const session = await this.client.getSession(sessionId);
      if (session?.messages?.length) {
        this._store.restoreSessionMessages(sessionId, session.messages);
      }
    } catch {
      // ignore load errors
    }
  }

  private async _ensureSession(): Promise<void> {
    if (this.currentSessionId || !this.client) return;
    try {
      const session = await this.client.createSession(this.title, this.projectId || undefined);
      this.currentSessionId = session.id;
      this._store.startNewSession(session);
    } catch (err) {
      this._store.setError(`创建会话失败: ${err}`);
    }
  }

  private async _createNewSession(): Promise<void> {
    if (!this.client || this._store.isRunning) return;
    try {
      const session = await this.client.createSession(this.title, this.projectId || undefined);
      this.currentSessionId = session.id;
      this._store.startNewSession(session);
      this._clearComposer();
    } catch (err) {
      this._store.setError(`创建会话失败: ${err}`);
    }
  }

  private _switchSession(sessionId: string): void {
    if (this._store.isRunning || sessionId === this.currentSessionId) {
      this._store.setSessionMenuOpen(false);
      return;
    }
    this.currentSessionId = sessionId;
    this._store.switchSession(sessionId);
    void this._loadSessionMessages(sessionId);
    this._clearComposer();
  }

  private _clearComposer(): void {
    const textarea = this.renderRoot.querySelector('.input-area textarea') as HTMLTextAreaElement | null;
    if (textarea) {
      textarea.value = '';
      textarea.style.height = 'auto';
    }
  }

  private async _sendMessage(): Promise<void> {
    const textarea = this.renderRoot.querySelector('.input-area textarea') as HTMLTextAreaElement;
    const input = textarea?.value.trim();
    if (!input || !this.client || !this.currentSessionId || this._store.isRunning) return;

    const pendingAsk = this._store.getPendingAskUser();
    if (pendingAsk) {
      if (textarea) {
        textarea.value = '';
        textarea.style.height = 'auto';
      }
      await this._answerQuestion(pendingAsk.questionId, input);
      return;
    }

    await this.registrationPromise;
    if (this.registrationError) {
      const error = this.registrationError;
      this._store.setError(`远端工具注册失败: ${error instanceof Error ? error.message : String(error)}`);
      this._store.setRunning(false);
      return;
    }

    this._store.clearError();
    this._store.addMessage({
      id: crypto.randomUUID(),
      role: 'user',
      content: input,
      timestamp: Date.now(),
    });

    if (textarea) {
      textarea.value = '';
      textarea.style.height = 'auto';
    }

    this._store.setRunning(true);
    try {
      await this.client.run(input, this.currentSessionId);
    } catch (err) {
      this._store.setError(`发送失败: ${err}`);
      this._store.setRunning(false);
    }
  }

  private async _answerQuestion(questionId: string, answer: string, selectedIndices?: number[]): Promise<void> {
    this._store.resolveAskUser(questionId, answer);
    this._store.setRunning(true);
    try {
      await this.client?.answerQuestion(questionId, answer, selectedIndices);
    } catch (err) {
      this._store.setError(`回答失败: ${err}`);
      this._store.setRunning(false);
    }
  }

  private _handleMessagesScroll(event: Event): void {
    const container = event.currentTarget as HTMLElement;
    const distanceFromBottom = container.scrollHeight - container.clientHeight - container.scrollTop;
    this.shouldAutoScroll = distanceFromBottom <= 32;
  }

  private _scrollToBottom(): void {
    const container = this.renderRoot.querySelector('.messages');
    if (container && this.shouldAutoScroll) {
      container.scrollTop = container.scrollHeight;
    }
  }

  updated(): void {
    this._scrollToBottom();
  }

  render(): unknown {
    const activeTitle = this._getActiveSessionTitle();
    return html`
      <agent-fab
        .isOpen=${this._store.isPanelOpen}
        position=${this.position}
        @toggle=${() => this._togglePanel()}
      ></agent-fab>
      <div class="panel ${this._store.isPanelOpen ? 'open' : ''}">
        <div class="header">
          <span class="header-title" title=${activeTitle}>${activeTitle}</span>
          <div class="header-actions">
            <button
              class="header-btn"
              title="切换聊天"
              ?disabled=${this._store.isRunning}
              @click=${() => this._store.toggleSessionMenu()}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>
            </button>
            <button
              class="header-btn"
              title="新建聊天"
              ?disabled=${this._store.isRunning}
              @click=${() => this._createNewSession()}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
            </button>
            <button class="header-close" title="关闭" @click=${() => this._store.setPanelOpen(false)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
          ${this._store.isSessionMenuOpen ? this._renderSessionMenu() : ''}
        </div>
        <div class="messages" @scroll=${this._handleMessagesScroll}>
          ${this._store.messages.length === 0
            ? html`<div class="empty">开始与 AI 助手对话...</div>`
            : this._store.messages.map((msg) => this._renderMessage(msg))}
          ${this._store.isRunning && this._store.currentStreamText === ''
            ? html`<div class="msg-thinking">思考中...</div>`
            : ''}
          ${this._store.error ? html`<div class="error-msg">${this._store.error}</div>` : ''}
        </div>
        <div class="input-area">
          <textarea
            rows="1"
            placeholder=${this.placeholder}
            ?disabled=${this._store.isRunning}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this._sendMessage();
              }
            }}
            @input=${(e: InputEvent) => {
              const ta = e.target as HTMLTextAreaElement;
              ta.style.height = 'auto';
              ta.style.height = Math.min(ta.scrollHeight, 100) + 'px';
            }}
          ></textarea>
          <button
            class="send-btn"
            ?disabled=${this._store.isRunning || !this.currentSessionId}
            @click=${() => this._sendMessage()}
          >
            ${this._store.isRunning ? '...' : '发送'}
          </button>
        </div>
      </div>
    `;
  }

  private _getActiveSessionTitle(): string {
    const session = this._store.sessions.find((item) => item.id === this.currentSessionId);
    return session?.title || this.title;
  }

  private _renderSessionMenu(): unknown {
    const sessions = this._store.sessions;
    const renderSessionItem = (session: Session) => html`
      <button
        class="session-item ${session.id === this.currentSessionId ? 'active' : ''}"
        ?disabled=${this._store.isRunning}
        @click=${() => this._switchSession(session.id)}
      >
        <span class="session-item-title">${session.title || '未命名聊天'}</span>
        <span class="session-item-meta">${this._formatSessionTime(session.updated || session.created)}</span>
      </button>
    `;
    let body: unknown;
    if (this._store.isLoadingSessions) {
      body = html`<div class="session-empty">加载中...</div>`;
    } else if (sessions.length === 0) {
      body = html`<div class="session-empty">暂无聊天</div>`;
    } else if (!this._groupByBot) {
      body = sessions.map(renderSessionItem);
    } else {
      const groups = BOT_GROUP_ORDER
        .map((botType) => [botType, sessions.filter((s) => (s.agentType ?? 'customer-agent') === botType)] as const)
        .filter(([, list]) => list.length > 0);
      body = groups.map(([botType, list]) => {
        const groupKey = botType;
        const expanded = !this._collapsedBotGroups.has(groupKey);
        return html`
          <div class="bot-group">
            <button
              class="bot-group-header ${expanded ? '' : 'collapsed'}"
              title=${BOT_GROUP_LABELS[botType]}
              aria-expanded=${expanded}
              @click=${() => {
                const next = new Set(this._collapsedBotGroups);
                if (next.has(groupKey)) next.delete(groupKey); else next.add(groupKey);
                this._collapsedBotGroups = next;
              }}
            >
              <svg class="chev" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="9" width="14" height="10" rx="2"/><path d="M12 9V6"/><circle cx="12" cy="4" r="1.6"/><path d="M9.5 13v1.6M14.5 13v1.6"/></svg>
              <span class="bot-group-label">${BOT_GROUP_LABELS[botType]}</span>
              <span class="bot-group-count">${list.length}</span>
            </button>
            ${expanded ? html`<div class="bot-group-body">${list.map(renderSessionItem)}</div>` : ''}
          </div>
        `;
      });
    }
    return html`
      <div class="session-menu">
        <div class="session-menu-header">
          <span class="session-menu-title">聊天</span>
          <button
            class="bot-toggle ${this._groupByBot ? 'on' : ''}"
            title="会话按机器人分组"
            aria-label="会话按机器人分组"
            aria-pressed=${this._groupByBot}
            @click=${() => { this._groupByBot = !this._groupByBot; }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="9" width="14" height="10" rx="2"/><path d="M12 9V6"/><circle cx="12" cy="4" r="1.6"/><path d="M9.5 13v1.6M14.5 13v1.6"/></svg>
          </button>
          <button
            class="session-new-btn"
            ?disabled=${this._store.isRunning}
            @click=${() => this._createNewSession()}
          >新建</button>
        </div>
        ${this._groupByBot && sessions.length > 0 ? html`
        <div class="bot-actions">
          <button
            type="button"
            title="折叠所有机器人的会话组"
            @click=${() => {
              this._collapsedBotGroups = new Set(
                BOT_GROUP_ORDER.filter((botType) =>
                  sessions.some((s) => (s.agentType ?? 'customer-agent') === botType)));
            }}
          >全部折叠</button>
          <button
            type="button"
            title="每次展开一个机器人分组"
            @click=${() => this._expandNextBotGroup()}
          >逐层展开</button>
          <button
            type="button"
            title="展开所有机器人分组"
            @click=${() => { this._collapsedBotGroups = new Set(); }}
          >全部展开</button>
        </div>` : ''}
        <div class="session-list">${body}</div>
      </div>
    `;
  }

  /** 逐层展开：每次展开一个仍折叠的机器人分组 */
  private _expandNextBotGroup(): void {
    const next = BOT_GROUP_ORDER.find((botType) =>
      this._store.sessions.some((s) => (s.agentType ?? 'customer-agent') === botType)
      && this._collapsedBotGroups.has(botType));
    if (!next) return;
    const nextSet = new Set(this._collapsedBotGroups);
    nextSet.delete(next);
    this._collapsedBotGroups = nextSet;
  }

  private _formatSessionTime(value: string): string {
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) return '';
    return new Intl.DateTimeFormat(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestamp));
  }

  private _renderMessage(msg: ChatMessage): unknown {
    if (msg.askUser) {
      return this._renderAskUser(msg.askUser);
    }
    if (msg.role === 'user') {
      return html`<div class="msg-user">${msg.content}</div>`;
    }
    // Assistant message (may have tool calls) — render Markdown safely
    return html`
      ${msg.content ? html`<div class="msg-assistant ${msg.isStreaming ? 'streaming' : ''}">${unsafeHTML(renderMarkdown(msg.content))}</div>` : ''}
      ${msg.toolCalls?.map((tc) => this._renderToolCall(tc))}
    `;
  }

  private _renderToolCall(tc: ToolCall): unknown {
    const hasResult = !!tc.result;
    const isError = tc.isError;
    return html`
      <div class="tool-card">
        <div
          class="tool-header"
          @click=${(e: Event) => {
            const body = (e.currentTarget as HTMLElement).nextElementSibling;
            if (body) body.classList.toggle('hidden');
          }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
          <span>${tc.name}</span>
          <span class="tool-status ${isError ? 'err' : 'ok'}">${hasResult ? (isError ? '✕' : '✓') : '...'}</span>
        </div>
        <div class="tool-body">
          <div>参数: ${JSON.stringify(tc.arguments, null, 2)}</div>
          ${hasResult ? html`<div style="margin-top:6px;border-top:1px solid var(--border-subtle);padding-top:6px;">结果: ${tc.result}</div>` : ''}
        </div>
      </div>
    `;
  }

  private _renderAskUser(askUser: NonNullable<ChatMessage['askUser']>): unknown {
    if (askUser.answered) {
      return html`
        <div class="msg-assistant">${askUser.question}</div>
        <div class="msg-user">${askUser.answer}</div>
      `;
    }
    return html`
      <div class="ask-user">
        <div class="ask-user-question">${askUser.question}</div>
        ${askUser.options?.length
          ? html`<div class="ask-user-options">
              ${askUser.options.map((opt, i) => html`
                <button
                  class="ask-user-option"
                  @click=${() => this._answerQuestion(askUser.questionId, opt.label, [i])}
                >
                  <span class="opt-label">${opt.label}</span>
                  ${opt.description ? html`<span class="opt-desc">${opt.description}</span>` : ''}
                </button>
              `)}
            </div>`
          : html`<div class="ask-user-input-row">
              <input
                class="ask-user-input"
                type="text"
                placeholder="输入回答..."
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === 'Enter') {
                    const input = e.target as HTMLInputElement;
                    if (input.value.trim()) {
                      this._answerQuestion(askUser.questionId, input.value.trim());
                    }
                  }
                }}
              />
              <button
                class="ask-user-submit"
                @click=${(e: Event) => {
                  const input = (e.currentTarget as HTMLElement).previousElementSibling as HTMLInputElement;
                  if (input?.value?.trim()) {
                    this._answerQuestion(askUser.questionId, input.value.trim());
                  }
                }}
              >确认</button>
            </div>`}
      </div>
    `;
  }
}
