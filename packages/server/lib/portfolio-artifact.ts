import sanitizeHtml from "sanitize-html";

const MAX_BLOCKS = 24;
const MAX_TEXT = 24_000;
const MAX_HTML = 80_000;
const MAX_TITLE = 160;

export type PortfolioBlock =
  | { type: "text"; text: string; tone?: "body" | "lead" | "meta" | "success" | "warning" | "error" }
  | { type: "image"; src: string; alt: string; caption?: string }
  | { type: "video"; src: string; poster?: string; caption?: string }
  | { type: "html"; html: string };

export interface PortfolioArtifactV1 {
  schemaVersion: 1;
  skill: string;
  title: string;
  summary?: string;
  blocks: PortfolioBlock[];
  suggestions?: string[];
  sources?: string[];
  generatedAt: string;
}

const ALLOWED_TAGS = [
  "section", "article", "header", "footer", "h1", "h2", "h3", "h4",
  "p", "span", "strong", "b", "em", "small", "code", "pre", "blockquote",
  "ul", "ol", "li", "dl", "dt", "dd", "a", "br", "hr", "figure", "figcaption",
  "table", "thead", "tbody", "tr", "th", "td", "div", "button",
];

const ALLOWED_CLASSES = [
  "artifact", "artifact-grid", "artifact-flow", "artifact-flow-step", "artifact-flow-arrow",
  "artifact-kicker", "artifact-title", "artifact-meta", "artifact-list", "artifact-links",
  "t-lead", "t-dim", "t-hl", "t-out", "t-note", "t-quote", "t-ul", "t-cols", "t-tl",
  "t-year", "t-run", "t-group", "t-pipeline",
];

const SAFE_SUGGESTION = /^\/(?:help|whoami|works|jobs|timeline|contact|project [a-z0-9-]+)$/i;

export function sanitizePortfolioHtml(input: string): string {
  return sanitizeHtml(input.slice(0, MAX_HTML), {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      "*": ["class", "aria-label", "role"],
      a: ["href", "title", "target", "rel"],
      button: ["type", "data-command"],
    },
    allowedClasses: { "*": ALLOWED_CLASSES },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    transformTags: {
      a: (_tagName, attribs) => ({
        tagName: "a",
        attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer" },
      }),
    },
    exclusiveFilter: (frame) => {
      if (frame.tag === "a") return !isSafeContentUrl(frame.attribs.href ?? "", true);
      if (frame.tag === "button") return !/^\/(?:help|whoami|works|jobs|timeline|contact|project\s+[a-z0-9-]+)$/i.test(frame.attribs["data-command"] ?? "");
      return false;
    },
  });
}

export function parsePortfolioArtifact(text: string, expectedSkill: string): PortfolioArtifactV1 {
  const candidate = extractJsonObject(text);
  let raw: unknown;
  try {
    raw = JSON.parse(candidate);
  } catch {
    throw new Error("Portfolio Skill did not return valid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Portfolio artifact must be an object");
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1) throw new Error("Unsupported portfolio artifact schemaVersion");
  if (value.skill !== expectedSkill) throw new Error("Portfolio artifact skill mismatch");
  const title = boundedString(value.title, "title", MAX_TITLE);
  if (!Array.isArray(value.blocks) || value.blocks.length === 0 || value.blocks.length > MAX_BLOCKS) {
    throw new Error(`Portfolio artifact blocks must contain 1-${MAX_BLOCKS} items`);
  }
  const blocks = value.blocks.map((block, index) => normalizeBlock(block, index));
  return {
    schemaVersion: 1,
    skill: expectedSkill,
    title,
    ...(typeof value.summary === "string" && value.summary.trim()
      ? { summary: value.summary.trim().slice(0, 1_000) }
      : {}),
    blocks,
    suggestions: normalizeStringArray(value.suggestions, 12, 80).filter((item) => SAFE_SUGGESTION.test(item)),
    sources: normalizeStringArray(value.sources, 30, 500).filter(isSafeSource),
    generatedAt: new Date().toISOString(),
  };
}

function normalizeBlock(raw: unknown, index: number): PortfolioBlock {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Invalid block at index ${index}`);
  const block = raw as Record<string, unknown>;
  if (block.type === "text") {
    const text = boundedString(block.text, `blocks[${index}].text`, MAX_TEXT);
    const tones = new Set(["body", "lead", "meta", "success", "warning", "error"]);
    const tone = typeof block.tone === "string" && tones.has(block.tone)
      ? block.tone as "body" | "lead" | "meta" | "success" | "warning" | "error"
      : undefined;
    return { type: "text", text, ...(tone ? { tone } : {}) };
  }
  if (block.type === "image") {
    const src = contentUrl(block.src, `blocks[${index}].src`);
    return { type: "image", src, alt: boundedString(block.alt || "Portfolio image", `blocks[${index}].alt`, 500), ...caption(block.caption) };
  }
  if (block.type === "video") {
    const src = contentUrl(block.src, `blocks[${index}].src`);
    const poster = typeof block.poster === "string" && block.poster.trim()
      ? contentUrl(block.poster, `blocks[${index}].poster`)
      : undefined;
    return { type: "video", src, ...(poster ? { poster } : {}), ...caption(block.caption) };
  }
  if (block.type === "html") {
    const html = sanitizePortfolioHtml(boundedString(block.html, `blocks[${index}].html`, MAX_HTML));
    if (!html.trim()) throw new Error(`blocks[${index}].html is empty after sanitization`);
    return { type: "html", html };
  }
  throw new Error(`Unsupported block type at index ${index}`);
}

function caption(value: unknown): { caption?: string } {
  return typeof value === "string" && value.trim() ? { caption: value.trim().slice(0, 500) } : {};
}

function contentUrl(value: unknown, field: string): string {
  const url = boundedString(value, field, 2_000);
  if (!isSafeContentUrl(url, false)) throw new Error(`${field} uses an unsafe or unapproved URL`);
  return url;
}

function isSafeContentUrl(value: string, link: boolean): boolean {
  if (!value) return false;
  if (value.startsWith("/assets/") || value.startsWith("assets/")) return !link;
  try {
    const url = new URL(value);
    if (url.protocol === "mailto:") return link;
    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (link) return true;
    const configured = (process.env.PORTFOLIO_MEDIA_ORIGINS ?? "")
      .split(",").map((item) => item.trim()).filter(Boolean);
    if (configured.length === 0) return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname.endsWith(".vercel.app");
    return configured.some((origin) => {
      try { return new URL(origin).origin === url.origin; } catch { return false; }
    });
  } catch {
    return false;
  }
}

function isSafeSource(value: string): boolean {
  if (!value.endsWith(".md") || value.startsWith("/") || value.includes("\\")) return false;
  return !value.split("/").some((part) => !part || part === "." || part === "..");
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  if (value.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return value.trim();
}

function normalizeStringArray(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, maxChars)).filter(Boolean);
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}
