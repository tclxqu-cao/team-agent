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
