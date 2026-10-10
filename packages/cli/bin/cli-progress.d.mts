export interface CliProgressOptions {
  enabled?: boolean;
  environment?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  delayMs?: number;
  intervalMs?: number;
}
export function withCliProgress<T>(label: string, operation: () => T | Promise<T>, options?: CliProgressOptions): Promise<T>;
export function withoutCliProgress<T>(operation: () => T | Promise<T>): Promise<T>;
