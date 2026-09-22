#!/usr/bin/env sh
# install-worker.sh - Linux worker installer.
#
# Design boundaries:
#   - Installs the drec worker runtime, systemd service, and optional tunnel client.
#   - Does not create or store SSH keys, Tailscale auth keys, Cloudflare tokens, or secrets.
#   - Does not perform ssh-copy-id, tailscale up, cloudflared login, or other auth actions.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/fuyucn/douyin-rec/main/scripts/install-worker.sh \
#     | sudo sh
#
# Downloads from the GitHub Release by default:
#   douyin-rec-worker-linux-amd64.tar.gz
#   douyin-rec-worker-linux-arm64.tar.gz
#
# For local development, pass --archive <local tar.gz or URL>.
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
PACKAGES="${DREC_PACKAGES:-}"
ROLE="${DREC_ROLE:-}"
PACKAGES_EXPLICIT=0
ROLE_EXPLICIT=0
DRY_RUN=0
START=1

usage() {
  cat <<'EOF'
Usage:
  install-worker.sh [options]

Options:
  --version <x.y.z>       Pin a release version (default: latest)
  --root <dir>            Data root and install directory (default: /srv/drec)
  --port <n>              Worker listen port (default: 7860)
  --host <host>           Listen address (default: 127.0.0.1; not public)
  --service <name>        systemd service name (default: drec-worker)
  --user <name>           Service user (default: sudo caller or root)
  --packages <list>       Comma-separated packages: base,web,hub (default: base,web)
  --role <role>           worker|master (default: worker; hub selection implies master)
  --tunnel <mode>         none|tailscale|cloudflared (default: none; client only)
  --archive <path|url>    Custom worker tar.gz (development/private mirror)
  --tz <name>             Timezone (default: Asia/Shanghai)
  --no-start              Install without starting the service
  --dry-run               Validate arguments and archive without writing to the system
  -h, --help              Show help
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'Warning: %s\n' "$*" >&2
}

need_value() {
  [ "$#" -ge 2 ] || fail "$1 requires a value"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) need_value "$@"; VERSION="$2"; shift 2 ;;
    --root) need_value "$@"; ROOT="$2"; shift 2 ;;
    --port) need_value "$@"; PORT="$2"; shift 2 ;;
    --host) need_value "$@"; HOST="$2"; shift 2 ;;
    --service) need_value "$@"; SERVICE="$2"; shift 2 ;;
    --user) need_value "$@"; SERVICE_USER="$2"; shift 2 ;;
    --packages) need_value "$@"; PACKAGES="$2"; PACKAGES_EXPLICIT=1; shift 2 ;;
    --role) need_value "$@"; ROLE="$2"; ROLE_EXPLICIT=1; shift 2 ;;
    --tunnel) need_value "$@"; TUNNEL="$2"; shift 2 ;;
    --archive) need_value "$@"; ARCHIVE="$2"; shift 2 ;;
    --tz) need_value "$@"; TIMEZONE="$2"; shift 2 ;;
    --no-start) START=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

case "$PORT" in
  ''|*[!0-9]*) fail "Port must be numeric: $PORT" ;;
esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || fail "Port out of range: $PORT"

case "$TUNNEL" in
  none|tailscale|cloudflared) ;;
  *) fail "--tunnel supports only none|tailscale|cloudflared; got: $TUNNEL" ;;
esac

case "$SERVICE" in
  ''|*[!A-Za-z0-9_.@-]*) fail "Service name contains invalid characters: $SERVICE" ;;
esac

case "$HOST" in
  ''|*[[:space:]]*) fail "Host cannot be empty or contain whitespace: $HOST" ;;
esac
case "$TIMEZONE" in
  ''|*[[:space:]]*) fail "Timezone cannot be empty or contain whitespace: $TIMEZONE" ;;
esac

