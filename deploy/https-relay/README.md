# AgentRoam 自建 HTTPS 接入

每个 AgentRoam 安装实例自动生成本机身份，对同一台中继保留固定公网子域名。手机用系统相机打开电脑显示的 HTTPS 二维码，使用一次性授权进入 AgentRoam。

## 服务器配置

1. 准备一个 HTTPS 域名及其通配子域名，例如 `connect.example.com` 和 `*.connect.example.com`。两者的 DNS 都要指向中继服务器，证书需要包含两个名称。
2. 在本目录用 Node 22.22 或以上运行 `npm ci --omit=dev`，然后用进程管理器启动 `PUBLIC_ORIGIN=https://connect.example.com npm start`。Node 默认仅监听服务器回环的 18082。
3. 用同目录的 Caddyfile 接入 443，提供 `PUBLIC_HOST=connect.example.com`、`TLS_CERTIFICATE` 和 `TLS_PRIVATE_KEY`。反代必须保留 Host 和 WebSocket，并覆盖客户端提供的 `X-Real-IP`。
4. 请求 `https://connect.example.com/health`，应返回 `{"status":"pass"}`。在网络外用开启配对的测试实例验证扫码和实时连接，再分发设置了公网入口的包。

## CLI 和发布

内测可以从电脑直接运行 `agentroam start --relay self-hosted --relay-url https://connect.example.com`。后台服务可在 `agentroam service install` 后传相同的两个选项。

在构建 npm 包前设置 `AGENTROAM_DEFAULT_HTTPS_RELAY=https://connect.example.com`。CLI 的构建脚本会把这个公开地址写进发布产物，普通用户启动后自动使用该入口。发包验证应检查 tarball 内 `dist/self-hosted-relay.json` 中的值。每个安装实例的中继身份仅保存在其本地数据目录，和 Headscale 凭据相互独立。

中继通过 HTTPS 提供自动注册，注册期间限制同一来源和总并发安装数。所有公开请求仍使用 AgentRoam 自己的设备授权。
