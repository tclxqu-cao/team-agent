import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeOsc7Path, isPowerShell, selectDefaultShell } from "./shell-platform.mjs";

describe("shell platform helpers", () => {
  it("preserves the configured POSIX shell", () => {
    assert.equal(selectDefaultShell("darwin", { SHELL: "/bin/fish" }, () => false), "/bin/fish");
  });

  it("prefers pwsh and falls back to Windows PowerShell", () => {
    const env = { PATH: "C:\\Tools;C:\\Windows\\System32" };
    assert.equal(selectDefaultShell("win32", env, (candidate) => candidate === "C:\\Tools\\pwsh.exe"), "C:\\Tools\\pwsh.exe");
    assert.equal(
      selectDefaultShell("win32", env, (candidate) => candidate === "C:\\Windows\\System32\\powershell.exe"),
      "C:\\Windows\\System32\\powershell.exe",
    );
  });

  it("recognizes PowerShell executable paths", () => {
    assert.equal(isPowerShell("C:\\Program Files\\PowerShell\\7\\pwsh.exe"), true);
    assert.equal(isPowerShell("powershell.exe"), true);
    assert.equal(isPowerShell("cmd.exe"), false);
  });

  it("decodes POSIX, drive-letter, and UNC OSC 7 paths", () => {
    assert.equal(decodeOsc7Path("file:///Users/example/project", "darwin"), "/Users/example/project");
    assert.equal(decodeOsc7Path("file:///C:/Users/example/project", "win32"), "C:\\Users\\example\\project");
    assert.equal(decodeOsc7Path("file://server/share/project", "win32"), "\\\\server\\share\\project");
  });
});
