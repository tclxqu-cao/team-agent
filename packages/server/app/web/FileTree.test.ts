import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tree = readFileSync(
  new URL("../../../desktop/renderer/components/file-workspace/FileTree.tsx", import.meta.url),
  "utf8",
);

describe("FileTree file type icons", () => {
  it("uses the shared classifier and Lucide icons for directories and files", () => {
    expect(tree).toContain("classifyFileContent");
    expect(tree).toContain("FolderOpen");
    expect(tree).toContain("FileCode2");
    expect(tree).toContain("FileImage");
    expect(tree).toContain("FileVideo2");
    expect(tree).not.toContain("📁");
    expect(tree).not.toContain("📂");
  });

  it("reveals repeated artifact requests and exposes stable file row paths", () => {
    expect(tree).toContain("revealRequest?: FileTreeRevealRequest | null");
    expect(tree).toContain("revealRequest?.requestId");
    expect(tree).toContain("startedRevealRequestRef.current === revealRequest.requestId");
    expect(tree).toContain("latestRevealRequestRef.current !== requestId");
    expect(tree).toContain("ancestorDirectories(revealRoot, targetPath)");
    expect(tree).toContain("await openDirAtDepth(ancestors[depth], depth)");
    expect(tree).toContain("data-tree-path={full}");
    expect(tree).toContain('scrollIntoView({ block: "center", inline: "nearest" })');
  });

  it("surfaces directory access failures instead of rendering an empty tree", () => {
    expect(tree).toContain('className="tree-error" role="alert"');
    expect(tree).toContain("rootSt.error");
    expect(tree).toContain("st!.error");
  });
});
