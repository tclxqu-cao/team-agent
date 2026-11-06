import { execFileSync } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
execFileSync("bun", ["build", "./src/index.ts", "--outdir", "./dist", "--target", "node", "--format", "esm", "--sourcemap=external", "--external", "@agent/core"], { cwd: root, stdio: "inherit" });
await mkdir(new URL("./dist/assets/wecom/", import.meta.url), { recursive: true });
await cp(new URL("./assets/wecom/", import.meta.url), new URL("./dist/assets/wecom/", import.meta.url), {
  recursive: true,
  filter: path => !path.endsWith("_test.py") && !path.includes("__pycache__") && !path.endsWith(".pyc"),
});
