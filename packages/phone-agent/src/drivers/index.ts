import type { PhoneAgentConfig } from "../config.js";
import { AdbDriver } from "./adb.js";
import { WdaDriver } from "./wda.js";
import type { PhoneDriver } from "./types.js";

export interface DriverProbe {
  driver: PhoneDriver;
  status: { ok: boolean; detail: string };
}

async function probe(driver: PhoneDriver): Promise<DriverProbe> {
  const status = await driver.status();
  return { driver, status };
}

/**
 * 按配置挑选可用驱动：
 * - PHONE_DRIVER=adb / wda：直接用指定驱动（哪怕 status 不 ok，让工具返回错误更可诊断）
 * - auto：先探测 adb（设备就绪），再探测 wda；都不可用时选 adb，
 *   这样 phone_status 会给出针对性的安装提示。
 */
export async function createDriver(config: PhoneAgentConfig): Promise<DriverProbe> {
  if (config.driver === "adb") {
    return probe(new AdbDriver({ adbPath: config.adbPath, serial: config.adbSerial }));
  }
  if (config.driver === "wda") {
    return probe(new WdaDriver({ baseUrl: config.wdaUrl, prefix: config.wdaPrefix }));
  }
  const adb = await probe(new AdbDriver({ adbPath: config.adbPath, serial: config.adbSerial }));
  if (adb.status.ok) return adb;
  const wda = await probe(new WdaDriver({ baseUrl: config.wdaUrl, prefix: config.wdaPrefix }));
  if (wda.status.ok) return wda;
  return adb;
}
