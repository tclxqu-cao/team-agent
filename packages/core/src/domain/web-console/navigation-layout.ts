export type NavigationLayout = "classic" | "agent-rail";

export const DEFAULT_NAVIGATION_LAYOUT: NavigationLayout = "agent-rail";
export const NAVIGATION_LAYOUT_MESSAGE = "agent-web-shell:navigation-layout:v1";

export function isNavigationLayout(value: unknown): value is NavigationLayout {
  return value === "classic" || value === "agent-rail";
}

export function nextNavigationLayout(value: NavigationLayout): NavigationLayout {
  return value === "classic" ? "agent-rail" : "classic";
}

export function readNavigationLayoutMessage(value: unknown): NavigationLayout | null {
  if (!value || typeof value !== "object") return null;
  const message = value as { type?: unknown; navigationLayout?: unknown };
  return message.type === NAVIGATION_LAYOUT_MESSAGE && isNavigationLayout(message.navigationLayout)
    ? message.navigationLayout : null;
}
