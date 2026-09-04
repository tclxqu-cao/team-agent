# AgentRoam 固定公网隧道：自建 frp + 香港轻量服务器 + 免费域名

把 Mac 上的 AgentRoam（`127.0.0.1:3000`）暴露为固定的 `https://<名字>.duckdns.org`，
手机/他人随时访问。不需要买域名，不需要备案。

```
手机浏览器 ──HTTPS 443──▶ 香港轻量服务器 [Caddy(自动证书) → frps(127.0.0.1:13000)]
                                                    │ frp 隧道(TLS, 7000端口, 自动重连)
             Mac [frpc(launchd常驻) → 127.0.0.1:3000 AgentRoam]
```

## 费用

| 项目 | 费用 |
| :--- | :--- |
| 腾讯云轻量服务器（香港） | 活动价 ¥99/年（2核2G，30M 带宽）或常规 ~¥32-40/月 |
| DuckDNS 子域名 | 免费 |
| frp / Caddy / 证书 | 开源免费，证书自动续期 |

## 步骤

### 1. 买服务器（腾讯云轻量 · 香港）

1. 打开 [cloud.tencent.com](https://cloud.tencent.com/) → 产品 → **轻量应用服务器 Lighthouse** → 购买。
2. 地域选 **中国香港**（免备案；选大陆节点则域名必须备案，别选）。
3. 镜像选 **Ubuntu Server 24.04 LTS**。套餐：新用户搜「轻量 99元/年」活动机；没有就选 2核2G 常规款（30M 带宽够 Web UI 用，追求速度选锐驰型 200M）。需实名认证。
4. 买完在控制台 → 防火墙，放行 TCP 端口：**80、443、7000**（22 默认已开）。
5. 重置 root 密码（或绑定 SSH 密钥），记下**公网 IP**。

### 2. 注册免费域名（DuckDNS，约 2 分钟）

1. 打开 [duckdns.org](https://www.duckdns.org/)，用 GitHub/Google 账号登录（打不开就先开 Clash 全局）。
2. 输入一个名字（如 `caoquagent`）→ add domain，得到 `caoquagent.duckdns.org`。
3. 在该条目的 ip 处填**服务器公网 IP**（轻量服务器是固定 IP，填一次即可，无需动态更新客户端）。

### 3. 服务器安装 frps + Caddy（一条命令）

把本仓库的服务器脚本传上去执行（在仓库根目录）：

```bash
scp deploy/frp/server/bootstrap-server.sh root@<服务器IP>:/root/
ssh root@<服务器IP>
DOMAIN=caoquagent.duckdns.org bash bootstrap-server.sh   # 在服务器上执行
```

脚本做的事：下载 frps → 写配置（数据面只绑 127.0.0.1，控制面强制 TLS+token）→ systemd 常驻 →
装 Caddy 并为你的 DuckDNS 域名自动签发/续期 Let's Encrypt 证书 → 反代 443 → frp。
执行结束会打印 **TOKEN**，记下来。

### 4. Mac 安装 frpc + 常驻（一条命令）

```bash
bash deploy/frp/mac/install-frpc.sh <服务器IP> <上一步的TOKEN>
```

脚本做的事：下载 frpc（直连 GitHub 失败自动走 Clash `127.0.0.1:7897`）→ 写
`~/.agentroam-frp/frpc.toml`（把本机 :3000 映射到服务器 127.0.0.1:13000）→
装 launchd 服务 `com.agentroam.frpc`：开机自启、崩溃/断线自动拉起，日志在 `~/Library/Logs/frpc.log`。

### 5. 验证

```bash
curl -I https://caoquagent.duckdns.org      # 期望 200/30x，证书有效
tail -f ~/Library/Logs/frpc.log             # Mac 端看到 "login to server success"
```

浏览器和手机分别打开 `https://caoquagent.duckdns.org`，登录 AgentRoam 并发一条消息确认 `wss` 正常。

## 维护

- 平时**无需维护**：两端都是崩溃/断线自动重连 + 开机自启；证书 90 天自动续。
- frps 面板（连接数/流量）：`ssh -L 7500:127.0.0.1:7500 root@<IP>` → 本机开 `http://127.0.0.1:7500`。
- 升级 frp：重跑两边的脚本，改 `FRP_VERSION=vX.Y.Z` 即可。
- 卸载 Mac 端：`launchctl bootout gui/$(id -u)/com.agentroam.frpc && rm -rf ~/.agentroam-frp ~/Library/LaunchAgents/com.agentroam.frpc.plist`。

## 排错

| 现象 | 处理 |
| :--- | :--- |
| 证书签发失败 | 检查控制台防火墙 80/443 是否放行；`journalctl -u caddy -f` 看原因 |
| 打不开但 Mac 日志显示在线 | 服务器 `curl -I http://127.0.0.1:13000` 确认数据面通；再看 Caddy 日志 |
| AgentRoam 返回 403/Origin 校验失败 | web 网关有 Origin 校验，需把 `https://<域名>` 加入允许列表（见 `packages/core/src/domain/web-console/WebArtifactBridge.ts`） |
| DuckDNS 登录不上 | 先开 Clash 全局再登录；登录成功后可关 |
| 30M 带宽首屏慢 | 升级锐驰型（200Mbps 无限流量，~¥40/月） |
