import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export interface KnowledgeResult {
  query: string;
  status: string;
  snippets: Array<{ path: string; title: string; text: string }>;
}
interface WikiConfig { root: string; collection: string; command: string; }

function configValues(text: string): Record<string, string> {
  return Object.fromEntries(text.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*(?:export\s+)?(OBSIDIAN_VAULT_PATH|QMD_WIKI_COLLECTION|QMD_CLI)\s*=\s*(.*?)\s*$/);
    return match ? [[match[1], match[2].replace(/^(['"])(.*)\1$/, "$2")]] : [];
  }));
}
export async function wikiConfig(env: NodeJS.ProcessEnv = process.env, home = homedir(), cwd = process.cwd()): Promise<WikiConfig | null> {
  let values: Record<string, string> = {};
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    try {
      const local = configValues(await readFile(join(directory, ".env"), "utf8"));
      if (Object.hasOwn(local, "OBSIDIAN_VAULT_PATH")) { values = local; break; }
    } catch { /* Most project directories have no wiki configuration. */ }
    if (directory === home || dirname(directory) === directory) break;
  }
  if (!Object.hasOwn(values, "OBSIDIAN_VAULT_PATH")) {
    for (const path of [join(env.XDG_CONFIG_HOME || join(home, ".config"), "obsidian-wiki", "config"), join(home, ".obsidian-wiki", "config")]) {
      try { values = configValues(await readFile(path, "utf8")); break; } catch { /* Try the legacy config location. */ }
    }
  }
  const configured = env.AGENT_MESSAGING_WIKI_DIR ?? env.OBSIDIAN_VAULT_PATH ?? values.OBSIDIAN_VAULT_PATH;
  if (!configured?.trim()) return null;
  const path = configured.trim().replace(/^~(?=\/|$)/, home);
  return { root: resolve(path), collection: env.QMD_WIKI_COLLECTION ?? values.QMD_WIKI_COLLECTION ?? "",
    command: env.QMD_CLI || values.QMD_CLI || "qmd" };
}

export function compiledWikiPath(path: string): boolean {
  const parts = path.replace(/\\/g, "/").split("/");
  return /\.md$/i.test(path) && ["projects", "concepts", "entities", "references", "synthesis", "journal", "skills"].includes(parts[0])
    && !parts.some(part => part.startsWith(".") || part.startsWith("_") || ["raw", "archived", "hot", "cold"].includes(part.toLowerCase()));
}

/** Reads compiled wiki evidence only; model output never chooses an executable or arbitrary path. */
export class WikiKnowledge {
  constructor(private readonly config = wikiConfig, private readonly run = execute) {}
  async search(input: string): Promise<KnowledgeResult> {
    const query = input.replace(/[\r\n]/g, " ").trim().slice(0, 500);
    const result: KnowledgeResult = { query, status: "知识库未配置", snippets: [] };
    const config = await this.config();
    if (!config || !query) return result;
    let root: string;
    try { root = await realpath(config.root); } catch { return { ...result, status: "知识库目录不可读" }; }
    const paths: Array<{ path: string; title?: string }> = [];
    if (config.collection) {
      try {
        const { stdout } = await this.run(config.command, ["search", query, "-c", config.collection, "-n", "12", "--format", "json", "--full-path"],
          { timeout: 8000, maxBuffer: 1_000_000, windowsHide: true });
        const hits: unknown = JSON.parse(stdout);
        if (Array.isArray(hits)) for (const hit of hits) {
          if (typeof hit?.file === "string" && isAbsolute(hit.file)) paths.push({ path: relative(root, hit.file), title: typeof hit.title === "string" ? hit.title : undefined });
        }
      } catch { /* A missing/stale qmd index falls back to the wiki's compiled catalog. */ }
    }
    const terms = [...new Set(query.toLowerCase().match(/[a-z][a-z0-9_.-]{1,40}|[\p{Script=Han}]{2,16}/gu) ?? [])];
    try {
      const index = await readFile(join(root, "index.md"), "utf8");
      const ranked = index.split("\n").flatMap(line => {
        const path = line.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/)?.[1];
        const score = terms.reduce((sum, term) => sum + (line.toLowerCase().includes(term) ? term.length : 0), 0);
        return path && score > 0 ? [{ path: path.endsWith(".md") ? path : path + ".md", score }] : [];
      }).sort((a, b) => b.score - a.score);
      paths.push(...ranked.slice(0, 12));
    } catch { /* qmd results remain usable without the catalog. */ }
    const seen = new Set<string>();
    for (const item of paths) {
      if (!compiledWikiPath(item.path) || seen.has(item.path)) continue;
      seen.add(item.path);
      try {
        const path = await realpath(join(root, item.path));
        if (!path.startsWith(root + sep) || (await stat(path)).size > 512_000) continue;
        const content = await readFile(path, "utf8");
        const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (frontmatter && /visibility\s*:\s*pii|visibility\/pii|lifecycle\s*:\s*(?:archived|disputed)/i.test(frontmatter[1])) continue;
        const body = content.slice(frontmatter?.[0].length ?? 0).trim();
        const lines = body.split("\n");
        let start = 0; let best = 0;
        lines.forEach((line, index) => {
          const score = terms.reduce((sum, term) => sum + (line.toLowerCase().includes(term) ? 1 : 0), 0);
          if (score > best) { best = score; start = Math.max(0, index - 3); }
        });
        const text = lines.slice(start, start + 55).join("\n").slice(0, 3500);
        if (text) result.snippets.push({ path: item.path, title: item.title || body.match(/^#\s+(.+)$/m)?.[1] || item.path, text });
      } catch { /* Skip missing catalog entries and paths outside the current vault. */ }
      if (result.snippets.length === 4) break;
    }
    result.status = result.snippets.length ? "已检索知识库，引用 " + result.snippets.length + " 篇资料" : "知识库未检索到相关资料";
    return result;
  }
}
