export interface HubPaneRect {
    siteId: string;
    conversationId?: string;
    x: number;
    y: number;
    width: number;
    height: number;
}
export declare class HubPaneLayoutState {
    private panes;
    replace(panes: HubPaneRect[]): void;
    get(siteId: string): HubPaneRect | undefined;
    ids(): string[];
}
//# sourceMappingURL=pane-layout-state.d.ts.map