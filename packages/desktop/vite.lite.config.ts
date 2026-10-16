import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()], base: "./", root: "renderer",
  build: { outDir: "../renderer-lite-dist", emptyOutDir: true, rollupOptions: { input: resolve(__dirname, "renderer/lite.html") } },
});
