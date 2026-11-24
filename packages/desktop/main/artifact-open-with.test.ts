import { describe, expect, it } from "vitest";
import { artifactApplicationCommand, artifactApplicationPicker, artifactOpenChoices } from "./artifact-open-with";

describe("opening an artifact with a selected application", () => {
  it("offers browser selection only for native browser formats", () => {
    expect(artifactOpenChoices(true).map(item => item.choice)).toEqual(["default", "browser", "application"]);
    expect(artifactOpenChoices(false).map(item => item.choice)).toEqual(["default", "application"]);
  });

  it("passes the selected browser and the sandboxed URL as separate arguments", () => {
    const url = "http://127.0.0.1:1234/ticket/图表.html";
    expect(artifactApplicationPicker(true, "darwin").filters).toEqual([{ name: "应用程序", extensions: ["app"] }]);
    expect(artifactApplicationCommand("/Applications/Google Chrome.app", url, "darwin")).toEqual({
      command: "/usr/bin/open", args: ["-a", "/Applications/Google Chrome.app", url],
    });
  });

  it("opens the original file in the selected app and requires a valid application path", () => {
    expect(artifactApplicationCommand("C:\\Program Files\\Editor.exe", "C:\\Work\\file.docx", "win32")).toEqual({
      command: "C:\\Program Files\\Editor.exe", args: ["C:\\Work\\file.docx"],
    });
    expect(artifactApplicationCommand("/usr/share/applications/org.gnome.TextEditor.desktop", "/work/file.txt", "linux")).toEqual({
      command: "gio", args: ["launch", "/usr/share/applications/org.gnome.TextEditor.desktop", "/work/file.txt"],
    });
    expect(() => artifactApplicationCommand("browser.app", "/work/file.pdf", "darwin")).toThrow("请选择有效的应用程序");
  });
});
