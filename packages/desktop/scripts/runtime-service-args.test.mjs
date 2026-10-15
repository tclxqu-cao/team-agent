import { expect, it } from "vitest";
import { parseArgs } from "../../cli/src/args.ts";
import { runtimeServiceArguments } from "./runtime-service-args.mjs";

it("uses valid CLI arguments for a new registration and an existing service", () => {
  const fresh = runtimeServiceArguments("/cli.mjs", "/data", "/workspace", false);
  expect(parseArgs(fresh.slice(1))).toMatchObject({ command: "service", serviceAction: "install", dataDir: "/data", roots: ["/workspace"], qr: false });
  const existing = runtimeServiceArguments("/cli.mjs", "/data", "/workspace", true);
  expect(existing).toEqual(["/cli.mjs", "service", "start"]);
  expect(parseArgs(existing.slice(1))).toMatchObject({ command: "service", serviceAction: "start" });
});
