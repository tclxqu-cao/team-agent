import { describe, expect, it, vi } from "vitest";

vi.mock("./shared-settings", () => ({
  sharedSettings: () => ({
    read: () => ({ workingDirectory: "/tmp/customer-agent-empty-skills" }),
  }),
}));

import { BusinessCatalog } from "./business-catalog";

describe("BusinessCatalog built-in Skills", () => {
  it("lists computer-use independently of the configured working directory", async () => {
    const catalog = Object.create(BusinessCatalog.prototype) as BusinessCatalog;
    Object.defineProperty(catalog, "skills", {
      value: { listAll: vi.fn(async () => []) },
    });

    const skills = await catalog.call("listSkills", []) as Array<{
      name: string;
      enabled?: boolean;
      filePath: string;
    }>;

    expect(skills.find((skill) => skill.name === "computer-use")).toMatchObject({
      name: "computer-use",
      enabled: true,
      filePath: "builtin://customer-agent/computer-use",
    });
  });
});
