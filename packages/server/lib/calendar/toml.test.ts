import { describe, expect, it } from "vitest";
import { parseTomlSubset } from "./toml";

describe("parseTomlSubset", () => {
  it("parses the Codex automation.toml shape", () => {
    const toml = parseTomlSubset([
      'id = "wiki-raw"',
      'name = "Wiki 整理"',
      'status = "ACTIVE"',
      'created_at = 1761000000000',
      'rrule = "RRULE:FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0;BYDAY=MO"',
      "cwds = [",
      '  "/Users/a/wiki",',
      '  "/Users/a/notes",',
      "]",
      'prompt = "第一行\\n第二行"',
      "enabled = true",
    ].join("\n"));
    expect(toml.id).toBe("wiki-raw");
    expect(toml.status).toBe("ACTIVE");
    expect(toml.created_at).toBe(1761000000000);
    expect(toml.cwds).toEqual(["/Users/a/wiki", "/Users/a/notes"]);
    expect(toml.prompt).toBe("第一行\n第二行");
    expect(toml.enabled).toBe(true);
  });

  it("strips comments outside strings and keeps # inside strings", () => {
    const toml = parseTomlSubset('name = "a # b" # trailing comment\nvalue = 3');
    expect(toml.name).toBe("a # b");
    expect(toml.value).toBe(3);
  });

  it("parses multi-line basic strings", () => {
    const toml = parseTomlSubset('prompt = """\nline one\nline two\n"""');
    expect(String(toml.prompt).trim()).toBe("line one\nline two");
  });

  it("skips unknown lines without throwing", () => {
    const toml = parseTomlSubset("[section]\nunknown line\nkey = 1");
    expect(toml.key).toBe(1);
  });
});