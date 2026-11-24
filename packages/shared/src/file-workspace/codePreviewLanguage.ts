// Bound work on the UI thread; larger previews keep their progressive text nodes.
export const MAX_HIGHLIGHT_CHARACTERS = 256 * 1024;
export const MAX_HIGHLIGHT_LINE_LENGTH = 16 * 1024;

const LANGUAGES_BY_EXTENSION: Record<string, string> = {
  java: "java",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript",
  json: "json",
  py: "python",
  sh: "bash", bash: "bash", zsh: "bash",
  css: "css", scss: "scss",
  html: "xml", htm: "xml", xml: "xml", vue: "xml", svelte: "xml", astro: "xml",
  yml: "yaml", yaml: "yaml",
  toml: "ini", env: "ini",
  sql: "sql",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp",
  go: "go", rs: "rust", kt: "kotlin", rb: "ruby",
  md: "markdown", markdown: "markdown", mdown: "markdown", mkdn: "markdown", mdx: "markdown",
  dockerfile: "dockerfile", gradle: "groovy",
  properties: "properties", graphql: "graphql", proto: "protobuf",
};

export function codePreviewLanguage(path: string): string | null {
  const name = path.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if (name === ".env" || name.startsWith(".env.")) return "ini";
  if (name === ".bashrc" || name === ".zshrc") return "bash";
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return LANGUAGES_BY_EXTENSION[extension] ?? null;
}
