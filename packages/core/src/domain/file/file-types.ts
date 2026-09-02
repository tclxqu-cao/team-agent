export type FileContentKind =
  | "code"
  | "style"
  | "image"
  | "video"
  | "audio"
  | "markdown"
  | "text"
  | "json"
  | "archive"
  | "spreadsheet"
  | "presentation"
  | "database"
  | "file";

const extensionGroups: Array<[FileContentKind, Set<string>]> = [
  ["style", new Set(["css", "scss", "sass", "less", "styl"])],
  ["image", new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg", "tif", "tiff"])],
  ["video", new Set(["mp4", "mov", "m4v", "webm", "mkv", "avi", "wmv", "flv", "mpeg", "mpg"])],
  ["audio", new Set(["mp3", "wav", "m4a", "aac", "ogg", "flac", "opus"])],
  ["markdown", new Set(["md", "mdx", "markdown"])],
  ["json", new Set(["json", "jsonc", "geojson"])],
  ["archive", new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"])],
  ["spreadsheet", new Set(["csv", "tsv", "xls", "xlsx", "ods"])],
  ["presentation", new Set(["ppt", "pptx", "key", "odp"])],
  ["database", new Set(["db", "sqlite", "sqlite3"])],
  ["text", new Set(["txt", "log", "rtf", "ini", "cfg", "conf", "env", "yaml", "yml", "toml", "xml", "pdf", "doc", "docx", "odt"])],
  ["code", new Set([
    "js", "jsx", "mjs", "cjs", "ts", "tsx", "vue", "svelte", "java", "kt", "kts", "py", "rb", "go", "rs",
    "php", "c", "cc", "cpp", "h", "hpp", "cs", "swift", "scala", "sh", "bash", "zsh", "fish", "sql", "html",
  ])],
];

const fileNameKinds = new Map<string, FileContentKind>([
  ["dockerfile", "code"],
  ["makefile", "code"],
  ["gemfile", "code"],
  ["rakefile", "code"],
  ["license", "text"],
]);

export function classifyFileContent(name: string): FileContentKind {
  const normalized = name.toLocaleLowerCase();
  const exact = fileNameKinds.get(normalized);
  if (exact) return exact;
  if (normalized.startsWith(".env") || normalized === ".gitignore" || normalized === ".npmrc") return "text";
  const extension = normalized.includes(".") ? normalized.split(".").pop() || "" : "";
  return extensionGroups.find(([, extensions]) => extensions.has(extension))?.[0] ?? "file";
}
