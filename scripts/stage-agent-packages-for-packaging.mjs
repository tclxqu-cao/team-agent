#!/usr/bin/env node
// electron-builder walks node_modules symlinks and rejects any file whose real
// path escapes packages/desktop — every @agent/* dependency is a workspace
// symlink, so packaging replaces each link with a real copy of exactly what the
// desktop runtime needs (package.json + dist, declaration maps out).
import { cp, lstat, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputIndex = process.argv.indexOf("--desktop-root");
const output = outputIndex < 0 ? undefined : process.argv[outputIndex + 1];
if (outputIndex >= 0 && (!output || output.startsWith("--"))) throw new Error("--desktop-root requires a directory");
const desktopRoot = output ? resolve(output) : join(repoRoot, "packages", "desktop");

const packages = await Promise.all(["core", "computer-use", "native-runtime", "messaging"].map(async (directory) => {
  const source = join(repoRoot, "packages", directory);
  const { name, files } = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  const link = join(desktopRoot, "node_modules", ...name.split("/"));
  // The link must stay inside packages/<directory>; anything else is a stale or
  // hand-edited symlink and replacing it would silently delete unrelated files.
  const expected = await realpath(source);
  const linkStat = await lstat(link).catch(() => null);
  if (linkStat?.isSymbolicLink()) {
    const real = await realpath(link);
    if (!real.startsWith(expected)) {
      console.error(`[stage-agent-packages] symlink target ${real} is unexpected — aborting`);
      process.exit(1);
    }
    await rm(link, { recursive: true, force: true });
  } else if (linkStat?.isDirectory()) {
    console.log(`[stage-agent-packages] ${link} already staged — refreshing`);
    await rm(link, { recursive: true, force: true });
  }
  return { name, link, source: expected, distOnly: Array.isArray(files) && files.length === 1 && files[0] === "dist" };
}));

for (const { link, source } of packages) await mkdir(join(link, ".."), { recursive: true });

for (const { name, link, source, distOnly } of packages) {
  await cp(source, link, {
    recursive: true,
    filter: (from) => {
      const relative = from.slice(source.length);
      if (relative.startsWith("/node_modules")) return false; // hoisted deps stay at the root
      if (distOnly && relative && relative !== "/package.json" && relative !== "/dist" && !relative.startsWith("/dist/")) return false;
      if (relative.endsWith(".d.ts.map") || relative.endsWith(".js.map")) return false;
      return true;
    },
  });
  const staged = await stat(join(link, "dist", "index.js"));
  console.log(`[stage-agent-packages] staged real copy of ${name} (${Math.round(staged.size / 1024)} KB dist/index.js)`);
}
