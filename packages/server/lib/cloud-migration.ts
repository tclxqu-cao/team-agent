import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * 本地会话 → agent-sandbox 云端承接会话的打包与上传。
 *
 * 领域规则（与 agent-sandbox 的 migration-files 校验对齐）：
 * - 白名单文本扩展名；跳过依赖/产物目录；凭据文件双防线拒绝；
 * - ≤100 个文件、单文件 ≤128KB、总量 ≤5MB；
 * - 不上传整个 HOME，不上传 node_modules / 虚拟环境。
 */

const TEXT_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "txt", "py", "sh", "bash", "zsh",
  "css", "html", "htm", "yml", "yaml", "toml", "ini", "xml", "sql", "go", "rs", "java",
  "kt", "c", "h", "cpp", "hpp", "rb", "php", "swift", "lock", "editorconfig", "gitignore",
]);
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".output", "__pycache__", ".venv",
  "venv", "coverage", ".cache", ".agent-data",
]);
const CREDENTIAL_PATTERN = /(^|\/)(\.env|.*\.(pem|key|p12|pfx))(\..*)?$/i;

export const MIGRATION_LIMITS = {
  maxFiles: 100,
  maxFileBytes: 128 * 1024,
  maxTotalBytes: 5 * 1024 * 1024,
} as const;

export interface MigrationBundleFile {
  path: string;
  contentBase64: string;
}

export interface MigrationBundle {
  files: MigrationBundleFile[];
  totalBytes: number;
  skipped: string[];
}

export async function collectMigrationBundle(root: string): Promise<MigrationBundle> {
  const files: MigrationBundleFile[] = [];
  const skipped: string[] = [];
  let totalBytes = 0;

  async function walk(dir: string, prefix: string): Promise<void> {
    if (files.length >= MIGRATION_LIMITS.maxFiles) return;
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (files.length >= MIGRATION_LIMITS.maxFiles) {
        skipped.push("…（达到 100 文件上限）");
        return;
      }
      const absolute = join(dir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(absolute, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (CREDENTIAL_PATTERN.test(relativePath)) {
        skipped.push(`${relativePath}（凭据，拒绝上传）`);
        continue;
      }
      const extension = entry.name.includes(".") ? (entry.name.split(".").pop() ?? "") : "";
      if (!TEXT_EXTENSIONS.has(extension)) continue;
      const content = await readFile(absolute);
      if (content.byteLength > MIGRATION_LIMITS.maxFileBytes) {
        skipped.push(`${relativePath}（超过单文件上限）`);
        continue;
      }
      if (totalBytes + content.byteLength > MIGRATION_LIMITS.maxTotalBytes) {
        skipped.push(`${relativePath}（超过总量上限）`);
        continue;
      }
      totalBytes += content.byteLength;
      files.push({ path: relativePath, contentBase64: content.toString("base64") });
    }
  }

  await walk(root, "");
  return { files, totalBytes, skipped };
}

/** 把会话历史压缩成一份 markdown（用户/助手消息对，带上限防膨胀）。 */
export function renderSessionHistory(
  messages: Array<{ role: string; content: string }>,
  options: { title: string; maxMessages: number },
): string {
  const lines: string[] = [`## ${options.title}（本地会话迁移）`, ""];
  const recent = messages.slice(-options.maxMessages);
  if (messages.length > recent.length) {
    lines.push(`（更早的 ${messages.length - recent.length} 条消息已省略）`, "");
  }
  for (const message of recent) {
    const who = message.role === "user" ? "用户" : message.role === "assistant" ? "助手" : message.role;
    const text = message.content.replace(/\s+/g, " ").trim().slice(0, 400);
    if (!text) continue;
    lines.push(`- ${who}：${text}`);
  }
  return lines.join("\n");
}

export interface SandboxMigrationResult {
  session: { id: string; name: string; workdir: string | null };
  task: { id: string; status: string };
}

/** 调 agent-sandbox 的迁移接口创建承接会话。 */
export async function uploadMigrationBundle(input: {
  baseUrl: string;
  deviceToken: string;
  sandboxId: string;
  name: string;
  files: MigrationBundleFile[];
  history: string;
}): Promise<SandboxMigrationResult> {
  const response = await fetch(`${input.baseUrl.replace(/\/$/, "")}/api/sessions/migrate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.deviceToken}`,
    },
    body: JSON.stringify({
      sandboxId: input.sandboxId,
      name: input.name,
      files: input.files,
      history: input.history,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      `agent-sandbox 迁移失败: HTTP ${response.status} ${typeof body.error === "string" ? body.error : ""}`.trim(),
    );
  }
  return body as unknown as SandboxMigrationResult;
}

/** 云端平台连接配置（env 优先，缺省回落本地文件）。 */
export function readCloudSandboxConfig(env: NodeJS.ProcessEnv = process.env): {
  baseUrl: string;
  deviceToken: string;
} | null {
  const baseUrl = env.AGENT_SANDBOX_URL?.trim();
  const deviceToken = env.AGENT_SANDBOX_DEVICE_TOKEN?.trim();
  if (baseUrl && deviceToken) return { baseUrl, deviceToken };
  return null;
}
