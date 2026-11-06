import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("The local WeCom sender requires macOS");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = resolve(root, "packages/messaging/assets/wecom/NativeAXBridge.swift");
const output = resolve(root, "packages/server/native/WeComSendBridge.app");
await mkdir(resolve(output, "Contents/MacOS"), { recursive: true });
await mkdir(resolve(output, "Contents/Resources"), { recursive: true });
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>AgentRoam 企微发送桥</string>
<key>CFBundleName</key><string>AgentRoam 企微发送桥</string>
<key>CFBundleIdentifier</key><string>com.agentroam.wecom-send-bridge</string>
<key>CFBundleExecutable</key><string>NativeAXBridge</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.2.0</string>
<key>CFBundleVersion</key><string>2</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
</dict></plist>
`;
await writeFile(resolve(output, "Contents/Info.plist"), plist);
execFileSync("/usr/bin/swiftc", ["-swift-version", "5", "-framework", "AppKit", "-framework", "ApplicationServices", source,
  "-o", resolve(output, "Contents/MacOS/NativeAXBridge")], { stdio: "inherit" });
const sha256 = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
await writeFile(resolve(output, "Contents/Resources/agentroam-component.json"), JSON.stringify({ version: 2, sourceSha256: await sha256(source) }, null, 2) + "\n");
execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "com.agentroam.wecom-send-bridge", output], { stdio: "inherit" });
if (process.argv.includes("--install")) {
  const installed = resolve(homedir(), "Library/Application Support/AgentRoam/wecom-sender/WeComSendBridge.app");
  let same = false;
  try { same = await sha256(resolve(installed, "Contents/MacOS/NativeAXBridge")) === await sha256(resolve(output, "Contents/MacOS/NativeAXBridge")); } catch { /* First installation. */ }
  if (!same) {
    await rm(installed, { recursive: true, force: true });
    await cp(output, installed, { recursive: true });
    console.log("Installed. Enable AgentRoam 企微发送桥 in macOS Privacy & Security → Accessibility. An updated ad-hoc signed helper may need its permission toggled again.");
  } else console.log("Installed helper is unchanged; preserved its existing accessibility permission.");
  execFileSync("/usr/bin/open", ["-n", "-W", installed, "--args", "--request-permission"], { stdio: "inherit" });
}
console.log(output);
