export class HubPaneLayoutState {
    constructor() {
        this.panes = new Map();
    }
    replace(panes) {
        this.panes = new Map(panes.map((pane) => [pane.siteId, { ...pane }]));
    }
    get(siteId) {
        const pane = this.panes.get(siteId);
        return pane ? { ...pane } : undefined;
    }
    ids() {
        return [...this.panes.keys()];
    }
}
//# sourceMappingURL=pane-layout-state.js.map