import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const desktopDir = dirname(fileURLToPath(import.meta.url));

function readProject(filename: string): ts.ParsedCommandLine {
  const configPath = resolve(desktopDir, filename);
  const source = ts.readConfigFile(configPath, ts.sys.readFile);
  if (source.error) throw new Error(ts.flattenDiagnosticMessageText(source.error.messageText, "\n"));
  const project = ts.parseJsonConfigFileContent(source.config, ts.sys, desktopDir, undefined, configPath);
  if (project.errors.length) {
    throw new Error(project.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
  }
  return project;
}

function outputFiles(project: ts.ParsedCommandLine, source: string): string[] {
  return ts.getOutputFileNames(project, resolve(desktopDir, source), !ts.sys.useCaseSensitiveFileNames)
    .map(filename => resolve(filename));
}

describe("desktop TypeScript project boundaries", () => {
  it("checks main and renderer sources without restricting shared-domain imports to the desktop directory", () => {
    const project = readProject("tsconfig.json");
    expect(project.options.noEmit).toBe(true);
    expect(project.options.rootDir).toBeUndefined();
    const files = project.fileNames.map(filename => resolve(filename));
    expect(files).toContain(resolve(desktopDir, "main/index.ts"));
    expect(files).toContain(resolve(desktopDir, "renderer/App.tsx"));
  });

  it("explicitly enables main-process emission with its existing source root", () => {
    const project = readProject("tsconfig.build.json");
    expect(project.options.noEmit).toBe(false);
    expect(project.options.rootDir && resolve(project.options.rootDir)).toBe(desktopDir);
    expect(project.fileNames.length).toBeGreaterThan(0);
    expect(project.fileNames.every(filename => resolve(filename).startsWith(resolve(desktopDir, "main") + sep))).toBe(true);
    expect(project.fileNames.some(filename => /\.test\.tsx?$/.test(filename))).toBe(false);
  });

  it("preserves the package's Electron entry point and declaration outputs", () => {
    const project = readProject("tsconfig.build.json");
    const packageInfo = JSON.parse(readFileSync(resolve(desktopDir, "package.json"), "utf8")) as { main: string };
    const outputs = outputFiles(project, "main/index.ts");
    expect(outputs).toContain(resolve(desktopDir, packageInfo.main));
    expect(outputs).toContain(resolve(desktopDir, "dist/main/index.d.ts"));
    expect(outputs).toContain(resolve(desktopDir, "dist/main/index.js.map"));
  });

  it.each(["preload", "lite-preload"])("keeps %s in the directory expected by the compile script", name => {
    const main = readProject("tsconfig.build.json");
    const preload = readProject("tsconfig.preload.json");
    const expectedOutput = resolve(desktopDir, `dist/main/${name}.js`);
    expect(outputFiles(main, `main/${name}.ts`)).toContain(expectedOutput);
    expect(outputFiles(preload, `main/${name}.ts`)).toContain(expectedOutput);
    expect(preload.options.noEmit).not.toBe(true);
    expect(preload.options.module).toBe(ts.ModuleKind.CommonJS);
  });
});
