import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DesktopModelProfile } from "./model-config.js";
import type { RegisteredProject } from "./resources.js";

export interface DesktopData {
  profiles: DesktopModelProfile[];
  activeProfileId?: string;
  projects: RegisteredProject[];
  warnings: string[];
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function discoverDatabasePaths(repoRoot: string): Promise<string[]> {
  const candidates = [
    path.join(repoRoot, "packages", "desktop", ".agent-data", "agent.db"),
    path.join(repoRoot, "packages", "server", ".agent-data", "agent.db"),
  ];
  if (process.platform === "darwin") {
    const applicationSupport = path.join(os.homedir(), "Library", "Application Support");
    for (const userDataName of ["@agent/desktop", "customer-agent", "AgentRoam", "agentroam"]) {
      candidates.push(path.join(applicationSupport, userDataName, ".agent-data", "agent.db"));
    }
  }
  return [...new Set(candidates.filter((candidate) => candidate.endsWith("agent.db") && path.isAbsolute(candidate)))];
}

export async function readDesktopData(databasePaths: readonly string[]): Promise<DesktopData> {
  const data: DesktopData = { profiles: [], projects: [], warnings: [] };
  let Database: any;
  let bunSqlite = false;
  try {
    Database = (await import("bun:sqlite")).Database;
    bunSqlite = true;
  } catch {
    try {
      Database = (await import("better-sqlite3")).default;
    } catch (error) {
      data.warnings.push(`无法读取 Desktop 配置: ${error instanceof Error ? error.message : String(error)}`);
      return data;
    }
  }

  for (const databasePath of databasePaths) {
    if (!(await exists(databasePath))) continue;
    let database: any;
    try {
      database = bunSqlite
        ? new Database(databasePath, { readonly: true, create: false })
        : new Database(databasePath, { readonly: true, fileMustExist: true });
      const query = (sql: string) => bunSqlite ? database.query(sql) : database.prepare(sql);
      const tables = new Set((query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name));
      if (tables.has("settings")) {
        const rows = query("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
        const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
        const profiles = settings.profiles ? JSON.parse(settings.profiles) as Array<Record<string, unknown>> : [];
        for (const profile of profiles) {
          if (!profile.id || !profile.provider || !profile.modelId) continue;
          data.profiles.push({
            id: String(profile.id),
            name: String(profile.name || profile.modelId),
            provider: String(profile.provider),
            modelId: String(profile.modelId),
            apiKey: String(profile.apiKey || ""),
            baseUrl: String(profile.baseUrl || "") || undefined,
            sourcePath: databasePath,
          });
        }
        if (!data.activeProfileId && settings.activeProfileId) data.activeProfileId = settings.activeProfileId;
      }
      if (tables.has("projects")) {
        const rows = query("SELECT id, name, description FROM projects").all() as Array<{ id: string; name: string; description: string }>;
        data.projects.push(...rows.map((row) => ({ ...row, source: databasePath })));
      }
    } catch (error) {
      data.warnings.push(`${databasePath}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      database?.close();
    }
  }

  const profileKeys = new Set<string>();
  data.profiles = data.profiles.filter((profile) => {
    const key = `${profile.sourcePath}\0${profile.id}`;
    if (profileKeys.has(key)) return false;
    profileKeys.add(key);
    return true;
  });
  const projectKeys = new Set<string>();
  data.projects = data.projects.filter((project) => {
    const key = `${project.source}\0${project.id}`;
    if (projectKeys.has(key)) return false;
    projectKeys.add(key);
    return true;
  });
  return data;
}
