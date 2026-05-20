// ── LSP Manager — manages one LSPClient per language ──
import { extname } from 'node:path';
import { LSPClient } from './LSPClient.js';
import type { LSPServerConfig } from './entities.js';

export class LSPManager {
  /** language → running LSPClient */
  private clients = new Map<string, LSPClient>();

  /** Find the configured server whose fileTypes includes the given file extension. */
  configForFile(filePath: string, configs: LSPServerConfig[]): LSPServerConfig | null {
    const ext = extname(filePath).toLowerCase();
    return configs.find((c) => c.enabled && c.fileTypes.map((e) => e.toLowerCase()).includes(ext)) ?? null;
  }

  /**
   * Return a running LSPClient for the given server config.
   * Starts the server if it isn't already running.
   */
  async getClient(config: LSPServerConfig, workspaceRoot: string): Promise<LSPClient> {
    const existing = this.clients.get(config.language);
    if (existing?.isRunning) return existing;

    const client = new LSPClient(config);
    try {
      await client.start(workspaceRoot);
    } catch (err) {
      throw new Error(
        `Failed to start LSP server "${config.name}" (${config.command}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.clients.set(config.language, client);
    return client;
  }

  /** Shut down all running LSP clients. */
  async shutdownAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.shutdown()));
    this.clients.clear();
  }
}
