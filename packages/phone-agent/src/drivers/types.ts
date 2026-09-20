/** 驱动层抽象：同一套接口适配 Android(adb) 与 iOS(WebDriverAgent)。 */

export interface ScreenSize {
  width: number;
  height: number;
}

export interface AppEntry {
  /** Android 包名 / iOS bundle id */
  id: string;
  /** 展示名（来自 apps.json 映射，可能为空） */
  name: string;
}

export type PressKey = "back" | "home" | "enter" | "recent";

export interface DriverStatus {
  ok: boolean;
  /** 人类可读状态（设备型号 / 错误原因） */
  detail: string;
}

export interface PhoneDriver {
  readonly kind: "adb" | "wda";

  status(): Promise<DriverStatus>;
  screenSize(): Promise<ScreenSize>;
  /** 返回 PNG 字节 */
  screenshot(): Promise<Uint8Array>;
  /** 无障碍树原始 XML（Android: uiautomator dump；iOS: WDA /source） */
  uiTreeXml(): Promise<string>;
  tap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>;
  /** 向当前聚焦输入框输入文本。Android v1 仅支持 ASCII（见 README 限制）。 */
  inputText(text: string): Promise<void>;
  pressKey(key: PressKey): Promise<void>;
  launchApp(appId: string): Promise<void>;
  listApps(): Promise<AppEntry[]>;
  currentApp(): Promise<string>;
}
