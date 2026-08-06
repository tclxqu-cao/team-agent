import { describe, expect, it } from "vitest";
import * as agentHostModule from "./agent-host";

const shouldInterruptPreviousRun = (agentHostModule as unknown as {
  shouldInterruptPreviousRun?: (runCountIncludingCurrent: number) => boolean;
}).shouldInterruptPreviousRun;

describe("shouldInterruptPreviousRun", () => {
  it("does not interrupt the first IPC run counted as active", () => {
    expect(typeof shouldInterruptPreviousRun).toBe("function");
    expect(shouldInterruptPreviousRun?.(1)).toBe(false);
  });

  it("interrupts when another IPC run was already active", () => {
    expect(shouldInterruptPreviousRun?.(2)).toBe(true);
  });
});
