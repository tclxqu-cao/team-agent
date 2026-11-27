# AgentRoam 自建 HTTPS 接入

每个 AgentRoam 安装实例自动生成本机身份，对同一台中继保留固定公网子域名。手机用系统相机打开电脑显示的 HTTPS 二维码，使用一次性授权进入 AgentRoam。

## 服务器配置

1. 准备一个 HTTPS 域名及其通配子域名，例如 `connect.example.com` 和 `*.connect.example.com`。两者的 DNS 都要指向中继服务器，证书需要包含两个名称。
2. 在本目录用 Node 22.22 或以上运行 `npm ci --omit=dev`。在服务器上以运行服务的用户生成注册私钥，例如执行 `umask 077; openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out relay-private.pem`。在进程管理器中设置 `RELAY_PRIVATE_KEY_FILE` 为该文件的绝对路径，设置 `PUBLIC_ORIGIN=https://connect.example.com`，然后运行 `npm start`。Node 默认仅监听服务器回环的 18082。
3. 用同目录的 Caddyfile 接入 443，提供 `PUBLIC_HOST=connect.example.com`、`TLS_CERTIFICATE` 和 `TLS_PRIVATE_KEY`。反代必须保留 Host 和 WebSocket，并覆盖客户端提供的 `X-Real-IP`。
4. 请求 `https://connect.example.com/health`，应返回 `{"status":"pass"}`。在网络外用开启配对的测试实例验证扫码和实时连接，再分发设置了公网入口的包。

## CLI 和发布

内测可以从电脑直接运行 `agentroam start --relay self-hosted --relay-url https://connect.example.com`。后台服务可在 `agentroam service install` 后传相同的两个选项。

发布包默认使用 `https://connect.kaiwuyouwei.com`。为其他中继打包时可设置 `AGENTROAM_DEFAULT_HTTPS_RELAY=https://connect.example.com`。CLI 和桌面运行包共用 launcher tarball，打包时检查其中的 `dist/self-hosted-relay.json`。每个安装实例的中继身份仅保存在其本地数据目录。

桌面连接中继后会收到公钥和一次性挑战。CLI 用 RSA-OAEP 加密产品标识、安装身份和挑战，中继使用注册私钥解密并校验后分配链接。等待校验的连接计入并发限额。这个握手校验协议格式并拒绝旧握手重放。发布包可公开下载，因此握手不构成客户端来源证明。手机访问仍使用 AgentRoam 的一次性配对授权。
