#!/bin/sh
# dev controller 启动脚本(issue #82):装 dev SSH 配置段 + 专用密钥 + known_hosts,然后 exec node task serve --hub。
set -eu
DATA=/output-data
MARK="$DATA/.drec-dev-e2e"
if [ "${DREC_DEV:-}" != "1" ] || [ ! -f "$MARK" ]; then
  echo "[dev-controller] 拒绝启动:$DATA 无 dev 标记(.drec-dev-e2e),疑似挂了非 dev 数据根" >&2
  exit 1
fi
# 镜像里不应有线上 SSH 段;确认 /root/.ssh 里只有我们写的内容。
mkdir -p /root/.ssh "$DATA/.dev-ssh"
chmod 700 /root/.ssh
cp /dev-keys/dev_ed25519 /root/.ssh/dev_ed25519
chmod 600 /root/.ssh/dev_ed25519
cp /etc/drec-dev/ssh_config.dev /root/.ssh/config
chmod 600 /root/.ssh/config
touch "$DATA/.dev-ssh/known_hosts"

CK="$DATA/config/biliup/cookies.json"
mkdir -p "$(dirname "$CK")"
if [ ! -f "$CK" ]; then
  cat > "$CK" <<'JSON'
{"drec-dev-fake":true,"cookie_info":{"cookies":[{"name":"SESSDATA","value":"FAKE-DEV-SESSDATA"},{"name":"bili_jct","value":"FAKE-DEV-JCT"},{"name":"DedeUserID","value":"0"}]},"token_info":{"access_token":"FAKE-DEV","refresh_token":"FAKE-DEV"}}
JSON
fi
cd /app
exec "$@"
