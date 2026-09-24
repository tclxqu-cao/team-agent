import { describe, expect, it } from "vitest";
import { parsePortfolioArtifact, sanitizePortfolioHtml } from "./portfolio-artifact";

describe("portfolio artifacts", () => {
  it("sanitizes active content and keeps approved commands", () => {
    const html = sanitizePortfolioHtml(
      '<section class="artifact unknown" onclick="steal()"><script>alert(1)</script><button class="artifact-flow-step unknown" type="button" data-command="/project agentroam">Open</button><a href="javascript:alert(1)">bad</a></section>',
    );
    expect(html).toContain('class="artifact"');
    expect(html).toContain('class="artifact-flow-step"');
    expect(html).toContain('data-command="/project agentroam"');
    expect(html).not.toContain("unknown");
    expect(html).not.toMatch(/script|onclick|javascript:/i);
  });

  it("keeps safe public links but strips active schemes", () => {
    const html = sanitizePortfolioHtml(
      '<a href="https://github.com/tclxqu-cao">GitHub</a><a href="javascript:alert(1)">bad</a>',
    );
    expect(html).toContain('href="https://github.com/tclxqu-cao"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("javascript:");
  });

  it("preserves semantic project tables", () => {
    const html = sanitizePortfolioHtml(
      "<table><thead><tr><th>Project</th></tr></thead><tbody><tr><td>AgentRoam</td></tr></tbody></table>",
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<thead>");
    expect(html).toContain("<th>Project</th>");
    expect(html).toContain("<td>AgentRoam</td>");
  });

  it("rejects unsafe media URLs", () => {
    expect(() => parsePortfolioArtifact(JSON.stringify({
      schemaVersion: 1,
      skill: "portfolio-works",
      title: "Works",
      blocks: [{ type: "image", src: "//evil.example/work.png", alt: "work" }],
    }), "portfolio-works")).toThrow(/unsafe|unapproved/);
  });

  it("normalizes supported blocks and discards invalid suggestions", () => {
    const artifact = parsePortfolioArtifact(JSON.stringify({
      schemaVersion: 1,
      skill: "portfolio-works",
      title: "Works",
      blocks: [
        { type: "text", text: "Projects", tone: "lead" },
        { type: "image", src: "assets/work.jpg", alt: "work" },
        { type: "video", src: "/assets/work.mp4" },
        { type: "html", html: '<button data-command="/works">Works</button>' },
      ],
      suggestions: ["/works", "/admin", "unsafe"],
      sources: ["projects/agentroam.md", "../private.md", "/absolute.md"],
    }), "portfolio-works");
    expect(artifact.blocks).toHaveLength(4);
    expect(artifact.suggestions).toEqual(["/works"]);
    expect(artifact.sources).toEqual(["projects/agentroam.md"]);
    expect(artifact.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
