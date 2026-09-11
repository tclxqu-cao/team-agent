import type { Message } from '../model/entities.js';

/** One store belongs to one logical run, not to every turn in a session. */
export interface RunCheckpoint {
  schema: 1;
  sessionId: string;
  input: string;
  workingDirectory: string;
  messages: Message[];
  iteration: number;
  phase: 'ready' | 'tools_pending' | 'completed';
  pendingToolIds: string[];
  finalText?: string;
}

export interface IRunCheckpointStore {
  load(): Promise<RunCheckpoint | null>;
  save(checkpoint: RunCheckpoint): Promise<void>;
}

export function validateRunCheckpoint(value: unknown): asserts value is RunCheckpoint {
  const cp = value as RunCheckpoint | null;
  if (!cp || cp.schema !== 1 || typeof cp.sessionId !== 'string' ||
      typeof cp.input !== 'string' || typeof cp.workingDirectory !== 'string' ||
      !Number.isInteger(cp.iteration) || cp.iteration < 0 ||
      !['ready', 'tools_pending', 'completed'].includes(cp.phase) ||
      !Array.isArray(cp.pendingToolIds) || cp.pendingToolIds.some(id => typeof id !== 'string') ||
      !Array.isArray(cp.messages) || cp.messages.some(m => !m ||
        !['system', 'user', 'assistant', 'tool'].includes(m.role) || typeof m.content !== 'string') ||
      (cp.phase === 'completed' && typeof cp.finalText !== 'string') ||
      (cp.phase !== 'tools_pending' && cp.pendingToolIds.length !== 0)) {
    throw new Error('Invalid Harness checkpoint schema; automatic recovery refused');
  }
}
