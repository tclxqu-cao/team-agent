// ── SQLite Settings Store ──
import type { ISettingsStore, SettingsData, ModelProfile } from '../domain/settings/entities.js';
import { getDatabase } from './SQLiteDatabase.js';

export class SQLiteSettingsStore implements ISettingsStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    getDatabase(baseDir);
  }

  get(key: string): string | null {
    const db = getDatabase(this.baseDir);
    const row = db.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    const db = getDatabase(this.baseDir);
    db.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }

  getAll(): SettingsData {
    const db = getDatabase(this.baseDir);
    const rows = db.db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
    const data: Record<string, string> = {};
    for (const row of rows) {
      data[row.key] = row.value;
    }

    let profiles: ModelProfile[] = [];
    try {
      profiles = data["profiles"] ? JSON.parse(data["profiles"]) : [];
    } catch { profiles = []; }

    let activeProfileId = data["activeProfileId"] ?? "";

    // ── Auto-migrate legacy flat settings into a default profile ──────────
    const legacyApiKey = data["apiKey"] ?? "";
    if (profiles.length === 0 && legacyApiKey) {
      const legacyProvider = data["modelProvider"] ?? "anthropic";
      const legacyModelId  = data["modelId"] ?? "claude-sonnet-4-6";
      const legacyBaseUrl  = data["baseUrl"] ?? "";
      const migratedProfile: ModelProfile = {
        id: "default",
        name: legacyProvider.charAt(0).toUpperCase() + legacyProvider.slice(1),
        provider: legacyProvider,
        modelId: legacyModelId,
        apiKey: legacyApiKey,
        baseUrl: legacyBaseUrl,
      };
      profiles = [migratedProfile];
      activeProfileId = "default";
      // Persist so next load doesn't re-migrate
      const db2 = getDatabase(this.baseDir);
      const upsert2 = db2.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
      upsert2.run("profiles", JSON.stringify(profiles));
      upsert2.run("activeProfileId", activeProfileId);
    }
    // ─────────────────────────────────────────────────────────────────────

    // Resolve active model fields from active profile (if any)
    const active = profiles.find((p) => p.id === activeProfileId);
    const modelProvider = active?.provider ?? data["modelProvider"] ?? "anthropic";
    const modelId       = active?.modelId  ?? data["modelId"]       ?? "claude-sonnet-4-6";
    const apiKey        = active?.apiKey   ?? data["apiKey"]        ?? "";
    const baseUrl       = active?.baseUrl  ?? data["baseUrl"]       ?? "";

    return {
      modelProvider,
      modelId,
      apiKey,
      baseUrl,
      maxIterations: parseInt(data["maxIterations"] ?? "10", 10),
      contextWindow: parseInt(data["contextWindow"] ?? "100", 10),
      workingDirectory: data["workingDirectory"] ?? this.baseDir,
      isConfigured: Boolean(apiKey),
      profiles,
      activeProfileId,
    };
  }

  saveAll(settings: SettingsData): void {
    const db = getDatabase(this.baseDir);
    const upsert = db.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
    const tx = db.db.transaction(() => {
      upsert.run("modelProvider", settings.modelProvider);
      upsert.run("modelId", settings.modelId);
      upsert.run("apiKey", settings.apiKey);
      upsert.run("baseUrl", settings.baseUrl);
      upsert.run("maxIterations", String(settings.maxIterations));
      upsert.run("contextWindow", String(settings.contextWindow ?? 100));
      upsert.run("workingDirectory", settings.workingDirectory);
      upsert.run("profiles", JSON.stringify(settings.profiles ?? []));
      upsert.run("activeProfileId", settings.activeProfileId ?? "");
    });
    tx();
  }

  delete(key: string): void {
    const db = getDatabase(this.baseDir);
    db.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }
}
