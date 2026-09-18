#!/usr/bin/env bash
# build-worker-release.sh — 打包 Linux worker 发布物。
#
# 产物:
#   dist/releases/douyin-rec-worker-linux-amd64.tar.gz(.sha256)
#   dist/releases/douyin-rec-worker-linux-arm64.tar.gz(.sha256)
#
# 归档布局:
#   VERSION
#   manifest.json
#   packages/base/dist/douyin-rec.mjs
#   packages/base/dist/tui.mjs
#   packages/base/bin/mesio
#   packages/web/dist/
#   packages/hub/config/hub.config.example.json
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=""
OUT_DIR="${DREC_RELEASE_DIR:-$ROOT/dist/releases}"
ARCHES="all"
BUNDLE="${DREC_BUNDLE:-$ROOT/dist/douyin-rec.mjs}"
TUI_BUNDLE="${DREC_TUI_BUNDLE:-$ROOT/dist/tui.mjs}"
WEB_DIST="${DREC_WEB_DIST:-$ROOT/packages/web/dist}"
HUB_CONFIG="${DREC_HUB_CONFIG:-$ROOT/configs/hub.config.example.json}"
MESIO_VERSION="${MESIO_VERSION:-mesio-v0.4.1}"

usage() {
  cat <<'EOF'
用法:
  scripts/build-worker-release.sh --version <x.y.z> [--arch all|amd64|arm64]

环境变量:
  DREC_BUNDLE      指定 dist/douyin-rec.mjs（默认仓库 dist/）
  DREC_TUI_BUNDLE  指定 dist/tui.mjs（默认仓库 dist/）
  DREC_WEB_DIST    指定前端 dist（默认 packages/web/dist）
  DREC_HUB_CONFIG  指定 hub 配置模板（默认 configs/hub.config.example.json）
  DREC_RELEASE_DIR 输出目录（默认 dist/releases）
  MESIO_VERSION    mesio 版本（默认 mesio-v0.4.1）
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --arch) ARCHES="${2:-}"; shift 2 ;;
    --out-dir) OUT_DIR="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage; exit 1 ;;
  esac
done

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "--version 必须是 x.y.z" >&2; exit 1; }
case "$ARCHES" in all|amd64|arm64) ;; *) echo "--arch 只支持 all|amd64|arm64" >&2; exit 1 ;; esac
[ -f "$BUNDLE" ] || { echo "找不到 bundle: $BUNDLE；先运行 pnpm bundle" >&2; exit 1; }
[ -f "$TUI_BUNDLE" ] || { echo "找不到 TUI bundle: $TUI_BUNDLE；先运行 pnpm bundle" >&2; exit 1; }
[ -f "$WEB_DIST/index.html" ] || { echo "找不到前端: $WEB_DIST；先构建 packages/web" >&2; exit 1; }
[ -f "$HUB_CONFIG" ] || { echo "找不到 hub 配置模板: $HUB_CONFIG" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "缺少 tar" >&2; exit 1; }

download() {
  local url="$1" dst="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --connect-timeout 15 "$url" -o "$dst"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$dst" "$url"
  else
    echo "需要 curl 或 wget" >&2
    exit 1
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

arch_asset() {
  case "$1" in
    amd64) echo "x86_64" ;;
    arm64) echo "aarch64" ;;
  esac
}

build_one() {
  local arch="$1" ra stage arch_tmp mesio_url archive digest
  ra="$(arch_asset "$arch")"
  stage="$(mktemp -d)"
  arch_tmp="$(mktemp -d)"
  trap 'rm -rf "$stage" "$arch_tmp"' RETURN

  mkdir -p \
    "$stage/packages/base/dist" \
    "$stage/packages/base/bin" \
    "$stage/packages/web/dist" \
    "$stage/packages/hub/config"
  cp "$BUNDLE" "$stage/packages/base/dist/douyin-rec.mjs"
  cp "$TUI_BUNDLE" "$stage/packages/base/dist/tui.mjs"
  cp -R "$WEB_DIST"/. "$stage/packages/web/dist/"
  cp "$HUB_CONFIG" "$stage/packages/hub/config/hub.config.example.json"
  printf '%s\n' "$VERSION" >"$stage/VERSION"
  cat >"$stage/manifest.json" <<EOF
{
  "version": "$VERSION",
  "packages": {
    "base": { "required": true },
    "web": { "requires": ["base"] },
    "hub": { "requires": ["base", "web"] }
  }
}
EOF

  mesio_url="https://github.com/hua0512/rust-srec/releases/download/${MESIO_VERSION}/mesio-${ra}-unknown-linux-gnu"
  echo "==> 下载 mesio ($arch): $mesio_url"
  download "$mesio_url" "$arch_tmp/mesio"
  install -m 0755 "$arch_tmp/mesio" "$stage/packages/base/bin/mesio"

  mkdir -p "$OUT_DIR"
  archive="$OUT_DIR/douyin-rec-worker-linux-${arch}.tar.gz"
  rm -f "$archive" "${archive}.sha256"
  COPYFILE_DISABLE=1 tar -C "$stage" -czf "$archive" .
  digest="$(sha256 "$archive")"
  printf '%s  %s\n' "$digest" "$(basename "$archive")" >"${archive}.sha256"
  echo "✓ $archive"
}

case "$ARCHES" in
  all) build_one amd64; build_one arm64 ;;
  *) build_one "$ARCHES" ;;
esac
