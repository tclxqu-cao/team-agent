import { describe, expect, it } from "vitest";
import { extractMemoryCitations } from "./memory-citations";

const block = "<oai-mem-citation>\n<citation_entries>\nMEMORY.md:12-14|note=[发布经验]\n</citation_entries>\n<rollout_ids>\nabc\n</rollout_ids>\n</oai-mem-citation>";
describe("memory citation display", () => {
  it("hides every streamed metadata prefix without hiding the answer", () => {
    for (let i = 2; i < block.length; i++) {
      expect(extractMemoryCitations(`已发布。\n${block.slice(0, i)}`)).toEqual({ text: "已发布。", citations: [] });
    }
  });
  it("shows complete references and preserves following text", () => {
    expect(extractMemoryCitations(`已发布。\n${block}\n后续正文`)).toEqual({ text: "已发布。\n后续正文", citations: [{ source: "MEMORY.md:12–14", note: "发布经验" }] });
  });
  it("preserves ordinary prose, inline examples, and fenced examples", () => {
    for (const text of ["你好 <oai-mem-c", "`<oai-mem-citation>`", `\`\`\`xml\n${block}\n\`\`\``, `~~~xml\n${block}\n~~~`]) {
      expect(extractMemoryCitations(text)).toEqual({ text, citations: [] });
    }
  });
  it("handles multiple blocks and malformed metadata safely", () => {
    expect(extractMemoryCitations(`${block}\n${block}`).citations).toHaveLength(2);
    expect(extractMemoryCitations("正文\n<oai-mem-citation>bad</oai-mem-citation>")).toEqual({text:"正文", citations:[]});
  });
});
