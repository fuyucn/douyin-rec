# syntax=docker/dockerfile:1
# douyin-rec 录制服务镜像：Web UI + 定时调度（task serve，调度默认开）。
# 多阶段：builder 装依赖 + 打包 bundle + 构建前端；runtime 只带 node + ffmpeg + 产物。

# ---- builder ----
FROM node:24-bookworm-slim AS builder
RUN npm install -g pnpm@10
WORKDIR /app

# 根依赖（供 esbuild 打包）。pnpm workspace：install 需要全部 packages/*/package.json
# 才能解析 workspace 依赖(@drec/*)+ 装齐第三方(axios/sm-crypto…)，故先拷 packages 再 install。
# (packages/web 被 pnpm-workspace.yaml 的 !packages/web 排除，根 install 不碰它，下面单独装。)
# 注：当前无 pnpm patch（取流/弹幕依赖均已 vendored 进各自包源码），故不再 COPY patches。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile

# 根源码 → 打包单文件 dist/douyin-rec.mjs。
# 版本号:容器内无 .git/git,由 GIT_SHA build-arg 注入(esbuild.config.mjs 读 ENV);
# 部署命令传 --build-arg(见 docker-compose.yml build.args)。未传 → 版本回落 0.0.0-dev。
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA
COPY tsconfig.json esbuild.config.mjs ./
COPY assets ./assets
# configs/hub-config.example.json:esbuild 经 define 内联进 bundle(__HUB_CONFIG_EXAMPLE__),
# 不 COPY 则 `pnpm bundle` 读不到 → ENOENT 构建失败。
COPY configs ./configs
RUN pnpm bundle

# 前端是独立 pnpm 工程（已随 COPY packages 拷入）：在自己目录 install + build。
RUN cd packages/web && pnpm install --frozen-lockfile && pnpm build

# ---- runtime ----
FROM node:24-bookworm-slim AS runtime
# ffmpeg/ffprobe 录制必需；ca-certificates 走 https 拉流/上报；curl 供 install-mesio.sh 下载。
# openssh-client + rsync：docker 当 master 时经 SshTransport ssh/rsync 从 VPS 拉流(走 tailscale sidecar)。
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl openssh-client rsync \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# SSH 到 VPS 用挂载进来的 key(compose 挂 /root/.ssh/vps.key);SshTransport 不带 -i,靠此 config 指定。
# host 用 tailnet IP(经 sidecar 可达);User/Key/免交互全在这。known_hosts 走 /dev/null + accept-new。
RUN mkdir -p /root/.ssh && chmod 700 /root/.ssh && printf '%s\n' \
  'Host 100.97.21.80' \
  '  User ubuntu' \
  '  IdentityFile /root/.ssh/vps.key' \
  '  IdentitiesOnly yes' \
  '  StrictHostKeyChecking accept-new' \
  '  UserKnownHostsFile /dev/null' \
  > /root/.ssh/config && chmod 600 /root/.ssh/config

# mesio 录制引擎(可选 recorder)：build 时按平台拉 linux 二进制到 /app/bin（与本机 ./bin 约定一致，
# 不污染系统 /usr/local/bin）。版本由脚本内 PINNED_VERSION 存档；升级改脚本即可。bookworm=glibc → gnu。
COPY scripts/install-mesio.sh /tmp/install-mesio.sh
RUN MESIO_LIBC=gnu sh /tmp/install-mesio.sh /app/bin && rm /tmp/install-mesio.sh

# 只拷构建产物（bundle 自包含依赖，无需 node_modules）。
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/packages/web/dist ./web/dist
COPY --from=builder /app/assets ./assets

# 单一数据根 /data（compose 挂载卷）→ 内部固定 db/ recordings/ config/。可被 compose env 覆盖。
ENV NODE_ENV=production \
    DOUYIN_REC_STATIC=/app/web/dist \
    DOUYIN_REC_ROOT=/data \
    BILIUP_COOKIE=/data/config/biliup/cookies.json \
    FONTS_DIR=/app/assets/fonts \
    MESIO_PATH=/app/bin/mesio \
    TZ=America/Los_Angeles

EXPOSE 7860

# task serve：Web 控制台(7860) + 定时调度（默认开，按各任务 schedule 本地时区窗口自动启停；
# 无窗口=24h，窗口结束优雅排空、不腰斩直播）。QR 登录需 playwright（镜像未装）→ 用手动粘贴 cookie。
CMD ["node", "dist/douyin-rec.mjs", "task", "serve", "--port", "7860"]
