export type NavigationLayout = "classic" | "agent-rail" | "all-sessions";
export declare const NAVIGATION_LAYOUT_LABELS: Record<NavigationLayout, string>;
export declare const DEFAULT_NAVIGATION_LAYOUT: NavigationLayout;
export declare const NAVIGATION_LAYOUT_MESSAGE = "agent-web-shell:navigation-layout:v1";
export declare function isNavigationLayout(value: unknown): value is NavigationLayout;
export declare function nextNavigationLayout(value: NavigationLayout): NavigationLayout;
export declare function navigationLayoutSwitchTitle(value: NavigationLayout): string;
export declare function readNavigationLayoutMessage(value: unknown): NavigationLayout | null;
//# sourceMappingURL=navigation-layout.d.ts.map