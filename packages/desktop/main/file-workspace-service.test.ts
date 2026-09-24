import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopPreviewResponse,
  DesktopFileWorkspaceService,
} from "./file-workspace-service";

const temporaryPaths: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("DesktopFileWorkspaceService", () => {
  it("lists, reads, inspects, and saves files inside an allowed root", async () => {
    const root = await temporaryDirectory("agentroam-files-");
    const nested = join(root, "nested");
    const file = join(root, "note.txt");
    await mkdir(nested);
    await writeFile(file, "before", "utf8");
    const service = new DesktopFileWorkspaceService({ roots: [root], emit: vi.fn() });

    const listing = await service.request("fs:list", { path: root }) as { entries: Array<{ name: string; dir: boolean }> };
    expect(listing.entries.map((entry) => [entry.name, entry.dir])).toEqual([
      ["nested", true],
      ["note.txt", false],
    ]);

    const chunk = await service.request("fs:read", { path: file, offset: 0, length: 3 }) as { data: string; eof: boolean };
    expect(Buffer.from(chunk.data, "base64").toString()).toBe("bef");
    expect(chunk.eof).toBe(false);

    const inspected = await service.request("fs:inspect-text", { path: file }) as { data: string; validUtf8: boolean };
    expect(Buffer.from(inspected.data, "base64").toString()).toBe("before");
    expect(inspected.validUtf8).toBe(true);

    const version = await stat(file);
    await service.request("fs:write-text", {
      path: file,
      content: "after",
      expectedSize: version.size,
      expectedMtime: version.mtimeMs,
    });
    const updated = await service.request("fs:read", { path: file }) as { data: string };
    expect(Buffer.from(updated.data, "base64").toString()).toBe("after");
    service.close();
  });

  it("rejects outside-root paths, traversal, and symlink escapes", async () => {
    const root = await temporaryDirectory("agentroam-root-");
    const outside = await temporaryDirectory("agentroam-outside-");
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "secret", "utf8");
    const link = join(root, "escape.txt");
    await symlink(secret, link);
    const service = new DesktopFileWorkspaceService({ roots: [root], emit: vi.fn() });

    await expect(service.request("fs:read", { path: secret })).rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
    await expect(service.request("fs:read", { path: join(root, "..", outside.split("/").pop()!, "secret.txt") }))
      .rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
    await expect(service.request("fs:read", { path: link })).rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
    const listing = await service.request("fs:list", { path: root }) as { entries: Array<{ name: string }> };
    expect(listing.entries).toEqual([]);
    service.close();
  });

  it("checks optimistic file versions before saving", async () => {
    const root = await temporaryDirectory("agentroam-version-");
    const file = join(root, "note.txt");
    await writeFile(file, "current", "utf8");
    const service = new DesktopFileWorkspaceService({ roots: [root], emit: vi.fn() });

    await expect(service.request("fs:write-text", {
      path: file,
      content: "overwrite",
      expectedSize: 1,
      expectedMtime: 1,
    })).rejects.toMatchObject({ code: "EFILECHANGED" });
    service.close();
  });

  it("issues, serves, revokes, and expires preview tickets", async () => {
    const root = await temporaryDirectory("agentroam-preview-");
    const markdown = join(root, "README.md");
    const binary = join(root, "data.bin");
    await writeFile(markdown, "# Preview\n\nBody", "utf8");
    await writeFile(binary, Buffer.from("0123456789"));
    let now = 100;
    let token = 0;
    const service = new DesktopFileWorkspaceService({
      roots: [root],
      emit: vi.fn(),
      now: () => now,
      token: () => `ticket-${++token}`,
      ticketTtlMs: 50,
    });

    const markdownTicket = await service.request("fs:preview-open", { path: markdown }) as { ticketId: string; url: string };
    const markdownResponse = await createDesktopPreviewResponse(service, new Request(`${markdownTicket.url}/README.md`));
    expect(markdownResponse.status).toBe(200);
    expect(await markdownResponse.text()).toContain("<h1>Preview</h1>");
    expect(markdownResponse.headers.get("content-security-policy")).toContain("sandbox");

    const binaryTicket = await service.request("fs:preview-open", { path: binary }) as { ticketId: string; url: string };
    const rangeResponse = await createDesktopPreviewResponse(service, new Request(binaryTicket.url, { headers: { range: "bytes=2-5" } }));
    expect(rangeResponse.status).toBe(206);
    expect(Buffer.from(await rangeResponse.arrayBuffer()).toString()).toBe("2345");

    await service.request("fs:preview-close", { ticketId: binaryTicket.ticketId });
    expect(service.resolvePreviewTicket(binaryTicket.ticketId)).toBeNull();
    now = 151;
    expect(service.resolvePreviewTicket(markdownTicket.ticketId)).toBeNull();
    service.close();
  });

  it("deduplicates and removes filesystem watchers", async () => {
    const root = await temporaryDirectory("agentroam-watch-");
    const emit = vi.fn();
    const service = new DesktopFileWorkspaceService({ roots: [root], emit });

    await service.request("fs:watch", { path: root });
    await service.request("fs:watch", { path: root });
    await service.request("fs:unwatch", { path: root });
    service.close();

    expect(emit).not.toHaveBeenCalled();
  });
});
