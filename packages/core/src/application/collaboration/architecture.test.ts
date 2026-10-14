import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const application = dirname(fileURLToPath(import.meta.url));
const domain = resolve(application, "../../domain/collaboration");

describe("collaboration DDD boundaries", () => {
  for (const [layer, allowed] of [
    [domain, [domain]],
    [application, [application, domain]],
  ] as const) {
    it(`${layer.split("/").slice(-2).join("/")} depends only on inner layers`, () => {
      for (const name of readdirSync(layer).filter(
        (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
      )) {
        const source = readFileSync(resolve(layer, name), "utf8");
        for (const match of source.matchAll(
          /(?:from\s*|import\s*\()(["'])([^"']+)\1/g,
        )) {
          const dependency = match[2];
          if (!dependency.startsWith(".")) {
            expect(dependency, `${name}: external dependency`).toBe("zod");
            continue;
          }
          const target = resolve(layer, dependency);
          expect(
            allowed.some((root) => target.startsWith(root + "/")),
            `${name}: ${dependency}`,
          ).toBe(true);
        }
      }
    });
  }
});