case "$ROOT" in
  /*) ;;
  *) fail "--root must be an absolute path: $ROOT" ;;
esac
case "$ROOT" in
  *[[:space:]]*) fail "--root does not support spaces: $ROOT" ;;
esac

ENV_FILE="/etc/${SERVICE}.env"

read_env_value() {
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | tail -n 1
}

if [ -z "$PACKAGES" ]; then
  PACKAGES="$(read_env_value "$ENV_FILE" DREC_PACKAGES)"
fi
if [ -z "$ROLE" ]; then
  ROLE="$(read_env_value "$ENV_FILE" DREC_ROLE)"
fi
[ -n "$PACKAGES" ] || PACKAGES="base,web"
[ -n "$ROLE" ] || ROLE="worker"

PKG_BASE=0
PKG_WEB=0
PKG_HUB=0
OLD_IFS="$IFS"
IFS=,
for pkg in $PACKAGES; do
  case "$pkg" in
    base) PKG_BASE=1 ;;
    web) PKG_WEB=1 ;;
    hub) PKG_HUB=1 ;;
    '') ;;
    *) IFS="$OLD_IFS"; fail "Unknown package: $pkg (supported: base,web,hub)" ;;
  esac
done
IFS="$OLD_IFS"

case "$ROLE" in
  worker|master) ;;
  *) fail "--role must be worker or master; got: $ROLE" ;;
esac

if [ "$PKG_HUB" -eq 1 ] && [ "$ROLE_EXPLICIT" -eq 1 ] && [ "$ROLE" = "worker" ]; then
  fail "Package hub requires --role master"
fi
if [ "$PKG_HUB" -eq 1 ] && [ "$ROLE_EXPLICIT" -eq 0 ]; then
  ROLE="master"
fi
if [ "$ROLE" = "master" ]; then
  PKG_BASE=1
  PKG_WEB=1
  PKG_HUB=1
fi
[ "$PKG_BASE" -eq 1 ] || fail "Package base is required"

PACKAGES="base"
[ "$PKG_WEB" -eq 1 ] && PACKAGES="${PACKAGES},web"
[ "$PKG_HUB" -eq 1 ] && PACKAGES="${PACKAGES},hub"

if [ -z "$VERSION" ]; then
  VERSION="latest"
fi
case "$VERSION" in
  latest) ;;
  dev)
    [ -n "$ARCHIVE" ] || fail "Version dev requires --archive"
    ;;
  *)
    printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
      || fail "Version must be x.y.z or latest; got: $VERSION"
    ;;
esac

OS="$(uname -s)"
RAW_ARCH="$(uname -m)"
case "$RAW_ARCH" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) fail "Unsupported architecture: $RAW_ARCH (supported: amd64 / arm64)" ;;
esac

if [ "$DRY_RUN" -eq 0 ]; then
  [ "$OS" = "Linux" ] || fail "install-worker.sh currently supports Linux only"
  [ "$(id -u)" -eq 0 ] || fail "Root privileges required; run with sudo sh -s -- ..."
  command -v systemctl >/dev/null 2>&1 || fail "systemctl not found"
  command -v tar >/dev/null 2>&1 || fail "tar not found"

  NODE_BIN="$(command -v node || true)"
  [ -n "$NODE_BIN" ] || fail "Node 24+ not found; install Node and run again"
  NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 24 ] || fail "Node version too old: $("$NODE_BIN" -v); Node 24+ required"

  command -v ffmpeg >/dev/null 2>&1 || fail "ffmpeg not found; install ffmpeg first"
  command -v ffprobe >/dev/null 2>&1 || fail "ffprobe not found; install a complete ffmpeg package"
  id "$SERVICE_USER" >/dev/null 2>&1 || fail "User does not exist: $SERVICE_USER"

  if [ "$ROLE" = "master" ]; then
    command -v ssh >/dev/null 2>&1 || warn "ssh not found; SSH workers will be unavailable"
    command -v rsync >/dev/null 2>&1 || warn "rsync not found; remote recording transfer may be unavailable"
    command -v biliup >/dev/null 2>&1 || warn "biliup not found; upload nodes will fail"
    command -v youtubeuploader >/dev/null 2>&1 || warn "youtubeuploader not found; YouTube upload destinations will fail"
    command -v fc-list >/dev/null 2>&1 || warn "fontconfig not found; subtitle burning may fail"
  fi
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
    fail "curl or wget is required to download the archive"
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
  [ -n "$expected" ] || fail "Checksum file is empty: $2"
  [ "$expected" = "$actual" ] || fail "SHA256 mismatch: $1"
}

printf '==> Fetching worker archive\n'
case "$ARCHIVE" in
  http://*|https://*)
    download "$ARCHIVE" "$ARCHIVE_FILE"
    if download "${ARCHIVE}.sha256" "$TMP/worker.tar.gz.sha256" 2>/dev/null; then
      verify_checksum "$ARCHIVE_FILE" "$TMP/worker.tar.gz.sha256"
    else
      printf 'Note: %s.sha256 not found; skipping checksum verification\n' "$ARCHIVE" >&2
    fi
    ;;
  *)
    [ -f "$ARCHIVE" ] || fail "Archive does not exist: $ARCHIVE"
    cp "$ARCHIVE" "$ARCHIVE_FILE"
    if [ -f "${ARCHIVE}.sha256" ]; then
      cp "${ARCHIVE}.sha256" "$TMP/worker.tar.gz.sha256"
      verify_checksum "$ARCHIVE_FILE" "$TMP/worker.tar.gz.sha256"
    fi
    ;;
esac

tar -tzf "$ARCHIVE_FILE" >/dev/null 2>&1 || fail "Archive is not a valid tar.gz: $ARCHIVE"
if tar -tzf "$ARCHIVE_FILE" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  fail "Archive contains unsafe paths: $ARCHIVE"
fi
tar -xzf "$ARCHIVE_FILE" -C "$TMP"
LAYOUT="legacy"
if [ -f "$TMP/manifest.json" ] && [ -d "$TMP/packages/base" ]; then
  LAYOUT="packages"
fi

if [ "$LAYOUT" = "packages" ]; then
  [ -f "$TMP/packages/base/dist/douyin-rec.mjs" ] || fail "Package base is missing dist/douyin-rec.mjs"
  [ -x "$TMP/packages/base/bin/mesio" ] || fail "Package base is missing executable bin/mesio"
  if [ "$PKG_WEB" -eq 1 ] && [ ! -f "$TMP/packages/web/dist/index.html" ]; then
    fail "Package web is requested but archive is missing packages/web/dist/index.html"
  fi
  if [ "$PKG_HUB" -eq 1 ] && [ ! -f "$TMP/packages/hub/config/hub.config.example.json" ]; then
    fail "Package hub is requested but archive is missing packages/hub/config/hub.config.example.json"
  fi
else
  [ -f "$TMP/dist/douyin-rec.mjs" ] || fail "Archive is missing dist/douyin-rec.mjs"
  [ -x "$TMP/bin/mesio" ] || fail "Archive is missing executable bin/mesio"
  if [ "$PKG_WEB" -eq 1 ] && [ ! -f "$TMP/web/dist/index.html" ] && [ ! -f "$ROOT/web/dist/index.html" ]; then
    fail "Package web is requested but archive has no web/dist/index.html"
  fi
  if [ "$PKG_HUB" -eq 1 ]; then
    fail "Package hub is not available in legacy archives; use a newer release"
  fi
fi
INSTALLED_VERSION="$(cat "$TMP/VERSION" 2>/dev/null || printf '%s' "$VERSION")"

if [ "$DRY_RUN" -eq 1 ]; then
  printf '✓ Dry run passed\n'
  printf '  version: %s\n' "$INSTALLED_VERSION"
  printf '  root:    %s\n' "$ROOT"
  printf '  listen:  %s:%s\n' "$HOST" "$PORT"
  printf '  user:    %s\n' "$SERVICE_USER"
  printf '  packages: %s\n' "$PACKAGES"
  printf '  role:     %s\n' "$ROLE"
  printf '  tunnel:  %s (authentication must be configured separately)\n' "$TUNNEL"
  exit 0
fi

SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
UNIT_FILE="/etc/systemd/system/${SERVICE}.service"

printf '==> Installing to %s\n' "$ROOT"
mkdir -p "$ROOT"
mkdir -p "$ROOT/config" "$ROOT/db" "$ROOT/recordings" "$ROOT/stage"

rm -rf "$ROOT/dist" "$ROOT/bin"
mkdir -p "$ROOT/dist" "$ROOT/bin"
if [ "$LAYOUT" = "packages" ]; then
  cp -R "$TMP/packages/base/dist"/. "$ROOT/dist/"
  cp -R "$TMP/packages/base/bin"/. "$ROOT/bin/"
else
  cp -R "$TMP/dist"/. "$ROOT/dist/"
  cp -R "$TMP/bin"/. "$ROOT/bin/"
fi

if [ "$PKG_WEB" -eq 1 ]; then
  mkdir -p "$ROOT/web"
  rm -rf "$ROOT/web/dist"
  if [ "$LAYOUT" = "packages" ]; then
    cp -R "$TMP/packages/web/dist" "$ROOT/web/dist"
  else
    if [ -f "$TMP/web/dist/index.html" ]; then
      cp -R "$TMP/web/dist" "$ROOT/web/dist"
    else
      printf 'Warning: archive has no web package; keeping existing Web UI\n' >&2
    fi
  fi
fi

if [ "$PKG_HUB" -eq 1 ]; then
  mkdir -p "$ROOT/config"
  if [ ! -f "$ROOT/config/hub.config.example.json" ]; then
    cp "$TMP/packages/hub/config/hub.config.example.json" "$ROOT/config/hub.config.example.json"
  fi
fi

if [ "$LAYOUT" = "packages" ]; then
  cp "$TMP/manifest.json" "$ROOT/manifest.json"
fi
cp "$TMP/VERSION" "$ROOT/VERSION" 2>/dev/null || true

chown -R "$SERVICE_USER:$SERVICE_GROUP" "$ROOT/dist" "$ROOT/bin"
[ ! -e "$ROOT/scripts" ] || chown -R "$SERVICE_USER:$SERVICE_GROUP" "$ROOT/scripts"
[ ! -e "$ROOT/web" ] || chown -R "$SERVICE_USER:$SERVICE_GROUP" "$ROOT/web"
[ ! -e "$ROOT/manifest.json" ] || chown "$SERVICE_USER:$SERVICE_GROUP" "$ROOT/manifest.json"
[ ! -e "$ROOT/VERSION" ] || chown "$SERVICE_USER:$SERVICE_GROUP" "$ROOT/VERSION"
chown "$SERVICE_USER:$SERVICE_GROUP" "$ROOT" "$ROOT/config" "$ROOT/db" "$ROOT/recordings" "$ROOT/stage"
chmod 0750 "$ROOT"
chmod 0755 "$ROOT/dist/douyin-rec.mjs" "$ROOT/bin/mesio"

cat >"$ENV_FILE" <<EOF
DOUYIN_REC_ROOT=${ROOT}
DREC_SERVE_API=${API_URL}
MESIO_PATH=${ROOT}/bin/mesio
TZ=${TIMEZONE}
DREC_PACKAGES=${PACKAGES}
DREC_ROLE=${ROLE}
EOF
chown root:"$SERVICE_GROUP" "$ENV_FILE"
chmod 0640 "$ENV_FILE"

HUB_FLAG=""
if [ "$ROLE" = "master" ]; then
  HUB_FLAG=" --hub"
fi

cat >"$UNIT_FILE" <<EOF
[Unit]
Description=drec ${ROLE}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${ROOT}
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} ${ROOT}/dist/douyin-rec.mjs task serve --port ${PORT} --host ${HOST}${HUB_FLAG}
Restart=always
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF

if [ "$TUNNEL" = "tailscale" ] && ! command -v tailscale >/dev/null 2>&1; then
  printf '==> Installing Tailscale client (does not run tailscale up)\n'
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://tailscale.com/install.sh | sh
  else
    fail "Installing Tailscale requires curl"
  fi
elif [ "$TUNNEL" = "cloudflared" ] && ! command -v cloudflared >/dev/null 2>&1; then
  printf '==> Installing cloudflared (does not run tunnel login/run)\n'
  CLOUDFLARED_URL="${CLOUDFLARED_URL:-https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}}"
  download "$CLOUDFLARED_URL" "$TMP/cloudflared"
  install -m 0755 "$TMP/cloudflared" /usr/local/bin/cloudflared
fi

systemctl daemon-reload
if [ "$START" -eq 1 ]; then
  systemctl enable "$SERVICE"
  systemctl restart "$SERVICE"
fi

printf '\n✓ drec %s installed\n' "$ROLE"
printf '  version: %s\n' "$INSTALLED_VERSION"
printf '  service: %s\n' "$SERVICE"
printf '  root:    %s\n' "$ROOT"
printf '  listen:  %s:%s\n' "$HOST" "$PORT"
printf '  user:    %s\n' "$SERVICE_USER"
printf '  packages: %s\n' "$PACKAGES"
printf '  role:     %s\n' "$ROLE"

case "$TUNNEL" in
  tailscale)
    printf '\nConfigure tunnel authentication separately. The installer did not run tailscale up:\n'
    printf '  sudo tailscale up\n'
    printf '  sudo tailscale status\n'
    ;;
  cloudflared)
    printf '\nConfigure tunnel authentication separately. The installer did not run cloudflared login/run:\n'
    printf '  cloudflared tunnel login\n'
    printf '  cloudflared tunnel run <tunnel-name>\n'
    ;;
  none)
    printf '\nConfigure connectivity and authentication separately (public SSH, LAN, WireGuard, Tailscale, or another tunnel).\n'
    ;;
esac

if [ "$ROLE" = "master" ]; then
  printf '\nHub configuration:\n'
  printf '  %s/config/hub.config.json\n' "$ROOT"
  printf '  Example: %s/config/hub.config.example.json\n' "$ROOT"
else
  printf '\nOn the master, configure only the endpoint, not keys or tokens:\n'
  printf '  { "id": "vps1", "kind": "ssh", "host": "<ssh-alias>", "dataRoot": "%s" }\n' "$ROOT"
fi
printf '\nLocal self-check:\n'
printf '  node %s/dist/douyin-rec.mjs _tasks %s\n' "$ROOT" "$ROOT"

if [ "$START" -eq 1 ] && command -v curl >/dev/null 2>&1; then
  sleep 1
  curl -fsS "${API_URL}/api/version" >/dev/null \
    && printf '✓ %s API responded at %s\n' "$ROLE" "$API_URL" \
    || printf 'Warning: %s started but the API has not responded yet; check journalctl -u %s\n' "$ROLE" "$SERVICE" >&2
fi
