import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactBrowserPreview } from "./artifact-browser-preview";
import { DesktopFileWorkspaceService } from "./file-workspace-service";

describe("desktop artifact browser preview", () => {
  let root: string;
  let project: string;
  let workspace: DesktopFileWorkspaceService;
  let preview: ArtifactBrowserPreview;
  let now: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agentroam-artifact-"));
    project = join(root, "project");
    await mkdir(project);
    now = 0;
    workspace = new DesktopFileWorkspaceService({ roots: [root], emit: () => {}, now: () => now, ticketTtlMs: 100 });
    preview = new ArtifactBrowserPreview(workspace);
  });

  afterEach(async () => {
    preview.close();
    workspace.close();
    await rm(root, { recursive: true, force: true });
  });

  async function openArtifact(name: string, content: string): Promise<URL> {
    const file = join(project, name);
    await writeFile(file, content);
    let destination = "";
    await preview.open(file, async url => { destination = url; });
    return new URL(destination);
  }

  it("opens HTML on loopback with scoped local assets and an expiring ticket", async () => {
    const html = '<link rel="stylesheet" href="chart.css"><h1>Architecture</h1>';
    const url = await openArtifact("图表 1.html", html);
    const css = "h1 { color: red }";
    await writeFile(join(project, "chart.css"), css);
    await writeFile(join(root, "outside.css"), css);
    await symlink(join(root, "outside.css"), join(project, "linked.css"));
    await writeFile(join(project, "other.html"), html);

    expect(url.hostname).toBe("127.0.0.1");
    expect(decodeURIComponent(url.pathname)).toMatch(/\/图表 1\.html$/);
    const response = await fetch(url);
    expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe(html);
    expect(await (await fetch(new URL("chart.css", url))).text()).toBe(css);
    for (const relative of ["missing.css", "linked.css", "../outside.css", "other.html"]) {
      expect((await fetch(new URL(relative, url))).status).toBe(404);
    }
    now = 101;
    expect((await fetch(url)).status).toBe(404);
  });

  it("serves browser-native MIME types and PDF ranges without reading adjacent files", async () => {
    const png = await openArtifact("chart.png", "png fixture");
    expect((await fetch(png, { method: "HEAD" })).headers.get("content-type")).toBe("image/png");
    const svg = await openArtifact("chart.svg", "<svg/>");
    expect((await fetch(svg, { method: "HEAD" })).headers.get("content-security-policy")).toContain("sandbox;");
    const pdf = await openArtifact("report.pdf", "%PDF-1.7");
    const response = await fetch(pdf, { headers: { range: "bytes=0-3" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-range")).toBe("bytes 0-3/8");
    expect(await response.text()).toBe("%PDF");
    expect((await fetch(new URL("chart.png", pdf))).status).toBe(404);
    await expect(preview.open(join(project, "archive.zip"), async () => {})).rejects.toThrow("不支持浏览器预览");
  });
});
