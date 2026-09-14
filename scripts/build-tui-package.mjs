import { cp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const targetIndex = process.argv.indexOf("--targets");
const targets = targetIndex < 0 ? ["darwin-arm64", "windows-amd64"] : (process.argv[targetIndex + 1] ?? "").split(",");
if (!targets.length || targets.some((target) => !["darwin-arm64", "windows-amd64"].includes(target))) throw new Error("invalid TUI targets");
const darwinOutdir = resolve(root, "packages/tui-darwin-arm64/dist");
const windowsOutdir = resolve(root, "packages/tui-win32-x64/dist");
const outdirs = targets.map((target) => target === "darwin-arm64" ? darwinOutdir : windowsOutdir);
await Promise.all(outdirs.map((outdir) => rm(outdir, { recursive: true, force: true })));

const result = await Bun.build({
  entrypoints: [resolve(root, "packages/tui/agent-tui.mjs")],
  outdir: outdirs[0],
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
  for (const outdir of outdirs.slice(1)) await cp(outdirs[0], outdir, { recursive: true });
  const output = result.outputs[0];
  console.log(`bundled agent-tui for ${targets.join(" and ")}: ${output.size} bytes each`);
}
