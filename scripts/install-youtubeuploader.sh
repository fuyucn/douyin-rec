#!/usr/bin/env sh
# install-youtubeuploader.sh — 按本机平台(OS + 架构)下载 porjo/youtubeuploader 独立二进制。
#
# 用法:
#   scripts/install-youtubeuploader.sh [目标目录]   # 默认 ./bin → ./bin/youtubeuploader
#   YOUTUBEUPLOADER_VERSION=v1.25.5 scripts/install-youtubeuploader.sh
#
# 与 install-biliup.sh 同款。youtubeuploader 用于 YouTube Data API 上传(OAuth2 凭据 +
# request.token 缓存),支持 resumable upload 与服务器端 token 刷新。
set -eu

REPO="porjo/youtubeuploader"
PINNED_VERSION="v1.25.5"
VERSION="${YOUTUBEUPLOADER_VERSION:-$PINNED_VERSION}"
DEST="${1:-${YOUTUBEUPLOADER_DEST:-./bin}}"

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin) plat_os="Darwin" ;;
  Linux)  plat_os="Linux" ;;
  *) echo "✗ 不支持的 OS: $os(支持 Darwin / Linux)" >&2; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) plat_arch="arm64" ;;
  x86_64|amd64)  plat_arch="amd64" ;;
  *) echo "✗ 不支持的架构: $arch" >&2; exit 1 ;;
esac

asset="youtubeuploader_${VERSION#v}_${plat_os}_${plat_arch}.tar.gz"
url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
mkdir -p "$DEST"
out="${DEST}/youtubeuploader"
tmp="$(mktemp -d)"

echo "平台: ${os}/${arch} → ${asset} (${VERSION})"
echo "下载 + 解压 → ${out}"
if command -v gh >/dev/null 2>&1; then
  gh release download "$VERSION" --repo "$REPO" --pattern "$asset" --output "$tmp/y.tar.gz" --clobber \
    || curl -fSL "$url" -o "$tmp/y.tar.gz"
elif command -v curl >/dev/null 2>&1; then
  curl -fSL "$url" -o "$tmp/y.tar.gz"
elif command -v wget >/dev/null 2>&1; then
  wget -O "$tmp/y.tar.gz" "$url"
else
  echo "✗ 需要 gh / curl / wget 其中之一" >&2; exit 1
fi

tar xf "$tmp/y.tar.gz" -C "$tmp"
bin="$(find "$tmp" -type f -name youtubeuploader | head -1)"
[ -n "$bin" ] || { echo "✗ tar 内未找到 youtubeuploader 二进制" >&2; rm -rf "$tmp"; exit 1; }
mv "$bin" "$out"
chmod +x "$out"
rm -rf "$tmp"
[ "$os" = "Darwin" ] && xattr -d com.apple.quarantine "$out" 2>/dev/null || true

echo "✓ 已安装: $out"
"$out" -version 2>/dev/null || true
case "$DEST" in
  /usr/local/bin|/usr/bin) echo "已在 PATH,可直接 youtubeuploader 调用。" ;;
  *) echo "提示: CLI 默认找 PATH 上的 youtubeuploader;要用这个就把 $DEST 加进 PATH,或在命令里传 --bin。" ;;
esac
