import path from "node:path";
import type { ProjectCandidate } from "./resources.js";

export type ProjectNavigation =
  | { type: "none" }
  | { type: "match"; project: ProjectCandidate }
  | { type: "ambiguous"; query: string; projects: ProjectCandidate[] };

const NAVIGATION_PATTERNS = [
  /(?:我要|我想|请|帮我)?\s*(?:进入|切换(?:到|至)?|打开|前往|定位(?:到)?|去(?:到)?)\s*(?:一下|下)?\s*([^，。！？!?]+?)\s*(?:项目|目录|仓库)(?:里|中)?\s*[。！？!?]*$/i,
  /(?:switch|open|go\s+to)\s+(.+?)\s+(?:project|repo|repository|directory)\s*[.!?]*$/i,
];

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_\-]+/g, "");
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) >= 0) {
    count++;
    index += needle.length;
  }
  return count;
}

function focusedDomainScore(metadata: string, needle: string): number {
  if (metadata.includes(`${needle}域`)) return 7_000;
  for (const marker of ["聚焦", "专注", "主责"]) {
    let markerIndex = metadata.indexOf(marker);
    while (markerIndex >= 0) {
      const queryIndex = metadata.indexOf(needle, markerIndex + marker.length);
      if (queryIndex >= 0 && queryIndex - markerIndex <= 24) return 6_000;
      markerIndex = metadata.indexOf(marker, markerIndex + marker.length);
    }
  }
  return 0;
}

function projectScore(project: ProjectCandidate, query: string): number {
  if (project.disabled || !project.path) return 0;
  const needle = normalize(query);
  const label = normalize(project.label);
  const directory = normalize(path.basename(project.path));
  const value = normalize(project.value);
  if (label === needle || directory === needle) return 10_000;
  if (label.includes(needle) || directory.includes(needle)) return 9_000;
  if (value.includes(needle)) return 8_000;
  const metadata = normalize(project.metadata?.searchText ?? "");
  const focusedScore = focusedDomainScore(metadata, needle);
  if (focusedScore > 0) return focusedScore;
  const count = occurrences(metadata, needle);
  return count > 0 ? 100 + Math.min(count, 100) : 0;
}

function navigationQuery(input: string): string | null {
  for (const pattern of NAVIGATION_PATTERNS) {
    const match = pattern.exec(input.trim());
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return null;
}

export function resolveProjectNavigation(
  input: string,
  projects: readonly ProjectCandidate[],
): ProjectNavigation {
  const query = navigationQuery(input);
  if (!query) return { type: "none" };
  const ranked = projects
    .map((project) => ({ project, score: projectScore(project, query) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.project.label.localeCompare(right.project.label));
  if (ranked.length === 0) return { type: "none" };
  const top = ranked.filter((candidate) => candidate.score === ranked[0].score).map((candidate) => candidate.project);
  return top.length === 1
    ? { type: "match", project: top[0] }
    : { type: "ambiguous", query, projects: top };
}
