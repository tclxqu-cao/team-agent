import { isAbsolute } from "node:path";
export function resolveHubSessionPlan(siteId, importedProfilePath) {
    const profilePath = typeof importedProfilePath === "string" ? importedProfilePath.trim() : "";
    if (profilePath.length > 0 && isAbsolute(profilePath)) {
        return { kind: "shared-imported", profilePath };
    }
    return { kind: "partition", partition: `persist:aihub-${siteId}` };
}
//# sourceMappingURL=session-choice.js.map