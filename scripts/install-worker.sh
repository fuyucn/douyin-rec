#!/usr/bin/env sh
# install-worker.sh — Linux worker 安装器。
#
# 设计边界:
#   - 只安装 drec worker runtime、systemd service 和可选 tunnel 客户端。
#   - 不生成/保存 SSH key、Tailscale auth key、Cloudflare token 或任何 Secret。
#   - 不执行 ssh-copy-id、tailscale up、cloudflared login 等认证动作。
#
# 用法:
#   curl -fsSL https://github.com/fuyucn/douyin-rec/releases/latest/download/install-worker.sh \
#     | sudo sh
#
# 默认从 GitHub Release 下载:
#   douyin-rec-worker-linux-amd64.tar.gz
#   douyin-rec-worker-linux-arm64.tar.gz
#
# 本地开发可传 --archive <本地 tar.gz 或 URL>。
set -eu

REPO="${DREC_REPO:-fuyucn/douyin-rec}"
VERSION="${DREC_VERSION:-latest}"
ROOT="${DREC_ROOT:-/srv/drec}"
PORT="${DREC_PORT:-7860}"
HOST="${DREC_HOST:-127.0.0.1}"
SERVICE="${DREC_SERVICE:-drec-worker}"
SERVICE_USER="${DREC_USER:-${SUDO_USER:-root}}"
TUNNEL="${DREC_TUNNEL:-none}"
ARCHIVE="${DREC_ARCHIVE:-}"
TIMEZONE="${DREC_TZ:-Asia/Shanghai}"
DRY_RUN=0
START=1

usage() {
  cat <<'EOF'
用法:
  install-worker.sh [选项]

选项:
  --version <x.y.z>       固定发布版本（默认 latest）
  --root <dir>            数据根与安装目录（默认 /srv/drec）
  --port <n>              worker 监听端口（默认 7860）
  --host <host>           监听地址（默认 127.0.0.1，不向公网暴露）
  --service <name>        systemd service 名（默认 drec-worker）
  --user <name>           service 运行用户（默认 sudo 调用者或 root）
  --tunnel <mode>         none|tailscale|cloudflared（默认 none；只安装客户端，不认证）
  --archive <path|url>    自定义 worker tar.gz（开发/私有镜像来源）
  --tz <name>             时区（默认 Asia/Shanghai）
  --no-start              安装后不启动 service
  --dry-run               只检查参数和归档，不写系统
  -h, --help              显示帮助
EOF
}

fail() {
  printf '错误: %s\n' "$*" >&2
  exit 1
}

need_value() {
  [ "$#" -ge 2 ] || fail "$1 缺少参数"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) need_value "$@"; VERSION="$2"; shift 2 ;;
    --root) need_value "$@"; ROOT="$2"; shift 2 ;;
    --port) need_value "$@"; PORT="$2"; shift 2 ;;
    --host) need_value "$@"; HOST="$2"; shift 2 ;;
    --service) need_value "$@"; SERVICE="$2"; shift 2 ;;
    --user) need_value "$@"; SERVICE_USER="$2"; shift 2 ;;
    --tunnel) need_value "$@"; TUNNEL="$2"; shift 2 ;;
    --archive) need_value "$@"; ARCHIVE="$2"; shift 2 ;;
    --tz) need_value "$@"; TIMEZONE="$2"; shift 2 ;;
    --no-start) START=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "未知参数: $1" ;;
  esac
done

case "$PORT" in
  ''|*[!0-9]*) fail "端口必须是数字: $PORT" ;;
esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || fail "端口超出范围: $PORT"

case "$TUNNEL" in
  none|tailscale|cloudflared) ;;
  *) fail "--tunnel 只支持 none|tailscale|cloudflared，收到: $TUNNEL" ;;
esac

case "$SERVICE" in
  ''|*[!A-Za-z0-9_.@-]*) fail "service 名含非法字符: $SERVICE" ;;
esac

case "$HOST" in
  ''|*[[:space:]]*) fail "host 不能为空或含空白字符: $HOST" ;;
esac
case "$TIMEZONE" in
  ''|*[[:space:]]*) fail "时区不能为空或含空白字符: $TIMEZONE" ;;
esac

