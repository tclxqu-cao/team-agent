# AgentRoam 设备组网控制面 · Headscale 部署指南

一台国内云服务器 + 一个域名，为 AgentRoam 提供自托管的 Tailscale 兼容控制面（Headscale）。
部署完成后，桌面端安装 AgentRoam 即自动入网，手机扫码加入同一 tailnet，任意网络下手机 ↔ 桌面互通。

- 控制面版本：headscale **v0.29.7**（锁版本，升级规则见 §7）
- 合规：控制面 / DERP / TURN 全境内部署，仅用于用户自有设备互联；不提供任何跨境信道配置

## 1. 前置条件

| 项 | 要求 |
| --- | --- |
| 服务器 | 国内云轻量/ECS 2核2G 起（99 元/年档足够），Ubuntu 22.04/24.04，已装 Docker + compose 插件 |
| 域名 | 两个**不同** FQDN（同一根域即可）：控制面 `headscale.example.com`、MagicDNS `ts.example.com`，A 记录指向服务器公网 IP |
| 备案 | 大陆服务器 443 端口对未备案域名会被云厂商拦截 → 域名必须完成 ICP 备案（个人备案免费，约 1-2 周） |
| 安全组 | 放行 **443/tcp**、**80/tcp**（仅 ACME HTTP-01）、**3478/udp**（DERP STUN）、**3479/tcp、3479/udp 和 49160-49200/udp**（coturn TURN） |
| 客户端 | 服务器上不登录本 tailnet 的 Tailscale 客户端（官方 FAQ：同机会干扰子网路由/中继/MagicDNS） |

## 2. 配置域名

```bash
# deploy/headscale/ 目录下
cp config.yaml config.yaml.bak
# 编辑 config.yaml：
#   server_url: https://headscale.example.com      ← 控制面域名
#   dns.base_domain: ts.example.com                ← MagicDNS 域（必须与 server_url 域名不同）
# 编辑 caddy/Caddyfile：headscale.example.com 换成你的域名
# 生成 TURN 静态密钥
umask 077
printf 'TURN_SECRET=%s\nTURN_EXTERNAL_IP=%s\n' "$(openssl rand -hex 32)" "<服务器公网 IPv4>" > .env
```

域名解析用「仅 DNS」（不要开 Cloudflare 橙云代理 / Tunnel：官方明确不支持，Cloudflare 不支持 WebSocket POST）。

## 3. 启动

```bash
mkdir -p lib caddy/data caddy/config
docker compose up -d
docker compose ps          # headscale 应为 Up (healthy)
curl -s https://headscale.example.com/health   # {"status":"pass"} 即控制面就绪
```

## 4. 签发 API key（供 AgentRoam 桌面端调用）

```bash
docker compose exec headscale /ko-app/headscale apikeys create --expiration 90d
```

把输出与控制面地址配置到**每台桌面端**（服务进程环境）：

```bash
export AGENT_HEADSCALE_URL=https://headscale.example.com
export AGENT_HEADSCALE_API_KEY=<上一步输出>
```

后台服务方式安装时，在执行 `agentroam service install` 的同一终端先设置两个变量。安装命令把设置写入本机服务数据目录的私有文件，后台进程重启时读取。
API key 90 天过期，建议设日历提醒；泄漏时立即 `apikeys expire` 并重签。

## 5. 验证入网

- 运行 `agentroam mesh status`，核对状态为 `joined`。运行 `agentroam mesh qr` 获取一次性设备凭据。
- 在手机的 Tailscale 客户端使用自定义控制面和认证 key 注册，并启用 Tailscale DNS。入网后，按终端给出的 `agentroam pair --url http://<MagicDNS 地址>` 生成 AgentRoam App 授权二维码。
- 在 App 扫描 AgentRoam 授权二维码后访问桌面服务。可使用控制面 `nodes list` 核对设备身份。

## 6. 用户与 ACL

- 每个 AgentRoam 安装实例使用独立 Headscale 用户。同一实例签发桌面和手机的凭据。
- 默认策略只允许同一用户的设备访问其自己的组网设备的 TCP 80。其他用户的设备与其他端口默认拒绝。

## 7. 升级与备份

- **逐稳定版本升级**（如 0.27→0.28），不可跳级；升级自动执行数据库迁移；关注 0.29.0 两条 BREAKING（`*` 通配符语义收窄、MagicDNS 主机名后缀改数字递增）。
- 升级/备份前**先停容器**（SQLite 开了 WAL，运行中直接 cp 可能不一致）：

```bash
docker compose stop headscale
cp -aR lib ../backup/lib-$(date +%Y%m%d%H%M%S)
docker compose start headscale
# 备选（不停服）：sqlite3 lib/db.sqlite ".backup ../backup/db-$(date +%Y%m%d%H%M%S).sqlite"
```

## 8. 已知边界（均经官方文档/源码核验，日期 2026-11）

- headscale 对 Postgres 官方标注 "highly discouraged" → 保持 SQLite；用户量增长后按实例分片；
- 控制面宕机：既有节点继续互通，仅新设备注册/ACL 变更/MagicDNS 变更不可用；
- 内嵌 DERP 两前提：`server_url` 必须 https、3478/udp 必须公网可达；
- 桌面端 userspace 模式无法绑 100.x → WebRTC 媒体走 coturn TURN 中继（带宽按中继流量计）。

## 9. 合规

仅用于用户自有设备的私有组网互联。不得将控制面 / DERP / TURN 用于构建绕过国家公用电信网国际出入口信道的跨境信道；不得向他人提供 VPN 经营性服务。
