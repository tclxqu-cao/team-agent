export type NavigationLayout = "classic" | "agent-rail" | "all-sessions";

export const NAVIGATION_LAYOUT_LABELS: Record<NavigationLayout, string> = {
  classic: "原布局",
  "agent-rail": "单层抬头",
  "all-sessions": "所有会话",
};

export const DEFAULT_NAVIGATION_LAYOUT: NavigationLayout = "agent-rail";
export const NAVIGATION_LAYOUT_MESSAGE = "agent-web-shell:navigation-layout:v1";

export function isNavigationLayout(value: unknown): value is NavigationLayout {
  return value === "classic" || value === "agent-rail" || value === "all-sessions";
}

export function nextNavigationLayout(value: NavigationLayout): NavigationLayout {
  return value === "classic" ? "agent-rail" : value === "agent-rail" ? "all-sessions" : "classic";
}

export function navigationLayoutSwitchTitle(value: NavigationLayout): string {
  return `${NAVIGATION_LAYOUT_LABELS[value]} · 切换到${NAVIGATION_LAYOUT_LABELS[nextNavigationLayout(value)]}`;
}

export function readNavigationLayoutMessage(value: unknown): NavigationLayout | null {
  if (!value || typeof value !== "object") return null;
  const message = value as { type?: unknown; navigationLayout?: unknown };
  return message.type === NAVIGATION_LAYOUT_MESSAGE && isNavigationLayout(message.navigationLayout)
    ? message.navigationLayout : null;
}
