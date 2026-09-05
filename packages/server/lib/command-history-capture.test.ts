import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const wsServerSource = readFileSync(new URL("../ws-server.mjs", import.meta.url), "utf8");
const shellIntegrationSource = readFileSync(new URL("../shell-integration.mjs", import.meta.url), "utf8");

describe("shell command history capture contract", () => {
  it("reports commands from precmd together with their exit status", () => {
    expect(shellIntegrationSource).toContain("precmd_functions=(__ca_hist_precmd $precmd_functions)");
    expect(shellIntegrationSource).toContain("preexec_functions=(__ca_hist_preexec $preexec_functions)");
    expect(shellIntegrationSource).toContain('function __ca_hist_precmd(){ local e=$?; if [[ -n "\\${__ca_hist_cmd+x}" ]]; then');
    expect(shellIntegrationSource).toContain(String.raw`printf '\\033]633;C;%s;%s;%s\\007' "$c" "$d" "$e"`);
    expect(shellIntegrationSource).toContain("unset __ca_hist_cmd");
  });

  it("parses the exit code field and stores it with the command", () => {
    const capture = wsServerSource.slice(
      wsServerSource.indexOf("function captureShellHistory"),
      wsServerSource.indexOf("const cwdRegex"),
    );
    expect(capture).toContain(String.raw`/\x1b]633;C;([^;\x07]+);([^;\x07]+)(?:;(\d+))?\x07/g`);
    expect(capture).toContain("match[3] !== undefined ? Number(match[3]) : null");
    expect(capture).toContain("addHistory(session.userId, session.id, command, cwd, new Date().toISOString(), exitCode)");
  });
});
