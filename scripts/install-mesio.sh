#!/usr/bin/env sh
# install-mesio.sh — 按本机平台(OS + 架构)下载 rust-srec 的 mesio 二进制。
#
# 用法:
#   scripts/install-mesio.sh [目标目录]      # 默认 ./bin → ./bin/mesio
#   MESIO_VERSION=mesio-v0.4.1 scripts/install-mesio.sh
#   MESIO_LIBC=musl scripts/install-mesio.sh  # linux 上选 musl(默认 gnu;alpine 用 musl)
#
# docker 里:RUN sh scripts/install-mesio.sh /usr/local/bin   (装到 PATH)
# 本机:装到 ./bin 后,跑录制时设 MESIO_PATH=<repo>/bin/mesio,或把 ./bin 加进 PATH。
set -eu

REPO="hua0512/rust-srec"

# ┌─ 存档的 mesio 版本(单一事实来源)──────────────────────────────────────────┐
# │ 升级 mesio:把下面这行改成新 tag(见 github.com/hua0512/rust-srec/releases  │
# │ 的 mesio-v* 标签),或临时 `MESIO_VERSION=mesio-vX.Y.Z scripts/install-mesio.sh`。│
# └────────────────────────────────────────────────────────────────────────────┘
PINNED_VERSION="mesio-v0.4.1"
VERSION="${MESIO_VERSION:-$PINNED_VERSION}"

DEST="${1:-${MESIO_DEST:-./bin}}"
LIBC="${MESIO_LIBC:-gnu}"   # linux: gnu | musl

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin) plat_os="apple-darwin" ;;
  Linux)  plat_os="unknown-linux-${LIBC}" ;;
  *) echo "✗ 不支持的 OS: $os(支持 Darwin / Linux)" >&2; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) plat_arch="aarch64" ;;
  x86_64|amd64)  plat_arch="x86_64" ;;
  *) echo "✗ 不支持的架构: $arch" >&2; exit 1 ;;
esac

asset="mesio-${plat_arch}-${plat_os}"
url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
mkdir -p "$DEST"
out="${DEST}/mesio"

echo "平台: ${os}/${arch} → ${asset} (${VERSION})"
echo "下载 → ${out}"
if command -v gh >/dev/null 2>&1; then
  # gh CLI(已登录时更抗限流);失败回退 curl。
  gh release download "$VERSION" --repo "$REPO" --pattern "$asset" --output "$out" --clobber \
    || curl -fSL "$url" -o "$out"
elif command -v curl >/dev/null 2>&1; then
  curl -fSL "$url" -o "$out"
elif command -v wget >/dev/null 2>&1; then
  wget -O "$out" "$url"
else
  echo "✗ 需要 gh / curl / wget 其中之一" >&2; exit 1
fi

chmod +x "$out"
# macOS Gatekeeper:解除下载隔离,免得首次执行被拦。
[ "$os" = "Darwin" ] && xattr -d com.apple.quarantine "$out" 2>/dev/null || true

echo "✓ 已安装: $out"
"$out" --version 2>/dev/null || true
case "$DEST" in
  /usr/local/bin|/usr/bin) echo "已在 PATH,可直接 mesio 调用(recorder 默认 MESIO_PATH=mesio)。" ;;
  *) echo "提示: 设 MESIO_PATH=\"$(cd "$DEST" && pwd)/mesio\",或把 $DEST 加入 PATH。" ;;
esac
