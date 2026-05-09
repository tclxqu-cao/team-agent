// ── Upload Domain ──

export type UploadStatus = "pending" | "uploading" | "completed" | "failed";

export interface UploadEntry {
  id: string;
  fileName: string;
  filePath: string;
  mimeType: string;
  size: number;
  status: UploadStatus;
  error?: string;
  metadata?: Record<string, unknown>;
  created: string;
  updated: string;
}

export interface IUploadStore {
  get(id: string): Promise<UploadEntry | null>;
  save(entry: UploadEntry): Promise<void>;
  delete(id: string): Promise<void>;
  list(): Promise<UploadEntry[]>;
  updateStatus(id: string, status: UploadStatus, error?: string): Promise<void>;
}
