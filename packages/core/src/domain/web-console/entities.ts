export type TerminalTabStatus = "active" | "detached" | "exited" | "closed";
export interface TerminalTabRecord { id: string; userId: string; title: string; shell: string; startCwd: string; currentCwd: string; status: TerminalTabStatus; sortOrder: number; createdAt: string; lastActiveAt: string; exitedAt: string | null; closedAt: string | null }
export interface ControlPosition { xRatio: number; yRatio: number; anchor: "left" | "right" | "top" | "bottom" }
export interface PinnedCommand { id: string; command: string }
export interface UserPreferences { userId: string; revision: number; theme: string; terminalFontSize: number; fileButtonPosition: ControlPosition; keybarPosition: ControlPosition; keybarHidden: boolean; keyOrder: string[]; pinnedCommands: PinnedCommand[]; updatedAt: string }
export interface DeviceState { userId: string; deviceId: string; activeTerminalId: string | null; drawerOpen: boolean; drawerTab: "files" | "history"; fileTreeRoot: string | null; fileTreeFollowMode: boolean; expandedPaths: string[]; selectedFile: string | null; terminalScroll: Record<string, number>; updatedAt: string }
export interface CommandHistoryRecord { id: number; userId: string; terminalId: string; command: string; cwd: string; executedAt: string; exitCode: number | null }
