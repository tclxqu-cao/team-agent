/**
 * Ambient view of the reused desktop renderer UI module.
 *
 * The desktop renderer is transpiled by Vite (esbuild) exactly as the
 * Electron build does — it is deliberately NOT part of this package's
 * strict tsc program (the desktop tsconfig excludes renderer sources too,
 * so they were never tsc-checked there either). Vite aliases
 * `@desktop/renderer` to ../desktop/renderer for the actual build.
 * Port types are imported straight from the renderer's global.d.ts.
 */
declare module "@desktop/renderer/App" {
  import type { ComponentType } from "react";
  const App: ComponentType;
  export default App;
}

declare module "@desktop/renderer/stores/uiStore" {
  export type SkinId = "pearl" | "scifi" | "noir" | "mist" | "pine" | "graphite";
  interface UIStateSlice {
    skin: SkinId;
    setSkin: (skin: SkinId) => void;
  }
  export const SKINS: Array<{ id: SkinId; label: string; preview: [string, string] }>;
  export const useUIStore: {
    getState: () => UIStateSlice;
    subscribe: (listener: (state: UIStateSlice, previous: UIStateSlice) => void) => () => void;
  };
}

declare module "@desktop/renderer/components/browser-live-header-context" {
  export const BrowserLiveHeaderContext: import("react").Context<import("react").ReactNode>;
}

declare module "@desktop/renderer/components/BrowserLivePanel" {
  import type { ComponentType } from "react";
  const BrowserLivePanel: ComponentType<{ open: boolean; active?: boolean; agentSessionId?: string | null; onClose: () => void; onFullscreenChange?: (fullscreen: boolean) => void }>;
  export default BrowserLivePanel;
}

declare module "next/dynamic" {
  import type { ComponentType, ReactNode } from "react";
  export default function dynamic<P extends object>(
    load: () => Promise<{ default: ComponentType<P> }>,
    options?: { ssr?: boolean; loading?: () => ReactNode },
  ): ComponentType<P>;
}
