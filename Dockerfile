# syntax=docker/dockerfile:1
# douyin-rec 录制服务镜像：Web UI + 定时调度（task serve，调度默认开）。
# 多阶段：builder 装依赖 + 打包 bundle + 构建前端；runtime 只带 node + ffmpeg + 产物。

# ---- builder ----
FROM node:24-bookworm-slim AS builder
WORKDIR /app
# pnpm 版本只在 root package.json 的 packageManager 字段声明一处（CI 也读它），corepack 按需取用。
# 非 TTY 下必须关掉 corepack 的下载确认提示，否则它会直接报错退出。
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# 根依赖（供 esbuild 打包）。pnpm workspace：install 需要全部 packages/*/package.json
# 才能解析 workspace 依赖(@drec/*)+ 装齐第三方(axios/sm-crypto…)。
# **只拷清单，源码在 install 之后再拷** —— 否则改一行源码就让 pnpm install 这层失效，
# 每次 rebuild 都要重装依赖并产出新的 ~2GB 层（持续开发空间越用越大、构建越来越慢）。
# --parents 保留 packages/<pkg>/ 目录结构（需要 Dockerfile frontend 1.7+，见首行 syntax）。
# 注：当前无 pnpm patch（取流/弹幕依赖均已 vendored 进各自包源码），故不再 COPY patches。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --parents packages/*/package.json ./
RUN corepack install && pnpm install --frozen-lockfile

# ---- 源码（下面的改动只影响这些层）----
COPY packages ./packages
# 根源码 → 打包单文件 dist/douyin-rec.mjs。
# 版本号:容器内无 .git/git,由 GIT_SHA build-arg 注入(esbuild.config.mjs 读 ENV);
# 部署命令传 --build-arg(见 docker-compose.yml build.args)。未传 → 版本回落 0.0.0-dev。
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA
COPY tsconfig.json esbuild.config.mjs ./
COPY assets ./assets
# configs/hub.config.example.json:esbuild 经 define 内联进 bundle(__HUB_CONFIG_EXAMPLE__),
# 不 COPY 则 `pnpm bundle` 读不到 → ENOENT 构建失败。
COPY configs ./configs
RUN pnpm bundle

# 前端是独立 pnpm 工程(自带 lockfile,被 workspace 排除):源码随上面的 COPY 拷入后
# install + build。web 的依赖量远小于根依赖,不额外拆层(拆开会让 node_modules 跨层丢失)。
RUN cd packages/web && pnpm install --frozen-lockfile && pnpm build

# ---- runtime ----
FROM node:24-bookworm-slim AS runtime
# IMAGE_ROLE=worker 的纯录制节点不装 master 专属件(playwright/biliup/ssh/中文字体)，镜像可显著变小。
ARG IMAGE_ROLE=master
# ffmpeg/ffprobe 录制必需；ca-certificates 走 https 拉流/上报；curl 供 install-mesio.sh 下载。
# openssh-client + rsync：docker 当 master 时经 SshTransport ssh/rsync 从 VPS 拉流(走 tailscale sidecar)。
# fonts-noto-cjk：烧字幕(burn danmu/livechat)的 ASS 字体名 = "Noto Sans CJK SC",镜像无 CJK 字体
#   则 libass 回落到无中文字形的字体 → 中文乱码。装上它 fontconfig 才能解析出真字体。
RUN apt-get update \
 && if [ "$IMAGE_ROLE" = "master" ]; then \
      apt-get install -y --no-install-recommends ffmpeg ca-certificates curl openssh-client rsync xz-utils fonts-noto-cjk; \
    else \
      apt-get install -y --no-install-recommends ffmpeg ca-certificates curl xz-utils; \
    fi \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# SSH 到 VPS 用挂载进来的 key(compose 挂 /root/.ssh/vps.key);SshTransport 不带 -i,靠此 config 指定。
# host 用 tailnet IP(经 sidecar 可达);User/Key/免交互全在这。known_hosts 走 /dev/null + accept-new。
RUN if [ "$IMAGE_ROLE" = "master" ]; then \
      mkdir -p /root/.ssh && chmod 700 /root/.ssh && printf '%s\n' \
        'Host 100.97.21.80' \
        '  User ubuntu' \
        '  IdentityFile /root/.ssh/vps.key' \
        '  IdentitiesOnly yes' \
        '  StrictHostKeyChecking accept-new' \
        '  UserKnownHostsFile /dev/null' \
        > /root/.ssh/config && chmod 600 /root/.ssh/config; \
    fi

