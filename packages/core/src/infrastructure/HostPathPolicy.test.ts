import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { describe, expect, it } from "vitest";
import { HostPathError, HostPathPolicy, isPathInsideRoot } from "./HostPathPolicy";

describe("HostPathPolicy", () => {
  it("treats the filesystem root as containing normal descendants", () => {
    const root = parse(process.cwd()).root;
    expect(isPathInsideRoot(root, process.cwd())).toBe(true);
  });

  it("does not confuse sibling path prefixes", () => {
    expect(isPathInsideRoot("/Users/foo", "/Users/foo2/project")).toBe(false);
    expect(isPathInsideRoot("/Users/foo", "/Users/foo/project")).toBe(true);
  });

  it("canonicalizes roots and lists directories before files", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-host-policy-"));
    mkdirSync(join(root, "beta"));
    mkdirSync(join(root, "Alpha"));
    mkdirSync(join(root, ".hidden"));
    writeFileSync(join(root, "file.txt"), "not a directory");

    const policy = new HostPathPolicy([root]);
    expect(policy.assertDirectory(join(root, "Alpha", "..", "beta"))).toBe(realpathSync(join(root, "beta")));
    expect(policy.listDirectories(root).map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "Alpha", kind: "directory" },
      { name: "beta", kind: "directory" },
      { name: ".hidden", kind: "directory" },
      { name: "file.txt", kind: "file" },
    ]);
  });

  it("rejects missing paths, files, and siblings", () => {
    const parent = mkdtempSync(join(tmpdir(), "agent-host-policy-parent-"));
    const root = join(parent, "allowed");
    const sibling = join(parent, "allowed-sibling");
    mkdirSync(root);
    mkdirSync(sibling);
    writeFileSync(join(root, "file.txt"), "file");
    const policy = new HostPathPolicy([root]);

    expect(() => policy.assertDirectory(join(root, "missing"))).toThrowError(
      expect.objectContaining({ code: "PATH_NOT_FOUND" }),
    );
    expect(() => policy.assertDirectory(join(root, "file.txt"))).toThrowError(
      expect.objectContaining({ code: "PATH_NOT_DIRECTORY" }),
    );
    expect(() => policy.assertDirectory(sibling)).toThrowError(
      expect.objectContaining({ code: "PATH_OUTSIDE_ROOT" }),
    );
  });

  it("rejects symlinks that escape an allowed root", () => {
    const parent = mkdtempSync(join(tmpdir(), "agent-host-policy-link-"));
    const root = join(parent, "allowed");
    const outside = join(parent, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    symlinkSync(outside, join(root, "escape"), "dir");
    const policy = new HostPathPolicy([root]);

    expect(() => policy.assertDirectory(join(root, "escape"))).toThrowError(
      expect.objectContaining({ code: "PATH_OUTSIDE_ROOT" }),
    );
    expect(policy.listDirectories(root)).toEqual([]);
  });

  it("reports an empty configured policy as unreadable", () => {
    expect(() => new HostPathPolicy([])).toThrowError(HostPathError);
  });
});
