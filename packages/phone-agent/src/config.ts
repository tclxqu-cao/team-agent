/** 环境变量配置。所有字段都有默认值，可全部通过 env 覆盖。 */

export interface PhoneAgentConfig {
  /** 驱动选择：auto（有安卓设备用 adb，否则尝试 wda）| adb | wda */
  driver: "auto" | "adb" | "wda";
  /** adb 二进制路径（默认自动探测 PATH → ~/Library/Android/sdk/platform-tools/adb） */
  adbPath: string;
  /** adb -s 序列号（多设备时必填） */
  adbSerial: string;
  /** WebDriverAgent HTTP 地址（iOS） */
  wdaUrl: string;
  /** WDA 路径前缀，老版本 Appium WDA 需要设为 /wd/hub */
  wdaPrefix: string;
  /** 截图等产物目录 */
  artifactsDir: string;
  /** 可选：OpenAI 兼容视觉模型，用于给截图生成文字描述 */
  visionBaseUrl: string;
  visionApiKey: string;
  visionModel: string;
  /** UI 树最多渲染行数 */
  maxTreeLines: number;
  /** UI 树快照有效期（phone_tap index 依赖未过期快照） */
  snapshotTtlMs: number;
  /** 是否放开 phone_shell（adb shell 任意命令，仅限安卓） */
  allowShell: boolean;
  /** agent 服务端（/api/agent/run） */
  agentServerUrl: string;
  /** voice-service WS 地址 */
  voiceServiceUrl: string;
  /** 唤醒词（需与 KWS 模型支持的词一致） */
  wakeWord: string;
  /** 语音会话固定的 sessionId */
  voiceSessionId: string;
  /** TTS 音色 */
  ttsVoice: string;
  /** ffmpeg 采集麦克风设备号（avfoundation，如 ":0"） */
  micDevice: string;
}

function str(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const v = env[key];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const v = Number(env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PhoneAgentConfig {
  return {
    driver: (str(env, "PHONE_DRIVER", "auto") as PhoneAgentConfig["driver"]),
    adbPath: str(env, "PHONE_ADB_PATH", ""),
    adbSerial: str(env, "PHONE_ADB_SERIAL", ""),
    wdaUrl: str(env, "PHONE_WDA_URL", "http://127.0.0.1:8100"),
    wdaPrefix: str(env, "PHONE_WDA_PREFIX", ""),
    artifactsDir: str(env, "PHONE_ARTIFACTS_DIR", ""),
    visionBaseUrl: str(env, "PHONE_VISION_BASEURL", ""),
    visionApiKey: str(env, "PHONE_VISION_APIKEY", ""),
    visionModel: str(env, "PHONE_VISION_MODEL", ""),
    maxTreeLines: num(env, "PHONE_MAX_TREE_LINES", 150),
    snapshotTtlMs: num(env, "PHONE_SNAPSHOT_TTL_MS", 30_000),
    allowShell: str(env, "PHONE_ALLOW_SHELL", "") === "1",
    agentServerUrl: str(env, "AGENT_SERVER_URL", "http://127.0.0.1:3000"),
    voiceServiceUrl: str(env, "VOICE_SERVICE_URL", "ws://127.0.0.1:17863"),
    wakeWord: str(env, "PHONE_VOICE_WAKE_WORD", "小智"),
    voiceSessionId: str(env, "PHONE_VOICE_SESSION", "phone-butler"),
    ttsVoice: str(env, "PHONE_TTS_VOICE", "Serena"),
    micDevice: str(env, "PHONE_MIC", ":0"),
  };
}