# mesio 录制引擎(可选 recorder)：build 时按平台拉 linux 二进制到 /app/bin（与本机 ./bin 约定一致，
# 不污染系统 /usr/local/bin）。版本由脚本内 PINNED_VERSION 存档；升级改脚本即可。bookworm=glibc → gnu。
COPY scripts/install-mesio.sh /tmp/install-mesio.sh
RUN MESIO_LIBC=gnu sh /tmp/install-mesio.sh /app/bin && rm /tmp/install-mesio.sh

# biliup:docker 当 master 时 auto-private 上传用(orchestrator runBiliup spawn 裸 "biliup")。
# 装到 /usr/local/bin 上 PATH;cookies 走挂载卷 /output-data/config/biliup/cookies.json(BILIUP_COOKIE env)。
COPY scripts/install-biliup.sh /tmp/install-biliup.sh
RUN if [ "$IMAGE_ROLE" = "master" ]; then BILIUP_LIBC=gnu sh /tmp/install-biliup.sh /usr/local/bin; fi \
 && rm /tmp/install-biliup.sh

# playwright + chromium:抖音扫码登录(qr-login.ts 动态 import("playwright"))唯一依赖。
# bundle 把 playwright 标 external,故运行时必须有真模块:装进 /app/node_modules
# (dist/douyin-rec.mjs 在 /app/dist → node 向上找到 /app/node_modules,能解析裸 "playwright")。
# 浏览器落 /root/.cache/ms-playwright;--with-deps 顺带装 chromium 的系统库。
# 版本与根 package.json 对齐(playwright ^1.60.0):npm 包与浏览器构建号必须同版本。
#
# --only-shell(= 只装 headless_shell,不装完整版 chromium):
#   playwright 1.60 的 `headless:true` 默认用 chromium_headless_shell;完整版 chromium 只在
#   headless:false / channel 指定时用。我们的扫码登录**恒为 headless**(qr-login.ts `headless ?? true`)。
#   实测(2026-10-05):仅保留 headless_shell(移走完整版)后,扫码登录仍能正常加载抖音页面、
#   跑通反爬 JS(webmssdk)、提取出二维码 PNG。省 ~620MB。
#   playwright 自带的 ffmpeg(录屏用,我们不用系统外的那份)一并删除,再省 ~3MB。
# 代价:如需 headed 调试(本地开发机,非本镜像)再装完整版。不想要 playwright 则删这两行,
#       扫码登录回落「本地扫 + 手动粘贴 cookie」。
ARG PLAYWRIGHT_VERSION=1.60.0
RUN if [ "$IMAGE_ROLE" = "master" ]; then \
      npm install --no-save --no-package-lock playwright@${PLAYWRIGHT_VERSION} \
      && npx --yes playwright@${PLAYWRIGHT_VERSION} install --with-deps --only-shell chromium \
      && rm -rf /root/.cache/ms-playwright/ffmpeg-* \
      && apt-get purge -y --auto-remove fonts-unifont fonts-ipafont-gothic \
      && npm cache clean --force; \
    fi \
 && rm -rf /var/lib/apt/lists/*

# 只拷构建产物（bundle 自包含依赖，无需 node_modules）。
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/packages/web/dist ./web/dist
COPY --from=builder /app/assets ./assets

# 单一数据根 /output-data（compose 挂载卷，与代码默认根 DEFAULT_ROOT 同名）→ 内部固定 db/ recordings/ config/。
# 可被 compose env 覆盖。
ENV NODE_ENV=production \
    DOUYIN_REC_STATIC=/app/web/dist \
    DOUYIN_REC_ROOT=/output-data \
    BILIUP_COOKIE=/output-data/config/biliup/cookies.json \
    FONTS_DIR=/app/assets/fonts \
    MESIO_PATH=/app/bin/mesio \
    TZ=Asia/Shanghai

EXPOSE 7860

# task serve：Web 控制台(7860) + 定时调度（默认开，按各任务 schedule 本地时区窗口自动启停；
# 无窗口=24h，窗口结束优雅排空、不腰斩直播）。QR 扫码登录可用（镜像内含 playwright+chromium）。
CMD ["node", "dist/douyin-rec.mjs", "task", "serve", "--port", "7860"]
