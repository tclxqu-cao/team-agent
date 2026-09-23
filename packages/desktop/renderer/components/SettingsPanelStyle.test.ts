import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const currentDir = dirname(fileURLToPath(import.meta.url));
const component = readFileSync(resolve(currentDir, "SettingsPanel.tsx"), "utf8");
const notice = readFileSync(resolve(currentDir, "AppActionNotice.tsx"), "utf8");

describe("SettingsPanel profile presentation", () => {
  it("keeps run limits and endpoint details out of the collapsed profile row", () => {
    expect(component).not.toContain('className="profile-row-url"');
    expect(component).not.toContain("· 输出 {(p.maxOutputTokens");
    expect(component).toContain("{p.modelId}");
  });

  it("shows a masked placeholder for a stored API key", () => {
    expect(component).toContain('placeholder={hasStoredApiKey ? "••••••••••••" : "sk-..."}');
    expect(component).toContain('aria-label={hasStoredApiKey ? "API 密钥（已保存）" : "API 密钥"}');
  });

  it("uses the shared app action notice after saving a model profile", () => {
    expect(component).toContain('<AppActionNotice message={actionNotice?.message ?? null}');
    expect(component).toContain('message: "模型配置保存成功", type: "success"');
    expect(notice).toContain('className={`app-action-notice is-${type}`}');
  });
});
