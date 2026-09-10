export interface HubPaneRect {
  siteId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export class HubPaneLayoutState {
  private panes = new Map<string, HubPaneRect>();

  replace(panes: HubPaneRect[]): void {
    this.panes = new Map(panes.map((pane) => [pane.siteId, { ...pane }]));
  }

  get(siteId: string): HubPaneRect | undefined {
    const pane = this.panes.get(siteId);
    return pane ? { ...pane } : undefined;
  }

  ids(): string[] {
    return [...this.panes.keys()];
  }
}
