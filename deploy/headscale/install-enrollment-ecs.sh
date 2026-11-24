#!/usr/bin/env bash
set -Eeuo pipefail

source_dir="$(cd "$(dirname "$0")" && pwd)"
mesh_dir=/opt/agentroam-mesh
app_dir=/opt/agentroam-mesh-enrollment
state_dir=/var/lib/agentroam-enrollment
unit=agentroam-mesh-enrollment.service
service_user=agentroam-enrollment
domain=headscale.kaiwuyouwei.com
vhost=/etc/nginx/conf.d/agentroam-headscale.conf
node_version=v22.22.0

test "$(id -u)" = 0
test -f "$vhost"
test "$(uname -m)" = x86_64
docker compose --project-directory "$mesh_dir" ps --status running headscale | grep -q headscale
curl -fsS --resolve "$domain:443:127.0.0.1" "https://$domain/health" >/dev/null

install -d -m 0755 "$app_dir"
node_dir="$app_dir/node-$node_version-linux-x64"
if [[ ! -x "$node_dir/bin/node" ]]; then
    archive="node-$node_version-linux-x64.tar.xz"
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    curl -fsSL --retry 2 --connect-timeout 8 --max-time 90 "https://nodejs.org/dist/$node_version/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
    curl -fsSL --retry 2 --connect-timeout 8 --max-time 90 "https://nodejs.org/dist/$node_version/$archive" -o "$tmp/$archive"
    (
      cd "$tmp"
      grep "  $archive\$" SHASUMS256.txt | sha256sum -c -
      tar -xJf "$archive"
    )
    mv "$tmp/node-$node_version-linux-x64" "$node_dir"
fi
"$node_dir/bin/node" --check "$source_dir/enrollment.mjs"

getent passwd "$service_user" >/dev/null || useradd --system --home-dir "$state_dir" --shell /sbin/nologin "$service_user"
install -d -m 0700 -o "$service_user" -g "$service_user" "$state_dir"
install -m 0644 "$source_dir/enrollment.mjs" "$app_dir/enrollment.mjs"
client="$source_dir/headscale-client.mjs"
if [[ ! -f "$client" ]]; then client="$source_dir/../../packages/server/lib/mesh/headscale-client.mjs"; fi
install -m 0644 "$client" "$app_dir/headscale-client.mjs"

keyfile="$app_dir/headscale.key"
if [[ ! -s "$keyfile" ]]; then
    umask 077
    docker compose --project-directory "$mesh_dir" exec -T headscale headscale apikeys create --expiration 8760h </dev/null >"$keyfile.new"
    test -s "$keyfile.new"
    install -m 0640 -o root -g "$service_user" "$keyfile.new" "$keyfile"
    rm -f "$keyfile.new"
fi

cat > "/etc/systemd/system/$unit" <<UNIT
[Unit]
Description=AgentRoam Headscale Enrollment
After=network-online.target docker.service

[Service]
User=$service_user
Group=$service_user
StateDirectory=agentroam-enrollment
StateDirectoryMode=0700
Environment=ENROLLMENT_HEADSCALE_URL=http://127.0.0.1:18080
Environment=ENROLLMENT_HEADSCALE_KEY_FILE=$keyfile
Environment=ENROLLMENT_PUBLIC_URL=https://$domain
ExecStart=$node_dir/bin/node --disable-warning=ExperimentalWarning $app_dir/enrollment.mjs
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 "/etc/systemd/system/$unit"
systemctl daemon-reload
systemctl enable "$unit"
systemctl restart "$unit"
curl -fsS --retry 5 --retry-connrefused http://127.0.0.1:18081/agentroam-enrollment/v1/health

if ! grep -Fq 'location ^~ /agentroam-enrollment/v1/' "$vhost"; then
    cp -p "$vhost" "$app_dir/nginx-before-enrollment.conf"
    python3 - "$vhost" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
config = path.read_text()
location = "    location / {\n        proxy_pass http://127.0.0.1:18080;"
assert config.count(location) == 1, "No unique Headscale upstream location"
enrollment = """    location ^~ /agentroam-enrollment/v1/ {
        client_max_body_size 1k;
        proxy_pass http://127.0.0.1:18081;
        proxy_read_timeout 35s;
    }

"""
path.write_text(config.replace(location, enrollment + location))
PY
    check_enrollment() {
        for attempt in 1 2 3 4 5; do
            if curl -fsS --max-time 3 --resolve "$domain:443:127.0.0.1" "https://$domain/agentroam-enrollment/v1/health"; then
                return 0
            fi
            sleep 1
        done
        return 1
    }
    if ! nginx -t || ! systemctl reload nginx || ! check_enrollment; then
        install -m 0644 "$app_dir/nginx-before-enrollment.conf" "$vhost"
        nginx -t && systemctl reload nginx
        exit 1
    fi
fi
curl -fsS --resolve "$domain:443:127.0.0.1" "https://$domain/health"
echo
echo ENROLLMENT_READY
