import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outdir = resolve(root, "packages/tui-darwin-arm64/dist");
await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [resolve(root, "packages/tui/agent-tui.mjs")],
  outdir,
  naming: "agent-tui.js",
  target: "node",
  format: "esm",
  minify: true,
  external: ["better-sqlite3", "bun:sqlite"],
  define: { "process.env.DEV": JSON.stringify("false") },
  plugins: [{
    name: "disable-ink-react-devtools",
    setup(build) {
      build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
        path: "react-devtools-core",
        namespace: "agentroam-production-shim",
      }));
      build.onLoad({ filter: /.*/, namespace: "agentroam-production-shim" }, () => ({
        contents: "export default { connectToDevTools() {} };",
        loader: "js",
      }));
    },
  }],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
} else {
  const output = result.outputs[0];
  console.log(`bundled agent-tui: ${output.size} bytes`);
}
