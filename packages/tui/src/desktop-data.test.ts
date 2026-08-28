import { execFile } from "node:child_process";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

describe("Desktop data adapter", () => {
  it("reads model profiles and projects from an existing database", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tui-desktop-data-"));
    const dataDir = path.join(root, ".agent-data");
    await mkdir(dataDir);
    const databasePath = path.join(dataDir, "agent.db");
    const moduleUrl = pathToFileURL(fileURLToPath(new URL("./desktop-data.ts", import.meta.url))).href;
    const script = `
      import { Database } from "bun:sqlite";
      import { readDesktopData } from ${JSON.stringify(moduleUrl)};
      const databasePath = ${JSON.stringify(databasePath)};
      const database = new Database(databasePath, { create: true });
      database.query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
      database.query("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL)").run();
      database.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("activeProfileId", "profile-one");
      database.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("profiles", JSON.stringify([{
        id: "profile-one", name: "Local", provider: "openai", modelId: "gpt-test",
        apiKey: "secret", baseUrl: "http://localhost/v1"
      }]));
      database.query("INSERT INTO projects (id, name, description) VALUES (?, ?, ?)").run("project-one", "customer-agent", ${JSON.stringify(root)});
      database.close();
      console.log(JSON.stringify(await readDesktopData([databasePath])));
    `;
    const result = JSON.parse((await run("bun", ["-e", script])).stdout);
    expect(result.warnings).toEqual([]);
    expect(result.activeProfileId).toBe("profile-one");
    expect(result.profiles[0]).toMatchObject({ provider: "openai", modelId: "gpt-test", apiKey: "secret" });
    expect(result.projects[0]).toMatchObject({ id: "project-one", name: "customer-agent" });
  });
});
