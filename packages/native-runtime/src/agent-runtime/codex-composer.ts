import { isAbsolute, win32 } from "node:path";
import type { CodexAppServerClient } from "./codex-app-server-client.js";
import type { NativeComposerCatalog } from "./types.js";

const PREDICTION_TIMEOUT_MS = 8_000;
const CATALOG_TIMEOUT_MS = 5_000;
const MAX_RECENT_THREADS = 64;

interface CodexSkill {
  name: string;
  description: string;
  path: string;
  enabled?: boolean;
}

export async function listCodexSkills(client: Pick<CodexAppServerClient, "request">, cwd: string): Promise<CodexSkill[]> {
  const response = await client.request<{ data?: Array<{ skills?: CodexSkill[] }> }>("skills/list", {
    cwds: cwd ? [cwd] : [],
    forceReload: false,
  }, CATALOG_TIMEOUT_MS);
  return (response.data ?? []).flatMap(entry => entry.skills ?? []).filter(skill =>
    skill.enabled !== false && typeof skill.name === "string" && typeof skill.path === "string");
}

export async function loadCodexComposerCatalog(
  client: Pick<CodexAppServerClient, "request">,
  cwd: string,
  fileQuery?: string,
): Promise<NativeComposerCatalog> {
  if (fileQuery === undefined) {
    const skills = await listCodexSkills(client, cwd);
    return { skills: skills.map(({ name, description }) => ({ name, description })), files: [] };
  }
  if (!fileQuery.trim() || !cwd) return { skills: [], files: [] };

  const response = await client.request<{ files?: Array<{ path?: string; match_type?: string }> }>("fuzzyFileSearch", {
    query: fileQuery,
    roots: [cwd],
    cancellationToken: null,
  }, CATALOG_TIMEOUT_MS);
  const paths = (response.files ?? []).flatMap(({ path, match_type }) => (
    typeof path === "string" && path && match_type !== "directory"
      && !isAbsolute(path) && !win32.isAbsolute(path) && !path.split(/[\\/]/).includes("..")
      && !/[\r\n]/.test(path) ? [path] : []
  ));
  return { skills: [], files: [...new Set(paths)].slice(0, 12) };
}

type ReviewTarget = { type: "uncommittedChanges" } | { type: "baseBranch"; branch: string } | { type: "custom"; instructions: string };

export function parseCodexReviewTarget(input: string): ReviewTarget | null {
  const command = /^\/review(?:\s+([\s\S]+))?$/i.exec(input.trim());
  if (!command) return null;
  const argument = command[1]?.trim();
  if (!argument) return { type: "uncommittedChanges" };
  const base = /^--base\s+(\S+)$/.exec(argument);
  return base ? { type: "baseBranch", branch: base[1] } : { type: "custom", instructions: argument };
}

interface CompletedTurn {
  turnId: string;
  result?: Promise<string | null>;
}

/** Only turns completed on this connection are eligible. The suggestion is transient. */
export class CodexComposerPredictions {
  private readonly recent = new Map<string, CompletedTurn>();
  private unsupported = false;

  constructor(private readonly client: Pick<CodexAppServerClient, "request" | "onNotification" | "onExit">) {
    client.onExit(() => {
      this.recent.clear();
      this.unsupported = false;
    });
  }

  completed(threadId: string, turnId: string): void {
    this.recent.delete(threadId);
    if (this.recent.size >= MAX_RECENT_THREADS) this.recent.delete(this.recent.keys().next().value!);
    this.recent.set(threadId, { turnId });
  }

  clear(threadId: string): void {
    this.recent.delete(threadId);
  }

  async request(threadId: string, turnId: string): Promise<string | null> {
    const current = this.recent.get(threadId);
    if (this.unsupported || current?.turnId !== turnId) return null;
    current.result ??= this.collect(threadId, turnId);
    const suggestion = await current.result;
    return this.recent.get(threadId) === current ? suggestion : null;
  }

  private collect(threadId: string, turnId: string): Promise<string | null> {
    return new Promise(resolve => {
      const finish = (text: string | null) => {
        clearTimeout(timer);
        unsubscribe();
        unwatchExit();
        resolve(text);
      };
      const unsubscribe = this.client.onNotification(({ method, params }) => {
        if (method !== "thread/prediction/updated" || params?.threadId !== threadId || params.sourceTurnId !== turnId) return;
        const result = params.result as { type?: string; text?: unknown } | undefined;
        const text = result?.type === "completed" && typeof result.text === "string" ? result.text.trim() : "";
        finish(text && text.length <= 600 ? text : null);
      });
      const unwatchExit = this.client.onExit(() => finish(null));
      const timer = setTimeout(() => finish(null), PREDICTION_TIMEOUT_MS);
      void this.client.request("thread/prediction/request", { threadId, sourceTurnId: turnId }, PREDICTION_TIMEOUT_MS)
        .catch((error: unknown) => {
          if (error instanceof Error && /not implemented|method not found|unknown method/i.test(error.message)) {
            this.unsupported = true;
          }
          finish(null);
        });
    });
  }
}
