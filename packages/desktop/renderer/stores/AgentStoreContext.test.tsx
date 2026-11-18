import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createAgentStore } from "./agentStore";
import { AgentStoreProvider, useScopedAgentStore } from "./AgentStoreContext";

function ObservedTask() {
  const running = useScopedAgentStore(state => state.runningSessionId);
  return createElement("span", null, running);
}

describe("nested desktop task store scope", () => {
  it("lets sibling tool cards observe their own task while other callers keep the original store", () => {
    // Seed the initial SSR snapshots instead of mutating them after creation.
    const left = createAgentStore({ runningSessionId: "left-run" });
    const right = createAgentStore({ runningSessionId: "right-run" });
    const markup = renderToStaticMarkup(createElement("div", null,
      createElement(AgentStoreProvider, { store: left, children: createElement(ObservedTask) }),
      createElement(AgentStoreProvider, { store: right, children: createElement(ObservedTask) }),
      createElement(ObservedTask)));
    expect(markup).toBe("<div><span>left-run</span><span>right-run</span><span></span></div>");
  });
});
