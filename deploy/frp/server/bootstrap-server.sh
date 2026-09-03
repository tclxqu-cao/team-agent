#!/usr/bin/env bash
# frp 服务端一键安装：frps + Caddy（自动 HTTPS + WebSocket 反代）
# 适用：Ubuntu 22.04 / 24.04（腾讯云轻量香港默认镜像即可）
#
# 用法（在服务器上以 root 运行）:
#   sudo DOMAIN=xxx.duckdns.org bash bootstrap-server.sh
#
# 可选环境变量:
#   TOKEN=xxx              frp 共享密钥（默认随机生成，脚本结束会打印）
#   FRP_VERSION=v0.71.0    frp 版本
#   REMOTE_PORT=13000      frp 数据面端口（只监听服务器 127.0.0.1，不暴露公网）
set -euo pipefail

DOMAIN="${DOMAIN:?请设置 DOMAIN=你的域名，例如 DOMAIN=caoqu.duckdns.org}"
REMOTE_PORT="${REMOTE_PORT:-13000}"
FRP_VERSION="${FRP_VERSION:-v0.71.0}"
TOKEN="${TOKEN:-$(openssl rand -hex 24)}"
DASH_USER="${DASH_USER:-admin}"
DASH_PASS="${DASH_PASS:-$(openssl rand -hex 8)}"

if [[ $EUID -ne 0 ]]; then
  echo "请用 sudo 运行"; exit 1
fi

# 1. 下载并安装 frps
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  FRP_ARCH=amd64 ;;
  aarch64) FRP_ARCH=arm64 ;;
  *) echo "不支持的架构: $ARCH"; exit 1 ;;
esac
TMP="$(mktemp -d)"
FRP_VER_NUM="${FRP_VERSION#v}"   # tag 带 v，资产文件名不带 v
TARBALL="frp_${FRP_VER_NUM}_linux_${FRP_ARCH}.tar.gz"
echo "下载 ${TARBALL} ..."
curl -fsSL --retry 3 -o "$TMP/$TARBALL" \
  "https://github.com/fatedier/frp/releases/download/${FRP_VERSION}/${TARBALL}"
tar -xzf "$TMP/$TARBALL" -C "$TMP"
install -m 0755 "$TMP/frp_${FRP_VER_NUM}_linux_${FRP_ARCH}/frps" /usr/local/bin/frps
rm -rf "$TMP"

# 2. 写 frps 配置：数据面只绑 127.0.0.1，公网只暴露 7000 控制面（TLS 强制 + token）
mkdir -p /etc/frp
cat > /etc/frp/frps.toml <<EOF
bindAddr = "0.0.0.0"
bindPort = 7000
proxyBindAddr = "127.0.0.1"

auth.token = "${TOKEN}"
transport.tls.force = true

webServer.addr = "127.0.0.1"
webServer.port = 7500
webServer.user = "${DASH_USER}"
webServer.password = "${DASH_PASS}"
EOF

# 3. systemd 常驻：开机自启、崩溃 5 秒后自动拉起
cat > /etc/systemd/system/frps.service <<EOF
[Unit]
Description=frp server
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=always
RestartSec=5
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now frps

# 4. 安装 Caddy：签发并自动续期 Let's Encrypt 证书，反代到 frp 数据面
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq caddy > /dev/null

cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
	reverse_proxy 127.0.0.1:${REMOTE_PORT}
}
EOF
systemctl restart caddy
systemctl enable caddy

echo
echo "================================================"
echo " frps + Caddy 安装完成"
echo "   域名:      https://${DOMAIN}"
echo "   TOKEN:     ${TOKEN}"
echo "              （Mac 端安装要用，务必记下）"
echo "   frps 版本: ${FRP_VERSION}"
echo "   管理面板:  ssh -L 7500:127.0.0.1:7500 <user>@服务器IP"
echo "              然后本机访问 http://127.0.0.1:7500 （${DASH_USER} / ${DASH_PASS}）"
echo "================================================"
echo " 若证书没签下来：确认腾讯云控制台防火墙已放行 TCP 80/443/7000，"
echo " 再看日志: journalctl -u caddy -f ; journalctl -u frps -f"
