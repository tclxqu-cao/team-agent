let renderQueue: Promise<unknown> = Promise.resolve();
let diagramId = 0;

export function renderMermaid(code: string, forExport = false): Promise<string> {
  const render = renderQueue.then(async () => {
    if (code.length > 50_000) {
      throw new Error("图表源码过长，请查看源码");
    }
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "neutral",
      suppressErrorRendering: true,
      maxTextSize: 50_000,
      maxEdges: 500,
      ...(forExport ? { htmlLabels: false, flowchart: { htmlLabels: false } } : {}),
      secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "suppressErrorRendering", ...(forExport ? ["htmlLabels", "flowchart"] : [])],
    });
    const container = document.createElement("div");
    container.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none";
    document.body.appendChild(container);
    try {
      const { svg } = await mermaid.render(`agentroam-mermaid-${++diagramId}`, code, container);
      return svg;
    } finally {
      container.remove();
    }
  });
  renderQueue = render.catch(() => undefined);
  return render;
}
