export interface FileWorkspaceEntry {
  name: string;
  dir: boolean;
  symlink: boolean;
  size: number;
  mtime: number;
}

export interface FileWorkspaceEvent {
  path: string;
  type?: string;
  [key: string]: unknown;
}

export interface FileWorkspaceEventMessage {
  events: FileWorkspaceEvent[];
}

export interface FileWorkspaceReadResult {
  data: string;
  bytes: number;
  offset: number;
  eof: boolean;
  size: number;
}

export type FileWorkspaceDiffStatus = "changed" | "unchanged" | "untracked" | "unavailable";

export interface FileWorkspaceTextStatus {
  tooLarge: boolean;
  size: number;
  mtime: number;
  diffStatus: FileWorkspaceDiffStatus;
}

export interface FileWorkspaceTextInspection extends FileWorkspaceTextStatus {
  data: string | null;
  patch: string | null;
  validUtf8: boolean;
}

export interface FileWorkspacePreviewTicket {
  ticketId: string;
  url: string;
  size: number;
  mtime: number;
  mime: string;
}

export type FileWorkspaceMethod =
  | "hello"
  | "fs:list"
  | "fs:read"
  | "fs:stat"
  | "fs:watch"
  | "fs:unwatch"
  | "fs:inspect-text"
  | "fs:inspect-text-status"
  | "fs:write-text"
  | "fs:preview-open"
  | "fs:preview-close";
