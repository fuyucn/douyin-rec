#!/usr/bin/env bash
# 改根 package.json 的 version(APP_VERSION 单一真相源,见 esbuild.config.mjs)。
# 用法: scripts/bump-version.sh <新版本号>          例: scripts/bump-version.sh 0.0.2
#       scripts/bump-version.sh --patch|--minor|--major   自增对应位

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/package.json"

CURRENT="$(node -p "require('$PKG').version")"

bump_part() {
  local part="$1"
  IFS='.' read -r major minor patch <<< "$CURRENT"
  case "$part" in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "$major.$((minor + 1)).0" ;;
    patch) echo "$major.$minor.$((patch + 1))" ;;
  esac
}

case "${1:-}" in
  "")
    echo "用法: $0 <新版本号 如 0.0.2> | --patch | --minor | --major" >&2
    exit 1
    ;;
  --patch) NEW="$(bump_part patch)" ;;
  --minor) NEW="$(bump_part minor)" ;;
  --major) NEW="$(bump_part major)" ;;
  *)
    if [[ ! "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "版本号格式需为 x.y.z,收到: $1" >&2
      exit 1
    fi
    NEW="$1"
    ;;
esac

node -e "
  const fs = require('fs');
  const p = '$PKG';
  const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
  pkg.version = '$NEW';
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
"

echo "版本号: $CURRENT → $NEW"
echo "下一步: pnpm bundle && cd packages/web && pnpm build,确认后自行 git commit + docker compose up -d --build 部署"
