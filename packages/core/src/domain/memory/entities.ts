// ── Memory Domain ──

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface MemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  content: string;
  created: string; // ISO 8601
  updated: string; // ISO 8601
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
  snippet: string;
}

export interface IMemoryStore {
  /** Get a single memory by name */
  get(name: string): Promise<MemoryEntry | null>;
  /** Save a memory (upsert) */
  set(entry: MemoryEntry): Promise<void>;
  /** Delete a memory by name */
  delete(name: string): Promise<void>;
  /** List all memories */
  list(): Promise<MemoryEntry[]>;
  /** Search memories by query */
  search(query: string): Promise<MemorySearchResult[]>;
  /** Generate context string from relevant memories */
  generateContext(query: string, maxTokens?: number): Promise<string>;
  /** Get the MEMORY.md index content */
  getIndex(): Promise<string>;
}
