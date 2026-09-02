import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type {
  HostDirectoryEntry,
  IProjectStore,
  Project,
} from "@agent/core";

/** Application-layer port for host directory access. */
export interface WebProjectPathPort {
  readonly roots: string[];
  assertDirectory(path: string): string;
  listDirectories(path: string): HostDirectoryEntry[];
}

export class WebProjectError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "WebProjectError";
  }
}

/** Application service; concrete persistence and filesystem adapters are injected. */
export class WebProjectService {
  constructor(
    private readonly store: IProjectStore,
    private readonly paths: WebProjectPathPort,
  ) {}

  list(): Promise<Project[]> {
    return this.store.list();
  }

  async get(id: string): Promise<Project> {
    const project = await this.store.get(id);
    if (!project) throw new WebProjectError("项目不存在", "PROJECT_NOT_FOUND", 404);
    return project;
  }

  async create(path: string, requestedName?: string): Promise<Project> {
    const canonical = this.paths.assertDirectory(path);
    for (const project of await this.store.list()) {
      try {
        if (this.paths.assertDirectory(project.description) === canonical) return project;
      } catch {
        // Stale rows do not prevent registering a valid directory.
      }
    }
    const now = new Date().toISOString();
    return this.store.create({
      id: randomUUID(),
      name: requestedName?.trim() || basename(canonical) || canonical,
      description: canonical,
      created: now,
      updated: now,
    });
  }

  async rename(id: string, name: string): Promise<Project> {
    await this.get(id);
    const normalized = name.trim();
    if (!normalized) throw new WebProjectError("项目名称不能为空", "PROJECT_NAME_REQUIRED", 400);
    return this.store.update(id, { name: normalized });
  }

  async delete(id: string): Promise<void> {
    await this.get(id);
    await this.store.delete(id);
  }

  roots(): string[] {
    return this.paths.roots;
  }

  directories(path: string): HostDirectoryEntry[] {
    return this.paths.listDirectories(path);
  }

  check(path: string): boolean {
    try {
      this.paths.assertDirectory(path);
      return true;
    } catch {
      return false;
    }
  }
}
