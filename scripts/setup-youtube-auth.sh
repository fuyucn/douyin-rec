#!/usr/bin/env sh
# setup-youtube-auth.sh — 跑一次 YouTube OAuth 授权,生成 <root>/config/youtube/request.token。
#
# 流程:
#   1. 检查 youtubeuploader 二进制(默认 ./bin/youtubeuploader,或 PATH)。
#   2. 确认 client_secrets.json 在 <root>/config/youtube/(可按 root 覆盖)。
#   3. 用 ffmpeg 生成 1s 测试 mp4,跑一次 private 上传;成功后 OAuth token 落到 request.token。
#   4. 浏览器会自动打开到 Google 授权页,登录完成后可回到终端。
#
# 常用：
#   pnpm youtubeuploader:install
#   DOUYIN_REC_ROOT=./output-data sh scripts/setup-youtube-auth.sh
# 远端部署:
#   把本地同一份 client_secrets.json + request.token 复制到 <远端 root>/config/youtube/ 即可。
set -eu

ROOT="${DOUYIN_REC_ROOT:-./output-data}"
CFG_DIR="$ROOT/config/youtube"
SECRETS="${YOUTUBE_CLIENT_SECRETS:-$CFG_DIR/client_secrets.json}"
TOKEN="${YOUTUBE_REQUEST_TOKEN:-$CFG_DIR/request.token}"
BIN="${YOUTUBEUPLOADER_BIN:-}"

if [ -z "$BIN" ]; then
  if [ -x "./bin/youtubeuploader" ]; then BIN="./bin/youtubeuploader";
  else BIN="youtubeuploader"; fi
fi

[ -x "$BIN" ] || { echo "✗ youtubeuploader 未安装;先跑 pnpm youtubeuploader:install"; exit 1; }
[ -f "$SECRETS" ] || { echo "✗ client_secrets.json 不存在: $SECRETS"; exit 1; }
command -v ffmpeg >/dev/null 2>&1 || { echo "✗ ffmpeg 未安装(生成测试视频需要)"; exit 1; }

mkdir -p "$CFG_DIR"
TEST_MP4="$CFG_DIR/auth-test.mp4"

echo "生成 1s 测试视频: $TEST_MP4"
ffmpeg -y -v error -f lavfi -i testsrc=duration=1:size=160x90:rate=1 -pix_fmt yuv420p "$TEST_MP4"

echo "开始 OAuth 授权;浏览器会打开 Google 登录页。"
echo "本次会以 private 上传 1 条 1s 测试视频,用于生成 token。"
"$BIN" -filename "$TEST_MP4" \
  -secrets "$SECRETS" -cache "$TOKEN" \
  -title "douyin-rec auth bootstrap" \
  -description "temporary oauth bootstrap video; safe to delete after setup" \
  -privacy private -notify false -sendFilename false -quiet

rm -f "$TEST_MP4"
echo "✓ OAuth 完成: $TOKEN"
echo "把下面两个文件复制到远端/VPS 的 config/youtube/ 即可:"
echo "  $SECRETS"
echo "  $TOKEN"
