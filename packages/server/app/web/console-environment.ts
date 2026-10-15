/** Native apps reuse this console with local frames and a remote authenticated gateway. */
export interface NativeConsoleEnvironment {
  origin: string;
  frameUrl(path: string): string;
  pair(raw: string): Promise<void>;
  scan(): Promise<void>;
  switchComputer(origin: string): Promise<void>;
}

let nativeEnvironment: NativeConsoleEnvironment | null = null;
export function configureNativeConsole(environment: NativeConsoleEnvironment): void { nativeEnvironment = environment; }
export function nativeConsole(): NativeConsoleEnvironment | null { return nativeEnvironment; }
export function consoleOrigin(): string { return nativeEnvironment?.origin ?? location.origin; }
export function consoleFrameUrl(path: string): string { return nativeEnvironment?.frameUrl(path) ?? path; }
export function consoleResourceUrl(path: string): string { return nativeEnvironment ? new URL(path, nativeEnvironment.origin).href : path; }
export function consoleWebSocketUrl(): string {
  const url = new URL("/ws", consoleOrigin());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
