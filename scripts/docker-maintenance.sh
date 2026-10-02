#!/usr/bin/env bash
# Docker / OrbStack 空间维护。
#
# 背景:每次 `docker compose up -d --build` 都会产出新镜像层 + 构建缓存;旧的会变成
# 「悬空镜像(dangling)」,不清理就会持续增长。`docker system prune -a` 能一次清空,
# 但它把**构建缓存也删了** → 下次构建全量重装依赖(慢)。
#
# 默认走保守清理:只删悬空镜像 + 一周前的构建缓存 —— 在用的镜像与近期缓存保留,构建仍然快。
# 需要彻底回收时用 --all(等价于 docker system prune -a,下次构建会全量重来)。
#
# 用法:
#   scripts/docker-maintenance.sh          # 保守(推荐,可定期跑)
#   scripts/docker-maintenance.sh --all    # 激进(空间紧张时)
set -euo pipefail

echo "== before =="
docker system df

if [[ "${1:-}" == "--all" ]]; then
  echo "== 激进清理:未被容器使用的镜像 + 全部构建缓存 =="
  docker image prune -a -f
  docker builder prune -a -f
else
  echo "== 保守清理:悬空镜像 + 一周前的构建缓存 =="
  docker image prune -f
  docker builder prune -f --filter until=168h
fi

echo "== after =="
docker system df
