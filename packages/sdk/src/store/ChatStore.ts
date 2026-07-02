import type { ChatMessage, Session, ToolCall } from '../client/types';

type Listener = () => void;

/**
 * Lightweight reactive store for chat state.
 * Components subscribe to changes via subscribe() and re-render on notify.
 */
export class ChatStore {
  private listeners = new Set<Listener>();

  messages: ChatMessage[] = [];
  sessions: Session[] = [];
  isRunning = false;
  isPanelOpen = false;
  isSessionMenuOpen = false;
  isLoadingSessions = false;
  activeSessionId = '';
  currentStreamText = '';
  error: string | null = null;
  private messagesBySession = new Map<string, ChatMessage[]>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn());
  }

  setSessions(sessions: Session[]): void {
    this.sessions = sessions;
    this.notify();
  }

  addOrUpdateSession(session: Session): void {
    const exists = this.sessions.some((item) => item.id === session.id);
    this.sessions = exists
      ? this.sessions.map((item) => (item.id === session.id ? session : item))
      : [session, ...this.sessions];
    this.notify();
  }

  setLoadingSessions(isLoading: boolean): void {
    this.isLoadingSessions = isLoading;
    this.notify();
  }

  setSessionMenuOpen(open: boolean): void {
    this.isSessionMenuOpen = open;
    this.notify();
  }

  toggleSessionMenu(): void {
    this.isSessionMenuOpen = !this.isSessionMenuOpen;
    this.notify();
  }

  switchSession(sessionId: string): void {
    if (this.activeSessionId) {
      this.messagesBySession.set(this.activeSessionId, this.messages);
    }
    this.activeSessionId = sessionId;
    this.messages = this.messagesBySession.get(sessionId) ?? [];
    this.currentStreamText = '';
    this.error = null;
    this.isSessionMenuOpen = false;
    this.notify();
  }

  startNewSession(session: Session): void {
    if (this.activeSessionId) {
      this.messagesBySession.set(this.activeSessionId, this.messages);
    }
    this.activeSessionId = session.id;
    this.addOrUpdateSession(session);
    this.messages = [];
    this.currentStreamText = '';
    this.error = null;
    this.isSessionMenuOpen = false;
    this.messagesBySession.set(session.id, []);
    this.notify();
  }

  addMessage(msg: ChatMessage): void {
    this.messages = [...this.messages, msg];
    this.persistActiveMessages();
    this.currentStreamText = '';
    this.notify();
  }

  appendStreamText(text: string): void {
    if (!text) return;
    this.currentStreamText += text;

    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'assistant' && !last.toolCalls?.length && !last.askUser && last.isStreaming) {
      this.messages = [...this.messages];
      this.messages[this.messages.length - 1] = {
        ...last,
        content: last.content + text,
      };
    } else {
      this.messages = [...this.messages, {
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        content: text,
        isStreaming: true,
        timestamp: Date.now(),
      }];
    }
    this.persistActiveMessages();
    this.notify();
  }

  finalizeStream(finalText?: string): void {
    const text = (finalText ?? this.currentStreamText).trim();
    if (text) {
      const last = this.messages[this.messages.length - 1];
      if (last && last.role === 'assistant' && last.isStreaming) {
        this.messages = [...this.messages];
        this.messages[this.messages.length - 1] = {
          ...last,
          content: text,
          isStreaming: false,
        };
      } else if (!last || last.role !== 'assistant' || last.content) {
        // If there's no streaming message but we have finalText, add it
        this.messages = [...this.messages, {
          id: crypto.randomUUID(),
          role: 'assistant' as const,
          content: text,
          timestamp: Date.now(),
        }];
      }
    }
    this.currentStreamText = '';
    this.persistActiveMessages();
    this.notify();
  }

  addToolCall(toolCall: ToolCall): void {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'assistant' && !last.toolCalls?.length && !last.askUser) {
      this.messages = [...this.messages];
      this.messages[this.messages.length - 1] = {
        ...last,
        toolCalls: [toolCall],
        isStreaming: false,
      };
    } else {
      this.messages = [...this.messages, {
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        content: '',
        toolCalls: [toolCall],
        timestamp: Date.now(),
      }];
    }
    this.persistActiveMessages();
    this.notify();
  }

  updateToolResult(toolCallId: string, result: string, isError?: boolean): void {
    this.messages = this.messages.map((m) => {
      if (!m.toolCalls) return m;
      return {
        ...m,
        toolCalls: m.toolCalls.map((tc) =>
          tc.id === toolCallId ? { ...tc, result, isError } : tc,
        ),
      };
    });
    this.persistActiveMessages();
    this.notify();
  }

  addAskUser(
    questionId: string,
    question: string,
    options?: Array<{ label: string; description: string }>,
    multiSelect?: boolean,
  ): void {
    this.messages = [...this.messages, {
      id: crypto.randomUUID(),
      role: 'assistant' as const,
      content: '',
      askUser: { questionId, question, options, multiSelect },
      timestamp: Date.now(),
    }];
    this.persistActiveMessages();
    this.notify();
  }

  resolveAskUser(questionId: string, answer: string): void {
    this.messages = this.messages.map((m) =>
      m.askUser?.questionId === questionId
        ? { ...m, askUser: { ...m.askUser, answered: true, answer } }
        : m,
    );
    this.persistActiveMessages();
    this.notify();
  }

  getPendingAskUser(): ChatMessage['askUser'] | null {
    return this.messages.find((m) => m.askUser && !m.askUser.answered)?.askUser ?? null;
  }

  setRunning(running: boolean): void {
    this.isRunning = running;
    this.notify();
  }

  togglePanel(): void {
    this.isPanelOpen = !this.isPanelOpen;
    this.notify();
  }

  setPanelOpen(open: boolean): void {
    this.isPanelOpen = open;
    this.notify();
  }

  setError(error: string | null): void {
    this.error = error;
    this.notify();
  }

  clearError(): void {
    this.error = null;
    this.notify();
  }

  clearMessages(): void {
    this.messages = [];
    this.currentStreamText = '';
    this.persistActiveMessages();
    this.notify();
  }

  private persistActiveMessages(): void {
    if (this.activeSessionId) {
      this.messagesBySession.set(this.activeSessionId, this.messages);
    }
  }
}
