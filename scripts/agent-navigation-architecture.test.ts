import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const domainRoot = resolve(root, "packages/core/src/domain");
const nodeModules = new Set(builtinModules.map(name => name.replace(/^node:/, "")));

function dependencies(source: string): string[] {
  const file = ts.createSourceFile("module.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const result: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      result.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && (
      node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require")
    ) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      result.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
}

describe("Agent navigation DDD boundaries", () => {
  it("checks side-effect imports, re-exports and dynamic process imports", () => {
    expect(dependencies('import "node:fs"; export { x } from "./port"; import("node:child_process"); require("path");'))
      .toEqual(["node:fs", "./port", "node:child_process", "path"]);
  });

  it.each([
    "packages/core/src/domain/agent/agent-type.ts",
    "packages/core/src/domain/web-console/navigation-layout.ts",
  ])("keeps %s independent of infrastructure and browser state", path => {
    const source = readFileSync(resolve(root, path), "utf8");
    for (const dependency of dependencies(source)) {
      expect(dependency.startsWith("."), `${path}: ${dependency}`).toBe(true);
      const target = resolve(root, path, "..", dependency);
      expect(target.startsWith(domainRoot + sep), `${path}: ${dependency}`).toBe(true);
    }
    expect(source).not.toMatch(/\b(?:window|document|process|localStorage|sessionStorage)\b/);
  });

  it.each([
    "packages/desktop/renderer/App.tsx",
    "packages/desktop/renderer/components/AgentWorkspaceHeader.tsx",
    "packages/desktop/renderer/components/AgentWorkspaceSwitcher.tsx",
    "packages/desktop/renderer/components/ChatHeaderActions.tsx",
    "packages/desktop/renderer/components/ChatView.tsx",
    "packages/desktop/renderer/components/HeaderActionMenu.tsx",
    "packages/desktop/renderer/stores/uiStore.ts",
    "packages/desktop/renderer/lib/native-agent-run-prefs.ts",
    "packages/server/app/web/NavigationLayoutSwitcher.tsx",
    "packages/server/app/web/navigation-layout-preference.ts",
    "packages/webapp/src/presentation/web-shell-navigation.ts",
  ])("keeps native processes and protocol implementations out of %s", path => {
    for (const dependency of dependencies(readFileSync(resolve(root, path), "utf8"))) {
      expect(dependency.startsWith("node:") || nodeModules.has(dependency), `${path}: ${dependency}`).toBe(false);
      expect(dependency, path).not.toMatch(/(?:@agent\/native-runtime|native-runtime\/src|agent-runtime\/.*(?:client|adapter))/);
    }
  });

  it.each([
    "qoder-client", "qoder-runtime-adapter", "qoder-session-history", "zcode-client", "zcode-runtime-adapter", "zcode-model-progress",
    "workbuddy-client", "workbuddy-runtime-adapter", "stdio-native-runtime-adapter",
    "native-cli-command", "native-rpc-client", "native-stdio-channel",
  ])("keeps %s behind the native-runtime boundary", name => {
    const path = `packages/native-runtime/src/agent-runtime/${name}.ts`;
    for (const dependency of dependencies(readFileSync(resolve(root, path), "utf8"))) {
      expect(dependency, path).not.toMatch(/(?:^react(?:-dom)?(?:\/|$)|@agent\/(?:desktop|server|webapp)|(?:^|\/)packages\/(?:desktop|server|webapp)(?:\/|$))/);
      if (dependency.startsWith(".")) {
        const target = resolve(root, path, "..", dependency);
        for (const outer of ["desktop", "server", "webapp"]) {
          expect(target.startsWith(resolve(root, "packages", outer) + sep), `${path}: ${dependency}`).toBe(false);
        }
      }
    }
  });
});
