export interface RuntimeBackgroundJob {
  id: string;
  label: string;
  kind: string;
  scope: "session" | "shared";
  status: "running" | "stopping" | "completed" | "killed" | "failed";
  startedAt: number;
  finishedAt?: number;
  detail?: string;
  outputBytes: number;
  canStop: boolean;
}

export interface RuntimeBackgroundJobOutput {
  job: RuntimeBackgroundJob;
  output: string;
  truncated: boolean;
}

export interface RuntimeBackgroundJobStopResult {
  outcome: "requested" | "already-finished";
}
