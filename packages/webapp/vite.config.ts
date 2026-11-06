import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { devMobilePairing } from "../../scripts/dev-mobile-pairing.mjs";

// Web shell for the desktop renderer UI (mobile-adapted). Reuses:
// - presentation:  @desktop/renderer components (imported from source)
// - domain types:  @agent/core (type-only imports inside the renderer)
// - server能力:    packages/server HTTP/SSE APIs (via the gateway adapter)
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, __dirname, "AGENT_"), ...process.env };
  const backend = env.AGENT_DEV_BACKEND_URL || "http://127.0.0.1:3000";
  return {
  plugins: [react(), devMobilePairing({ backend, accessUrl: env.AGENT_MOBILE_ACCESS_URL })],
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
      "next/dynamic": resolve(__dirname, "src/mobile/infrastructure/lazy-console-component.tsx"),
    },
  },
  server: {
    port: 5175,
    allowedHosts: (env.AGENT_WEB_ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
      .map((origin) => new URL(origin.includes("://") ? origin : `http://${origin}`).hostname),
    proxy: {
      "/app": { target: backend, changeOrigin: false },
      "/pair": { target: backend, changeOrigin: false },
      "/pwa": { target: backend, changeOrigin: false },
      "/manifest.webmanifest": { target: backend, changeOrigin: false },
      // Preserve Host so the gateway can validate browser Origin on writes.
      "/api": { target: backend, changeOrigin: false },
      "/ws": { target: backend.replace(/^http/, "ws"), ws: true, changeOrigin: false },
    },
  },
  };
});