case "$ROOT" in
  /*) ;;
  *) fail "--root 必须是绝对路径: $ROOT" ;;
esac
case "$ROOT" in
  *[[:space:]]*) fail "--root 暂不支持空格: $ROOT" ;;
esac

if [ -z "$VERSION" ]; then
  VERSION="latest"
fi
case "$VERSION" in
  latest) ;;
  dev)
    [ -n "$ARCHIVE" ] || fail "使用 dev 时必须同时传 --archive"
    ;;
  *)
    printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
      || fail "版本号必须是 x.y.z 或 latest，收到: $VERSION"
    ;;
esac

OS="$(uname -s)"
RAW_ARCH="$(uname -m)"
case "$RAW_ARCH" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) fail "不支持的架构: $RAW_ARCH（支持 amd64 / arm64）" ;;
esac

if [ "$DRY_RUN" -eq 0 ]; then
  [ "$OS" = "Linux" ] || fail "install-worker.sh 当前只支持 Linux"
  [ "$(id -u)" -eq 0 ] || fail "需要 root；请用 sudo sh -s -- ..."
  command -v systemctl >/dev/null 2>&1 || fail "未找到 systemd"
  command -v tar >/dev/null 2>&1 || fail "缺少 tar"

  NODE_BIN="$(command -v node || true)"
  [ -n "$NODE_BIN" ] || fail "缺少 Node 24+；请先安装 Node，再重新运行"
  NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 24 ] || fail "Node 版本过低: $("$NODE_BIN" -v)；需要 Node 24+"

  command -v ffmpeg >/dev/null 2>&1 || fail "缺少 ffmpeg；请先安装 ffmpeg"
  command -v ffprobe >/dev/null 2>&1 || fail "缺少 ffprobe；请安装完整 ffmpeg"
  id "$SERVICE_USER" >/dev/null 2>&1 || fail "用户不存在: $SERVICE_USER"
else
  NODE_BIN="${DREC_NODE_BIN:-node}"
fi

case "$HOST" in
  0.0.0.0|::|::0) API_HOST="127.0.0.1" ;;
  *) API_HOST="$HOST" ;;
esac
case "$API_HOST" in
  *:*) API_URL="http://[${API_HOST}]:${PORT}" ;;
  *) API_URL="http://${API_HOST}:${PORT}" ;;
esac

if [ -z "$ARCHIVE" ]; then
  case "$VERSION" in
    latest)
      ARCHIVE="https://github.com/${REPO}/releases/latest/download/douyin-rec-worker-linux-${ARCH}.tar.gz"
      ;;
    *)
      ARCHIVE="https://github.com/${REPO}/releases/download/v${VERSION}/douyin-rec-worker-linux-${ARCH}.tar.gz"
      ;;
  esac
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
ARCHIVE_FILE="$TMP/worker.tar.gz"

download() {
  src="$1"
  dst="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --connect-timeout 15 "$src" -o "$dst"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$dst" "$src"
  else
    fail "需要 curl 或 wget 下载归档"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  fi
}

verify_checksum() {
  expected="$(awk 'NR == 1 { print $1 }' "$2")"
  actual="$(sha256_of "$1")"
  [ -n "$expected" ] || fail "校验文件为空: $2"
  [ "$expected" = "$actual" ] || fail "SHA256 不匹配: $1"
}

printf '==> 获取 worker 归档\n'
case "$ARCHIVE" in
  http://*|https://*)
    download "$ARCHIVE" "$ARCHIVE_FILE"
    if download "${ARCHIVE}.sha256" "$TMP/worker.tar.gz.sha256" 2>/dev/null; then
      verify_checksum "$ARCHIVE_FILE" "$TMP/worker.tar.gz.sha256"
    else
      printf '提示: 未找到 %s.sha256，跳过校验\n' "$ARCHIVE" >&2
    fi
    ;;
  *)
    [ -f "$ARCHIVE" ] || fail "归档不存在: $ARCHIVE"
    cp "$ARCHIVE" "$ARCHIVE_FILE"
    if [ -f "${ARCHIVE}.sha256" ]; then
      cp "${ARCHIVE}.sha256" "$TMP/worker.tar.gz.sha256"
      verify_checksum "$ARCHIVE_FILE" "$TMP/worker.tar.gz.sha256"
    fi
    ;;
esac

tar -tzf "$ARCHIVE_FILE" >/dev/null 2>&1 || fail "归档不是有效的 tar.gz: $ARCHIVE"
if tar -tzf "$ARCHIVE_FILE" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  fail "归档包含不安全路径: $ARCHIVE"
fi
tar -xzf "$ARCHIVE_FILE" -C "$TMP"
[ -f "$TMP/dist/douyin-rec.mjs" ] || fail "归档缺少 dist/douyin-rec.mjs"
[ -x "$TMP/bin/mesio" ] || fail "归档缺少可执行文件 bin/mesio"
INSTALLED_VERSION="$(cat "$TMP/VERSION" 2>/dev/null || printf '%s' "$VERSION")"

if [ "$DRY_RUN" -eq 1 ]; then
  printf '✓ dry-run 通过\n'
  printf '  version: %s\n' "$INSTALLED_VERSION"
  printf '  root:    %s\n' "$ROOT"
  printf '  listen:  %s:%s\n' "$HOST" "$PORT"
  printf '  user:    %s\n' "$SERVICE_USER"
  printf '  tunnel:  %s (认证由用户配置)\n' "$TUNNEL"
  exit 0
fi

SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
ENV_FILE="/etc/${SERVICE}.env"
UNIT_FILE="/etc/systemd/system/${SERVICE}.service"

printf '==> 安装到 %s\n' "$ROOT"
mkdir -p "$ROOT"
tar -xzf "$ARCHIVE_FILE" -C "$ROOT"
mkdir -p "$ROOT/config" "$ROOT/db" "$ROOT/recordings" "$ROOT/stage"
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$ROOT/dist" "$ROOT/bin"
[ ! -e "$ROOT/scripts" ] || chown -R "$SERVICE_USER:$SERVICE_GROUP" "$ROOT/scripts"
[ ! -e "$ROOT/VERSION" ] || chown "$SERVICE_USER:$SERVICE_GROUP" "$ROOT/VERSION"
chown "$SERVICE_USER:$SERVICE_GROUP" "$ROOT" "$ROOT/config" "$ROOT/db" "$ROOT/recordings" "$ROOT/stage"
chmod 0750 "$ROOT"
chmod 0755 "$ROOT/dist/douyin-rec.mjs" "$ROOT/bin/mesio"

cat >"$ENV_FILE" <<EOF
DOUYIN_REC_ROOT=${ROOT}
DREC_SERVE_API=${API_URL}
MESIO_PATH=${ROOT}/bin/mesio
TZ=${TIMEZONE}
EOF
chown root:"$SERVICE_GROUP" "$ENV_FILE"
chmod 0640 "$ENV_FILE"

cat >"$UNIT_FILE" <<EOF
[Unit]
Description=drec worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${ROOT}
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} ${ROOT}/dist/douyin-rec.mjs task serve --port ${PORT} --host ${HOST}
Restart=always
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF

if [ "$TUNNEL" = "tailscale" ] && ! command -v tailscale >/dev/null 2>&1; then
  printf '==> 安装 Tailscale 客户端（不会执行 tailscale up）\n'
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://tailscale.com/install.sh | sh
  else
    fail "安装 Tailscale 需要 curl"
  fi
elif [ "$TUNNEL" = "cloudflared" ] && ! command -v cloudflared >/dev/null 2>&1; then
  printf '==> 安装 cloudflared（不会执行 tunnel login/run）\n'
  CLOUDFLARED_URL="${CLOUDFLARED_URL:-https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}}"
  download "$CLOUDFLARED_URL" "$TMP/cloudflared"
  install -m 0755 "$TMP/cloudflared" /usr/local/bin/cloudflared
fi

systemctl daemon-reload
if [ "$START" -eq 1 ]; then
  systemctl enable "$SERVICE"
  systemctl restart "$SERVICE"
fi

printf '\n✓ worker 已安装\n'
printf '  version: %s\n' "$INSTALLED_VERSION"
printf '  service: %s\n' "$SERVICE"
printf '  root:    %s\n' "$ROOT"
printf '  listen:  %s:%s\n' "$HOST" "$PORT"
printf '  user:    %s\n' "$SERVICE_USER"

case "$TUNNEL" in
  tailscale)
    printf '\nTunnel 认证由你配置，安装器没有执行 tailscale up:\n'
    printf '  sudo tailscale up\n'
    printf '  sudo tailscale status\n'
    ;;
  cloudflared)
    printf '\nTunnel 认证由你配置，安装器没有执行 cloudflared login/run:\n'
    printf '  cloudflared tunnel login\n'
    printf '  cloudflared tunnel run <tunnel-name>\n'
    ;;
  none)
    printf '\n连通性/认证由你配置（公网 SSH、LAN、WireGuard、Tailscale 或其他 tunnel）。\n'
    ;;
esac

printf '\nmaster 端只填 endpoint，不填 key/token:\n'
printf '  { "id": "vps1", "kind": "ssh", "host": "<ssh-alias>", "dataRoot": "%s" }\n' "$ROOT"
printf '\n本机自检:\n'
printf '  node %s/dist/douyin-rec.mjs _tasks %s\n' "$ROOT" "$ROOT"

if [ "$START" -eq 1 ] && command -v curl >/dev/null 2>&1; then
  sleep 1
  curl -fsS "${API_URL}/api/version" >/dev/null \
    && printf '✓ worker API 已响应 %s\n' "$API_URL" \
    || printf '警告: worker 已启动但 API 尚未响应，请查看 journalctl -u %s\n' "$SERVICE" >&2
fi
