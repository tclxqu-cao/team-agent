// ── SQLite Agent Definition Store ──
import type { IAgentDefinitionStore, AgentDefinition } from '../domain/agent/entities.js';
import { getDatabase } from './SQLiteDatabase.js';

function rowToAgent(row: Record<string, unknown>): AgentDefinition {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? "",
    systemPrompt: (row.system_prompt as string) ?? "",
    contextPlaceholders: JSON.parse((row.context_placeholders as string) ?? "[]"),
    capabilities: JSON.parse((row.capabilities as string) ?? '{"profileId":"","enabledTools":[],"enabledSkills":[],"enabledMCPServers":[]}'),
    maxIterations: (row.max_iterations as number) ?? 0,
    isDefault: (row.is_default as number) === 1,
    created: row.created as string,
    updated: row.updated as string,
  };
}

export class SQLiteAgentStore implements IAgentDefinitionStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    getDatabase(baseDir);
  }

  async get(id: string): Promise<AgentDefinition | null> {
    const db = getDatabase(this.baseDir);
    const row = db.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToAgent(row) : null;
  }

  async list(): Promise<AgentDefinition[]> {
    const db = getDatabase(this.baseDir);
    const rows = db.db.prepare("SELECT * FROM agents ORDER BY created ASC").all() as Record<string, unknown>[];
    return rows.map(rowToAgent);
  }

  async create(agent: AgentDefinition): Promise<AgentDefinition> {
    const db = getDatabase(this.baseDir);
    db.db.prepare(`
      INSERT INTO agents (id, name, description, system_prompt, context_placeholders, capabilities, max_iterations, is_default, created, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      agent.id,
      agent.name,
      agent.description,
      agent.systemPrompt,
      JSON.stringify(agent.contextPlaceholders),
      JSON.stringify(agent.capabilities),
      agent.maxIterations,
      agent.isDefault ? 1 : 0,
      agent.created,
      agent.updated,
    );
    return agent;
  }

  async update(id: string, update: Partial<Omit<AgentDefinition, 'id' | 'created'>>): Promise<AgentDefinition> {
    const db = getDatabase(this.baseDir);
    const existing = await this.get(id);
    if (!existing) throw new Error(`Agent not found: ${id}`);
    const merged: AgentDefinition = {
      ...existing,
      ...update,
      id,
      updated: new Date().toISOString(),
    };
    db.db.prepare(`
      UPDATE agents SET name=?, description=?, system_prompt=?, context_placeholders=?, capabilities=?, max_iterations=?, is_default=?, updated=?
      WHERE id=?
    `).run(
      merged.name,
      merged.description,
      merged.systemPrompt,
      JSON.stringify(merged.contextPlaceholders),
      JSON.stringify(merged.capabilities),
      merged.maxIterations,
      merged.isDefault ? 1 : 0,
      merged.updated,
      id,
    );
    return merged;
  }

  async delete(id: string): Promise<void> {
    const db = getDatabase(this.baseDir);
    db.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  }
}
