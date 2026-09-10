import { isAbsolute } from "node:path";

// AI Hub 窗格的会话归属：未导入 Profile 时保持每站点独立分区；
// 完成导入后所有窗格共享同一个导入 Profile（一个浏览器身份，跨站登录态互通）。
export type HubSessionPlan =
  | { kind: "partition"; partition: string }
  | { kind: "shared-imported"; profilePath: string };

export function resolveHubSessionPlan(
  siteId: string,
  importedProfilePath: string | null | undefined,
): HubSessionPlan {
  const profilePath = typeof importedProfilePath === "string" ? importedProfilePath.trim() : "";
  if (profilePath.length > 0 && isAbsolute(profilePath)) {
    return { kind: "shared-imported", profilePath };
  }
  return { kind: "partition", partition: `persist:aihub-${siteId}` };
}
