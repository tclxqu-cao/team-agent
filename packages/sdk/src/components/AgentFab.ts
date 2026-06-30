import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/**
 * Floating action button — toggles the chat panel.
 * Registered as <agent-fab> but typically used internally by <agent-chat>.
 */
@customElement('agent-fab')
export class AgentFab extends LitElement {
  @property({ type: Boolean }) isOpen = false;
  @property({ type: String }) position = 'bottom-right';

  static styles = css`
    :host {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 99998;
      pointer-events: auto;
    }
    :host([position='bottom-left']) {
      right: auto;
      left: 24px;
    }
    button {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      border: none;
      background: var(--accent, #4f6ef7);
      color: white;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: var(--shadow-md, 0 8px 24px rgba(0, 0, 0, 0.4));
      transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), background 0.2s;
    }
    button:hover {
      transform: scale(1.08);
    }
    button:active {
      transform: scale(0.95);
    }
  `;

  render() {
    return html`
      <button @click=${this._onClick} title=${this.isOpen ? '关闭' : '打开聊天'}>
        ${this.isOpen
          ? html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`
          : html`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`}
      </button>
    `;
  }

  private _onClick() {
    this.dispatchEvent(new CustomEvent('toggle', { bubbles: true, composed: true }));
  }
}
