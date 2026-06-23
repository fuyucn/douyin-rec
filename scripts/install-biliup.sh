#!/usr/bin/env sh
# install-biliup.sh — 按本机平台(OS + 架构)下载 biliup 独立二进制(biliup/biliup 的 biliupR release)。
#
# 用法:
#   scripts/install-biliup.sh [目标目录]      # 默认 ./bin → ./bin/biliup
#   BILIUP_VERSION=v1.2.1 scripts/install-biliup.sh
#   BILIUP_LIBC=musl scripts/install-biliup.sh   # linux 上选 musl(默认 gnu;alpine 用 musl)
#
# 与 install-mesio.sh 同款。biliup 用于 B 站上传(upload/append),CLI 1.x 线带 --is-only-self。
# 注:上传仍走 upload-recording-today skill;此脚本只负责把二进制装到一致位置/版本。
set -eu

REPO="biliup/biliup"

# ┌─ 存档的 biliup 版本(单一事实来源)──────────────────────────────────────────┐
# │ 升级:改下面这行为新 tag(见 github.com/biliup/biliup/releases),或临时        │
# │ `BILIUP_VERSION=vX.Y.Z scripts/install-biliup.sh`。需 1.x 线(带 --is-only-self)。│
# └────────────────────────────────────────────────────────────────────────────┘
PINNED_VERSION="v1.2.1"
VERSION="${BILIUP_VERSION:-$PINNED_VERSION}"

DEST="${1:-${BILIUP_DEST:-./bin}}"
LIBC="${BILIUP_LIBC:-gnu}"   # linux: gnu | musl

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin) plat_os="macos" ;;
  Linux)  [ "$LIBC" = "musl" ] && plat_os="linux-musl" || plat_os="linux" ;;
  *) echo "✗ 不支持的 OS: $os(支持 Darwin / Linux)" >&2; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) plat_arch="aarch64" ;;
  x86_64|amd64)  plat_arch="x86_64" ;;
  *) echo "✗ 不支持的架构: $arch" >&2; exit 1 ;;
esac

asset="biliupR-${VERSION}-${plat_arch}-${plat_os}.tar.xz"
url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
mkdir -p "$DEST"
out="${DEST}/biliup"
tmp="$(mktemp -d)"

echo "平台: ${os}/${arch} → ${asset} (${VERSION})"
echo "下载 + 解压 → ${out}"
if command -v gh >/dev/null 2>&1; then
  gh release download "$VERSION" --repo "$REPO" --pattern "$asset" --output "$tmp/b.tar.xz" --clobber \
    || curl -fSL "$url" -o "$tmp/b.tar.xz"
elif command -v curl >/dev/null 2>&1; then
  curl -fSL "$url" -o "$tmp/b.tar.xz"
elif command -v wget >/dev/null 2>&1; then
  wget -O "$tmp/b.tar.xz" "$url"
else
  echo "✗ 需要 gh / curl / wget 其中之一" >&2; exit 1
fi

tar xf "$tmp/b.tar.xz" -C "$tmp"
bin="$(find "$tmp" -type f -name biliup | head -1)"
[ -n "$bin" ] || { echo "✗ tar 内未找到 biliup 二进制" >&2; rm -rf "$tmp"; exit 1; }
mv "$bin" "$out"
chmod +x "$out"
rm -rf "$tmp"
[ "$os" = "Darwin" ] && xattr -d com.apple.quarantine "$out" 2>/dev/null || true

echo "✓ 已安装: $out"
"$out" --version 2>/dev/null || true
case "$DEST" in
  /usr/local/bin|/usr/bin) echo "已在 PATH,可直接 biliup 调用。" ;;
  *) echo "提示: upload skill 默认找 PATH 上的 biliup;要用这个就把 $DEST 加进 PATH,或在 skill 里指定路径。" ;;
esac
