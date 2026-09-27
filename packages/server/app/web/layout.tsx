import type { CSSProperties, ReactNode } from "react";
import type { Viewport } from "next";
import { anonymousPrincipal, webConsoleStore } from "../../lib/web-auth/anonymous";
import { resolveWebTheme } from "./themes";
import "./neural-boot.css";

export const dynamic = "force-dynamic";

function loadInitialWebTheme() {
  try {
    const { userId } = anonymousPrincipal();
    return resolveWebTheme(webConsoleStore.getPreferences(userId)?.theme);
  } catch {
    return resolveWebTheme(undefined);
  }
}

export function generateViewport(): Viewport {
  const theme = loadInitialWebTheme();
  return {
    colorScheme: theme.cssVars["--ui-color-scheme"] as "light" | "dark",
    themeColor: theme.cssVars["--ui-tabbar-bg"],
  };
}

export default function WebLayout({ children }: { children: ReactNode }) {
  const theme = loadInitialWebTheme();
  const style = {
    ...theme.cssVars,
    colorScheme: theme.cssVars["--ui-color-scheme"],
    background: theme.cssVars["--ui-root-bg"],
    color: theme.cssVars["--ui-text"],
  } as CSSProperties;

  return (
    <div id="web-theme-root" data-web-theme={theme.id} style={style}>
      {children}
    </div>
  );
}
