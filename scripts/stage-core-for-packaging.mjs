#!/usr/bin/env node
// electron-builder walks node_modules symlinks and rejects any file whose real
// path escapes packages/desktop — @agent/core is a workspace symlink to
// packages/core, so packaging replaced the link with a real copy of exactly
// what the desktop runtime needs (package.json + dist, declaration maps out).
import { cp, lstat, mkdir, realpath, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(fileURLToPath(new URL("..", import.meta.url)), "packages", "desktop");
const link = join(desktopRoot, "node_modules", "@agent", "core");
const coreRoot = resolve(desktopRoot, "..", "core");

const linkStat = await lstat(link).catch(() => null);
if (linkStat?.isSymbolicLink()) {
  const real = await realpath(link);
  if (!real.startsWith(coreRoot)) {
    console.log(`[stage-core] symlink target ${real} is unexpected — aborting`);
    process.exit(1);
  }
  await rm(link, { recursive: true, force: true });
} else if (linkStat?.isDirectory()) {
  console.log(`[stage-core] ${link} already staged — refreshing`);
  await rm(link, { recursive: true, force: true });
}
await mkdir(join(desktopRoot, "node_modules", "@agent"), { recursive: true });
await cp(coreRoot, link, {
  recursive: true,
  filter: (source) => {
    const relative = source.slice(coreRoot.length);
    if (relative.startsWith("/node_modules")) return false; // hoisted deps stay at the root
    if (relative.endsWith(".d.ts.map") || relative.endsWith(".js.map")) return false;
    return true;
  },
});
const staged = await stat(join(link, "dist", "index.js"));
console.log(`[stage-core] staged real copy of @agent/core (${Math.round(staged.size / 1024)} KB dist/index.js)`);
