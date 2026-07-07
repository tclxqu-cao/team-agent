import type { AgentClientConfig, AgentEvent, Session, RemoteToolRegistration } from './types';

/**
 * HTTP + SSE client for communicating with the hosted Agent service.
 */
export class AgentClient {
  private server: string;
  private token: string;
  private eventSource: EventSource | null = null;
  private listeners = new Set<(event: AgentEvent) => void>();
  private reconnectAttempts = 0;
  private maxReconnect = 5;
  private reconnectDelay = 1000;
  private currentSessionId = '';

  constructor(config: AgentClientConfig) {
    this.server = config.server.replace(/\/$/, '');
    this.token = config.token;
  }

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
    };
  }

  async verifyToken(): Promise<{ valid: boolean; project?: string }> {
    try {
      const res = await fetch(`${this.server}/api/auth/verify`, {
        headers: this.headers,
      });
      if (!res.ok) return { valid: false };
      return await res.json() as { valid: boolean; project?: string };
    } catch {
      return { valid: false };
    }
  }

  async createSession(title = 'New Chat', projectId?: string): Promise<Session> {
    const res = await fetch(`${this.server}/api/sessions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ title, ...(projectId ? { projectId } : {}) }),
    });
    if (!res.ok) throw new Error(`Failed to create session: ${res.statusText}`);
    return res.json() as Promise<Session>;
  }

  async listSessions(projectId?: string): Promise<Session[]> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const res = await fetch(`${this.server}/api/sessions${query}`, {
      headers: this.headers,
    });
    if (!res.ok) throw new Error(`Failed to list sessions: ${res.statusText}`);
    return res.json() as Promise<Session[]>;
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const res = await fetch(`${this.server}/api/sessions/${encodeURIComponent(sessionId)}`, {
      headers: this.headers,
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Failed to get session: ${res.statusText}`);
    return res.json() as Promise<Session>;
  }

  async registerRemoteTools(projectId: string, tools: RemoteToolRegistration[]): Promise<void> {
    if (!projectId || tools.length === 0) return;
    const normalizedTools = tools.map((tool) => ({
      scheme: tool.scheme,
      purpose: tool.purpose,
      url: tool.url,
      method: tool.method ?? 'POST',
      headers: tool.headers ?? {},
      inputSchema: tool.inputSchema ?? {},
      outputSchema: tool.outputSchema ?? {},
      examples: tool.examples ?? [],
      auth: tool.auth ?? {},
    }));
    const res = await fetch(`${this.server}/api/remote-tools/register`, {
      method: 'POST',
      headers: {
        ...this.headers,
      },
      body: JSON.stringify({ projectId, tools: normalizedTools }),
    });
    if (!res.ok) throw new Error(`Failed to register remote tools: ${res.statusText}`);
  }

  /**
   * Send a message to the agent. Opens an SSE stream first, then POSTs the run.
   */
  async run(input: string, sessionId: string): Promise<void> {
    this.currentSessionId = sessionId;
    this.connectStream(sessionId);

    const res = await fetch(`${this.server}/api/agent/run`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ input, sessionId }),
    });
    if (!res.ok) throw new Error(`Failed to run agent: ${res.statusText}`);
  }

  private connectStream(sessionId: string): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    // EventSource doesn't support custom headers — pass token as query param
    const url = `${this.server}/api/agent/stream?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(this.token)}`;
    this.eventSource = new EventSource(url);

    this.eventSource.onmessage = (e: MessageEvent) => {
      try {
        const event: AgentEvent = JSON.parse(e.data);
        this.listeners.forEach((fn) => fn(event));

        if (event.type === 'done' || event.type === 'error') {
          this.eventSource?.close();
          this.eventSource = null;
          this.reconnectAttempts = 0;
        }
      } catch (err) {
        console.error('[AgentClient] Failed to parse SSE event:', err);
      }
    };

    this.eventSource.onerror = () => {
      this.eventSource?.close();
      this.eventSource = null;

      if (this.reconnectAttempts < this.maxReconnect && this.currentSessionId === sessionId) {
        this.reconnectAttempts++;
        const delay = Math.min(
          this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
          30000,
        );
        setTimeout(() => {
          if (this.currentSessionId === sessionId) {
            this.connectStream(sessionId);
          }
        }, delay);
      }
    };
  }

  async abort(): Promise<void> {
    await fetch(`${this.server}/api/agent/abort`, {
      method: 'POST',
      headers: this.headers,
    });
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  async answerQuestion(
    questionId: string,
    answer: string,
    selectedIndices?: number[],
  ): Promise<void> {
    await fetch(`${this.server}/api/agent/answer`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ questionId, answer, selectedIndices }),
    });
  }

  onEvent(callback: (event: AgentEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  destroy(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.listeners.clear();
  }
}
