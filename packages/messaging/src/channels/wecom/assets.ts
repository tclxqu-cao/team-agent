import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveWecomAsset(name: "reader.py" | "codec.py" | "native_sender.py" | "NativeAXBridge.swift", assetDir?: string): string {
  const paths: string[] = [];
  if (assetDir) paths.push(join(assetDir, name));
  try {
    const directory = dirname(fileURLToPath(import.meta.url));
    paths.push(resolve(directory, "../assets/wecom", name), join(directory, "assets/wecom", name), resolve(directory, "../../../assets/wecom", name));
  } catch { /* Bundlers may replace import.meta.url with an unavailable build-host path. */ }
  const entry = dirname(resolve(process.argv[1] || "."));
  paths.push(join(entry, "node_modules/@agent/messaging/dist/assets/wecom", name),
    resolve("node_modules/@agent/messaging/dist/assets/wecom", name), resolve("packages/messaging/assets/wecom", name));
  const file = paths.find(existsSync);
  if (!file) throw new Error("消息渠道组件缺失：" + name + "，请重新构建运行包");
  return file;
}
