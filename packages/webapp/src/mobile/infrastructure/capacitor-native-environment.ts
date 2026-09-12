import type { NativeEnvironmentPort } from "../domain/ports";

/** Capacitor 运行时注入的最小全局面，只声明我们消费的字段。 */
interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

function capacitorGlobal(): CapacitorGlobal | null {
  return (window as { Capacitor?: CapacitorGlobal }).Capacitor ?? null;
}

/**
 * Capacitor 壳适配器：通过 window.Capacitor 判断原生环境，
 * 启动参数支持 ?server=host:port（深链/扫码冷启动直接指到目标服务端）。
 */
export class CapacitorNativeEnvironment implements NativeEnvironmentPort {
  isNativeApp(): boolean {
    return capacitorGlobal()?.isNativePlatform?.() ?? false;
  }

  platform(): "ios" | "android" | "web" {
    const platform = capacitorGlobal()?.getPlatform?.();
    return platform === "ios" || platform === "android" ? platform : "web";
  }

  launchServerUrl(): string | null {
    const raw = new URLSearchParams(window.location.search).get("server");
    return raw && raw.trim() ? raw.trim() : null;
  }
}
