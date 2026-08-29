import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// Web shell for the desktop renderer UI (mobile-adapted). Reuses:
// - presentation:  @desktop/renderer components (imported from source)
// - domain types:  @agent/core (type-only imports inside the renderer)
// - server能力:    packages/server HTTP/SSE APIs (via the gateway adapter)
export default defineConfig({
  plugins: [react()],
  base: "./",
  // The renderer's PcmStreamPlayer loads ./pcm-audio-worklet.js relative to
  // the page — reuse the desktop renderer's public assets.
  publicDir: resolve(__dirname, "../desktop/renderer/public"),
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@agent/core": resolve(__dirname, "../core/src"),
      "@desktop/renderer": resolve(__dirname, "../desktop/renderer"),
    },
  },
  server: {
    port: 5175,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
});
