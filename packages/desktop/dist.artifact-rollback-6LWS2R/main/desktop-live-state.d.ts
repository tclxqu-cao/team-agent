export interface DesktopLivePersistedState {
    enabled: boolean;
    /** Selected capture display id; null = primary display. */
    displayId: string | null;
}
export declare function normalizeDesktopLiveState(raw: unknown): DesktopLivePersistedState;
export declare function readDesktopLiveState(path: string): Promise<DesktopLivePersistedState>;
export declare function writeDesktopLiveState(path: string, state: DesktopLivePersistedState): Promise<void>;
//# sourceMappingURL=desktop-live-state.d.ts.map