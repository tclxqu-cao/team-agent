import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: mermaid }));

describe("renderMermaid", () => {
  const containers: { style: { cssText: string }; remove: ReturnType<typeof vi.fn> }[] = [];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    containers.length = 0;
    vi.stubGlobal("document", {
      createElement: () => {
        const container = { style: { cssText: "" }, remove: vi.fn() };
        containers.push(container);
        return container;
      },
      body: { appendChild: vi.fn() },
    });
    mermaid.render.mockResolvedValue({ svg: "<svg />" });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders with locked safety limits and cleans up its temporary DOM", async () => {
    const { renderMermaid } = await import("./mermaid-renderer");
    expect(await renderMermaid("flowchart TB\nA --> B")).toBe("<svg />");
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      maxTextSize: 50_000,
      maxEdges: 500,
      secure: expect.arrayContaining(["secure", "securityLevel", "maxTextSize", "maxEdges"]),
    }));
    expect(mermaid.render).toHaveBeenCalledWith(expect.stringMatching(/^agentroam-mermaid-/), "flowchart TB\nA --> B", containers[0]);
    expect(containers[0].remove).toHaveBeenCalledOnce();
  });

  it("serializes diagrams and assigns unique IDs", async () => {
    let release: (result: { svg: string }) => void;
    mermaid.render.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const { renderMermaid } = await import("./mermaid-renderer");
    const first = renderMermaid("flowchart TB\nA --> B");
    const second = renderMermaid("sequenceDiagram\nA->>B: hello");
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));
    release!({ svg: "<svg>first</svg>" });
    expect(await first).toBe("<svg>first</svg>");
    await second;
    expect(mermaid.render).toHaveBeenCalledTimes(2);
    expect(mermaid.render.mock.calls[0][0]).not.toBe(mermaid.render.mock.calls[1][0]);
  });

  it("uses locked SVG text labels for image export without changing normal rendering", async () => {
    const { renderMermaid } = await import("./mermaid-renderer");
    await renderMermaid("flowchart TB\nA --> B", true);
    expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      secure: expect.arrayContaining(["htmlLabels", "flowchart"]),
    }));
    await renderMermaid("flowchart TB\nA --> B");
    expect(mermaid.initialize.mock.lastCall?.[0]).not.toHaveProperty("htmlLabels");
  });

  it("cleans up a failed render without poisoning subsequent diagrams", async () => {
    mermaid.render.mockRejectedValueOnce(new Error("invalid diagram"));
    const { renderMermaid } = await import("./mermaid-renderer");
    await expect(renderMermaid("invalid")).rejects.toThrow("invalid diagram");
    expect(containers[0].remove).toHaveBeenCalledOnce();
    await expect(renderMermaid("flowchart TB\nA --> B")).resolves.toBe("<svg />");
    expect(containers[1].remove).toHaveBeenCalledOnce();
  });

  it("rejects oversized input before loading or rendering a diagram", async () => {
    const { renderMermaid } = await import("./mermaid-renderer");
    await expect(renderMermaid("a".repeat(50_001))).rejects.toThrow("源码过长");
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(containers).toHaveLength(0);
  });
});
