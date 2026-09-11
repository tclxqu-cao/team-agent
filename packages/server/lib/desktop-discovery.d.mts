import type { IncomingMessage, ServerResponse } from "node:http";
export function createDesktopDiscovery(options: { dataDir: string; directory?: string }): {
  publish(port: number): Promise<void>;
  handle(request: IncomingMessage, response: ServerResponse): boolean;
  close(): Promise<void>;
};
