import { rmSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getDatabase } from "@agent/core";

const isolated = vi.hoisted(() => {
  const previous = process.env.AGENT_DATA_DIR;
  const directory = `${process.env.TMPDIR || "/tmp"}/agentroam-tool-policy-route-${process.pid}-${crypto.randomUUID()}`;
  process.env.AGENT_DATA_DIR = directory;
  return { directory, previous };
});

import { GET, POST } from "./route";
import { DELETE, PUT } from "./[policyId]/route";

const policy = {
  id: "test-readonly",
  name: "Test read only",
  enabled: true,
  allowedTools: ["read_file"],
  filesystem: { readRoots: [isolated.directory], writeRoots: [], followSymlinks: false },
  commands: { mode: "deny", programs: [], inheritedEnvironment: [] },
  network: "deny",
  limits: { timeoutMs: 5_000, maxOutputBytes: 4_096 },
};

function jsonRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterAll(() => {
  getDatabase(isolated.directory).close();
  rmSync(isolated.directory, { recursive: true, force: true });
  if (isolated.previous === undefined) delete process.env.AGENT_DATA_DIR;
  else process.env.AGENT_DATA_DIR = isolated.previous;
});

describe("tool policy routes", () => {
  it("creates, lists, updates, and deletes a policy", async () => {
    const created = await POST(jsonRequest("http://test/api/tool-policies", "POST", policy));
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({ id: policy.id, enabled: true });

    const listed = await GET();
    await expect(listed.json()).resolves.toMatchObject({
      policies: [expect.objectContaining({ id: policy.id })],
      tools: expect.arrayContaining(["bash", "read_file", "skill_load"]),
    });

    const duplicate = await POST(jsonRequest("http://test/api/tool-policies", "POST", policy));
    expect(duplicate.status).toBe(409);

    const updated = await PUT(
      jsonRequest(`http://test/api/tool-policies/${policy.id}`, "PUT", { ...policy, name: "Updated" }),
      { params: { policyId: policy.id } },
    );
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({ id: policy.id, name: "Updated" });

    const deleted = await DELETE(
      jsonRequest(`http://test/api/tool-policies/${policy.id}`, "DELETE", {}),
      { params: { policyId: policy.id } },
    );
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ deleted: true, policyId: policy.id });
  });

  it("rejects unknown tools when editing an existing policy", async () => {
    await POST(jsonRequest("http://test/api/tool-policies", "POST", policy));
    const response = await PUT(
      jsonRequest(`http://test/api/tool-policies/${policy.id}`, "PUT", {
        ...policy,
        allowedTools: ["unknown_tool"],
      }),
      { params: { policyId: policy.id } },
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_TOOL_POLICY" });
  });
});
