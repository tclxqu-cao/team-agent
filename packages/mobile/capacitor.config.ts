import type { CapacitorConfig } from "@capacitor/cli";

/**
 * AgentRoam 移动壳配置。
 *
 * webDir 指向 packages/webapp 的构建产物：壳内页面由 Capacitor 从
 * capacitor://localhost（iOS）/ https://localhost（Android）静态伺服，
 * 业务数据一律通过 webapp「mobile 服务器连接」模块解析出的远端基址
 * 访问 LAN 里的 AgentRoam 服务端（默认 http://<host>:3000）。
 */
const config: CapacitorConfig = {
  appId: "com.agentroam.mobile",
  appName: "AgentRoam",
  webDir: "../webapp/dist",
  // Native bridge debug output can contain scanner results and secure-store values.
  loggingBehavior: "none",
  android: {
    // WebView 允许混合内容：服务端地址是 LAN 明文 http
    allowMixedContent: true,
  },
  ios: {
    // 本机没有 CocoaPods，iOS 原生依赖走 Swift Package Manager
    packageManager: "SPM",
  },
  server: {
    // 保持离线可用：不用 live-reload，连接地址完全交给连接页管理
    androidScheme: "https",
  },
};

export default config;
