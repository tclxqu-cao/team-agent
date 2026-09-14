import type { IncomingMessage, ServerResponse } from "node:http";
export function createDesktopDiscovery(options: { dataDir: string; directory?: string }): {
  authenticate(request: IncomingMessage): boolean;
  headers(): Record<string, string>;
  publish(port: number): Promise<void>;
  handle(request: IncomingMessage, response: ServerResponse): boolean;
  close(): Promise<void>;
};
