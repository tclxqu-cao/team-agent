import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { prepareChromeExtension } from "./chrome-extension-install";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const source = fileURLToPath(new URL("../../chrome-extension", import.meta.url));
describe("private auto-connect extension bundle", () => {
  it("creates a stable local install with private, replaceable credentials and no web exposure", () => {
    const root = mkdtempSync(join(tmpdir(), "aihub-extension-")); roots.push(root);
    const target = join(root, "extension");
    expect(prepareChromeExtension(source, target, `aihub:19473:${"a".repeat(64)}`)).toBe(target);
    const read = () => JSON.parse(readFileSync(join(target, "bootstrap.json"), "utf8"));
    expect(read()).toEqual({ port: 19473, token: "a".repeat(64) });
    expect(statSync(target).mode & 0o777).toBe(0o700);
    expect(statSync(join(target, "bootstrap.json")).mode & 0o777).toBe(0o600);
    prepareChromeExtension(source, target, `aihub:19474:${"b".repeat(64)}`);
    expect(read()).toEqual({ port: 19474, token: "b".repeat(64) });
    const manifest = JSON.parse(readFileSync(join(target, "manifest.json"), "utf8"));
    expect(manifest.web_accessible_resources).toBeUndefined();
    expect(manifest.permissions).not.toContain("cookies");
    expect(manifest.content_security_policy.extension_pages).toContain("connect-src 'self'");
  });
  it("rejects invalid local credentials before writing a bundle", () => {
    expect(() => prepareChromeExtension(source, "/unused", "aihub:0:bad")).toThrow("chrome-bridge-unavailable");
  });
});
