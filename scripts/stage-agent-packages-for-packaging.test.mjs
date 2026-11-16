import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

for (const staleKind of ["directory", "symlink"]) {
  test(`stages current packages and removes a stale messaging ${staleKind}`, async t => {
    const root = await mkdtemp(resolve(tmpdir(), "desktop-package-stage-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(resolve(root, "scripts"));
    const script = resolve(root, "scripts/stage-agent-packages-for-packaging.mjs");
    await cp(new URL("./stage-agent-packages-for-packaging.mjs", import.meta.url), script);
    for (const name of ["core", "computer-use", "native-runtime"]) {
      const source = resolve(root, "packages", name);
      await mkdir(resolve(source, "dist"), { recursive: true });
      await writeFile(resolve(source, "package.json"), JSON.stringify({ name: `@agent/${name}`, files: ["dist"] }));
      await writeFile(resolve(source, "dist/index.js"), `export const name = ${JSON.stringify(name)};`);
      await writeFile(resolve(source, "dist/index.js.map"), "private sourcemap");
      await writeFile(resolve(source, "source-only.ts"), "not a runtime artifact");
    }
    const output = resolve(root, "output");
    const scope = resolve(output, "node_modules/@agent");
    await mkdir(scope, { recursive: true });
    const legacy = resolve(root, "legacy-copy");
    await mkdir(legacy);
    await writeFile(resolve(legacy, "keep"), "archived source");
    if (staleKind === "symlink") await symlink(legacy, resolve(scope, "messaging"));
    else await mkdir(resolve(scope, "messaging"));

    execFileSync(process.execPath, [script, "--desktop-root", output], { stdio: "pipe" });

    await assert.rejects(lstat(resolve(scope, "messaging")), { code: "ENOENT" });
    assert.equal(await readFile(resolve(legacy, "keep"), "utf8"), "archived source");
    for (const name of ["core", "computer-use", "native-runtime"]) {
      assert.equal((await lstat(resolve(scope, name))).isSymbolicLink(), false);
      assert.match(await readFile(resolve(scope, name, "dist/index.js"), "utf8"), new RegExp(name));
      await assert.rejects(lstat(resolve(scope, name, "dist/index.js.map")), { code: "ENOENT" });
      await assert.rejects(lstat(resolve(scope, name, "source-only.ts")), { code: "ENOENT" });
    }
  });
}
