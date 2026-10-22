import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Lite uses an explicit allowlist, so new local imports must be shipped too.
test("Lite packaging includes the entry point's local modules", () => {
  const entry = readFileSync(new URL("./lite-index.ts", import.meta.url), "utf8");
  const config = readFileSync(new URL("../electron-builder-lite.yml", import.meta.url), "utf8");
  for (const [, file] of entry.matchAll(/from "\.\/(.+\.js)"/g)) {
    expect(config).toContain(`  - dist/main/${file}`);
  }
});
