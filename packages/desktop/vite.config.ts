import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  base: "./",
  root: "renderer",
  build: {
    outDir: "../renderer-dist",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@agent/core": resolve(__dirname, "../core/src"),
    },
  },
});
