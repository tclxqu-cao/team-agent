import { describe, expect, it } from "vitest";
import { followUpFromReply } from "./composer-prediction";

describe("follow-up from the completed reply", () => {
  it("uses the stated next step and leaves extra context out of the draft", () => {
    expect(followUpFromReply("本地构建已通过。\n\n**首次需要发布一版带在线更新功能的客户端。** 从这版开始就能检查更新。"))
      .toBe("请发布一版带在线更新功能的客户端。");
    expect(followUpFromReply("Next step: verify version 1.2.3 on Android. Build checks passed."))
      .toBe("Verify version 1.2.3 on Android.");
  });

  it("leaves the draft empty when the reply has no next step", () => {
    expect(followUpFromReply("修改完成，测试通过。")).toBeNull();
    expect(followUpFromReply("示例\n```text\n下一步删除目录。\n```")).toBeNull();
  });
});
