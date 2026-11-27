export type HubSessionPlan = {
    kind: "partition";
    partition: string;
} | {
    kind: "shared-imported";
    profilePath: string;
};
export declare function resolveHubSessionPlan(siteId: string, importedProfilePath: string | null | undefined): HubSessionPlan;
//# sourceMappingURL=session-choice.d.ts.map