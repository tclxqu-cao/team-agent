# @agent/mobile — AgentRoam Android / iOS 壳

用 [Capacitor 7](https://capacitorjs.com) 把 `packages/webapp` 的构建产物包装成
原生 App（Android + iOS）。壳本身没有任何业务逻辑：UI 全部来自 webapp 复用的
`@desktop/renderer`，数据一律通过 HTTP/SSE 访问局域网里运行的 AgentRoam 服务端
（`packages/server`，默认 `:3000`）。

## 架构

```
┌─ Android / iOS 原生壳（本包）───────────────────────────┐
│  WebView 静态伺服 webapp dist（capacitor://localhost）    │
│                                                         │
│  webapp「mobile 服务器连接」DDD 模块                     │
│   ├─ domain/       ServerEndpoint · ConnectionService    │
│   ├─ infrastructure/ Capacitor 环境 / localStorage / 探活 │
│   └─ presentation/ 连接页（输入服务端地址）               │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTP/SSE（CORS 已由 server 放行）
                       ▼
        AgentRoam 服务端 packages/server（LAN :3000）
```

关键点：壳内页面不是从服务端加载的，`/api/*` 相对路径打不到服务端。
webapp 的 `HttpClient` / SSE 基址由「服务器连接」模块在启动时解析：
启动参数 `?server=host:port` > 已保存地址（探活通过）> 连接页手动输入。
浏览器里打开 webapp 时该模块不介入，维持同源行为。

## 常用命令（在本包目录执行）

```bash
bun run sync        # 先构建 webapp，再 cap sync 拷贝产物到 android/ios
bun run open:android
bun run open:ios
bun run build:android:debug    # 产物 android/app/build/outputs/apk/debug/
bun run build:android:release
```

命令行直接打 Android 包（需要 JDK 17+ 与 ANDROID_HOME）：

```bash
cd android
JAVA_HOME=/Library/Java/JavaVirtualMachines/openjdk-17.jdk/Contents/Home \
ANDROID_HOME=$HOME/Library/Android/sdk ./gradlew assembleDebug
```

iOS 依赖 Swift Package Manager（本包已配置，不依赖 CocoaPods）。本机已用
`/Applications/Xcode.app`（26.6）真实构建通过：

```bash
cd ios/App
# SPM 要克隆 github.com/capacitor-swift-pm，直连不通时走本机 Clash 混合端口
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
https_proxy=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 \
xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath build/DerivedData build
```

产物在 `ios/App/build/DerivedData/Build/Products/Debug-iphonesimulator/App.app`，
`simctl install/launch` 已实测：连接页在 iOS 26.5 模拟器正常渲染。真机 IPA 需要
开发者签名后在 Xcode 里 Archive（模拟器构建免签名）。

## 原生工程已做的定制

- Android `AndroidManifest.xml`：`usesCleartextTraffic="true"`，
  允许连 LAN 明文 `http://` 服务端。
- iOS `Info.plist`：`NSAppTransportSecurity → NSAllowsArbitraryLoads`，同上。
- iOS 工程改用 SPM（`CapApp-SPM`），`cap sync` 会自动识别。
- Bundle ID / applicationId：`com.agentroam.mobile`，应用名 `AgentRoam`。

## 注意

- `cap sync` 每次都会用模板覆盖 `App/App/public` 与
  `android/app/src/main/assets/public`，不要手工改这些目录。
- 服务端需在手机可达的网卡上监听；把 `http://<本机局域网IP>:3000`
  填进 App 连接页即可。地址也会持久化到 WebView localStorage。
