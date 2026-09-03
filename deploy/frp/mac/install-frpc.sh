#!/usr/bin/env bash
# frp Mac 客户端一键安装：frpc + launchd 常驻（开机自启、崩溃/断线自动重连）
# 适用：macOS（Apple Silicon / Intel）
#
# 用法:
#   bash install-frpc.sh <服务器IP> <TOKEN> [本地端口=3000] [远程端口=13000]
set -euo pipefail

SERVER_ADDR="${1:?用法: bash install-frpc.sh <服务器IP> <TOKEN>}"
TOKEN="${2:?缺少 TOKEN（服务器脚本结束时打印过）}"
LOCAL_PORT="${3:-3000}"
REMOTE_PORT="${4:-13000}"
FRP_VERSION="${FRP_VERSION:-v0.71.0}"

DIR="$HOME/.agentroam-frp"
LOG_DIR="$HOME/Library/Logs"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/com.agentroam.frpc.plist"
mkdir -p "$DIR" "$LOG_DIR" "$PLIST_DIR"

# 1. 下载 frpc（GitHub 直连不稳时自动走本机 Clash 代理 7897 重试）
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  FRP_ARCH=arm64 ;;
  x86_64) FRP_ARCH=amd64 ;;
  *) echo "不支持的架构: $ARCH"; exit 1 ;;
esac
FRP_VER_NUM="${FRP_VERSION#v}"   # tag 带 v，资产文件名不带 v
TARBALL="frp_${FRP_VER_NUM}_darwin_${FRP_ARCH}.tar.gz"
URL="https://github.com/fatedier/frp/releases/download/${FRP_VERSION}/${TARBALL}"
TMP="$(mktemp -d)"
echo "下载 ${TARBALL} ..."
if ! curl -fsSL --retry 2 --connect-timeout 10 -o "$TMP/$TARBALL" "$URL"; then
  echo "直连失败，改走 Clash 代理 127.0.0.1:7897 重试 ..."
  curl -fsSL --retry 2 -x http://127.0.0.1:7897 -o "$TMP/$TARBALL" "$URL"
fi
tar -xzf "$TMP/$TARBALL" -C "$TMP"
install -m 0755 "$TMP/frp_${FRP_VER_NUM}_darwin_${FRP_ARCH}/frpc" "$DIR/frpc"
rm -rf "$TMP"

# 2. 写 frpc 配置：把本机 AgentRoam(:3000) 映射到服务器的 127.0.0.1:13000
cat > "$DIR/frpc.toml" <<EOF
serverAddr = "${SERVER_ADDR}"
serverPort = 7000
auth.token = "${TOKEN}"
transport.tls.enable = true

[[proxies]]
name = "agentroam-web"
type = "tcp"
localIP = "127.0.0.1"
localPort = ${LOCAL_PORT}
remotePort = ${REMOTE_PORT}
EOF

# 3. launchd 常驻
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>com.agentroam.frpc</string>
	<key>ProgramArguments</key>
	<array>
		<string>${DIR}/frpc</string>
		<string>-c</string>
		<string>${DIR}/frpc.toml</string>
	</array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>${LOG_DIR}/frpc.log</string>
	<key>StandardErrorPath</key><string>${LOG_DIR}/frpc.err.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/com.agentroam.frpc" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/com.agentroam.frpc"

echo
echo "================================================"
echo " frpc 安装完成并已启动"
echo "   配置:  ${DIR}/frpc.toml"
echo "   日志:  ${LOG_DIR}/frpc.log / frpc.err.log"
echo "   状态:  launchctl print gui/$(id -u)/com.agentroam.frpc | grep state"
echo "   访问:  https://<你的DuckDNS域名>  即为 Mac 上的 AgentRoam :${LOCAL_PORT}"
echo "================================================"
