#!/usr/bin/env bash
# 把当前 Codex(cc-switch) 的模型配置同步到 packages/server/.env.local
# 用法: 在 cc-switch 里选好 provider 后执行:
#   bash packages/server/sync-codex-model.sh
# 然后重启 server(3100 测试实例我会帮你重启;3000 正式实例需自行重启)
set -euo pipefail

AUTH="$HOME/.codex/auth.json"
CONFIG="$HOME/.codex/config.toml"
ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.env.local"

[ -f "$AUTH" ] || { echo "✗ 找不到 $AUTH"; exit 1; }
[ -f "$CONFIG" ] || { echo "✗ 找不到 $CONFIG"; exit 1; }

KEY=$(python3 -c "import json;print(json.load(open('$AUTH'))['OPENAI_API_KEY'])")
MODEL=$(grep -E '^model *= *"' "$CONFIG" | head -1 | cut -d'"' -f2)
BASE_URL=$(awk '/^\[model_providers\./{inblk=1} inblk && /^base_url/{print; exit}' "$CONFIG" | cut -d'"' -f2)
[ -n "$BASE_URL" ] || BASE_URL="http://localhost:20128/v1"
PROVIDER=$(grep -E '^model_provider *= *"' "$CONFIG" | head -1 | cut -d'"' -f2)
case "$PROVIDER" in
  anthropic|openai|deepseek) ;;
  *) PROVIDER="openai" ;;  # Codex 的 custom 等自定义 provider 走 OpenAI 兼容协议
esac

if grep -q '^AGENT_API_KEY=' "$ENV_FILE" 2>/dev/null; then
  sed -i '' "s|^AGENT_API_KEY=.*|AGENT_API_KEY=$KEY|" "$ENV_FILE"
  sed -i '' "s|^AGENT_MODEL_PROVIDER=.*|AGENT_MODEL_PROVIDER=$PROVIDER|" "$ENV_FILE"
  sed -i '' "s|^AGENT_MODEL_ID=.*|AGENT_MODEL_ID=$MODEL|" "$ENV_FILE"
  sed -i '' "s|^AGENT_BASE_URL=.*|AGENT_BASE_URL=$BASE_URL|" "$ENV_FILE"
else
  cat > "$ENV_FILE" << ENVEOF
AGENT_API_KEY=$KEY
AGENT_MODEL_PROVIDER=$PROVIDER
AGENT_MODEL_ID=$MODEL
AGENT_BASE_URL=$BASE_URL

# SDK Token (set to require auth; empty = dev mode)
AGENT_SDK_TOKEN=dev-token
ENVEOF
fi

echo "✓ 已同步 Codex 模型配置:"
echo "   provider: $PROVIDER"
echo "   model:    $MODEL"
echo "   base_url: $BASE_URL"
echo "   key:      ${KEY:0:12}..."
echo "重启 server 后生效(测试实例可直接让我重启)"
