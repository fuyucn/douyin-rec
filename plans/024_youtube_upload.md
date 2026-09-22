# 024: YouTube 上传 feature（UAT 后发布）

## 目标

在不改变现有 Docker master / VPS worker 部署的情况下，为项目增加 YouTube 上传能力：

- 可选只传 YouTube，可选 B 站 + YouTube 双平台。
- 上传账号认证信息可以本地拿到后在远端复用。
- 上传、重试、任务台账、通知、Web UI 状态与现有 B 站管线同一套心智模型。
- 开发与 UAT 都在独立 feature branch 完成，确认后再并入发布线。

## 现状与调研

现有 B 站上传封装在 `packages/app/src/upload/biliup.ts`，用独立 `biliup` 二进制 + cookies。
hub pipeline 里 `upload.mode` 目前只有 `stage | upload` 两个状态，`upload` 表示传 B 站。
新增 YouTube 会**向后兼容**：不声明 `upload.destinations` 时保持原行为。

调研过的上传路径：

1. **YouTube Data API v3 + OAuth2（推荐）**
   - 创建 Google Cloud 项目 → 开启 YouTube Data API v3 → 建 OAuth client（Web 型，授权回调 `http://localhost:8080/oauth2callback`）。
   - 本地跑 `youtubeuploader` 或 CLI OAuth 流程拿到 `request.token`（refresh token 缓存），把 `client_secrets.json` + token 复制到 `<root>/config/youtube/`。
   - 上传接口是 `videos.insert` resumable upload，支持私有/非公开/公开，按 Google 配额限制。
   - `porjo/youtubeuploader`（Go，Apache-2.0）已封装 OAuth 回调、token 刷新、分块上传、进度、metaJSON，是成熟工具。
   - 注意：未通过审核的 OAuth 项目上传的视频默认只能私有（Google 2020-07 公告）。用于「保存录像」没问题；若以后要公开，需要走项目审核。

2. **浏览器自动化 / cookie 方案**
   - `fawazahmed0/youtube-uploader`（npm `youtube-videos-uploader`）或自研 Playwright 上传。依赖邮箱密码/Google 登录态，防机器人策略风险高，不适合 VPS 长期无人值守。
   - Auth 稳定性、验证码、双因子都绕不开，不建议作为主路径。

**决策：主路径用 YouTube Data API OAuth2 + `youtubeuploader` 二进制**，理由与 `biliup` 一致：单一二进制、CLI 参数化、断点续传已有现成实现、不把 OAuth 细节塞进我们的包体。

## 认证信息获取

1. 用户创建 Google Cloud 项目（console）。
2. 开启 `YouTube Data API v3`。
3. 创建 OAuth consent screen，把上传账号邮箱加测试用户。
4. 创建 OAuth client，选择 Web application，Redirect URI 填 `http://localhost:8080/oauth2callback`。
5. 下载 `client_secrets.json`，放到 `<root>/config/youtube/client_secrets.json`：
   - Docker master：`docker-data/config/youtube/client_secrets.json`
   - 本地/VPS：`<DOUYIN_REC_ROOT>/config/youtube/client_secrets.json`
6. 在本机（有浏览器）先运行：
   ```bash
   ./bin/youtubeuploader -filename /tmp/placeholder.mp4 -title "auth" \
     -secrets output-data/config/youtube/client_secrets.json \
     -cache output-data/config/youtube/request.token \
     -quiet -privacy private
   ```
   浏览器会打开 Google 授权页；登录上传账号完成授权后，生成 `request.token`。
7. 把 `request.token` 复制到远端同一个 `<root>/config/youtube/request.token`。
8. token 会由 `youtubeuploader` 在服务端自动刷新（缓存文件会更新），远端的 worker 不用打开浏览器。

## 配置设计（向后兼容）

`hub.config.json` / 每房间 `config/hub/{platform}.{roomSlug}.json` 的 `pipeline.upload` 扩展：

```jsonc
{
  "mode": "upload",             // 兼容旧字段：upload = 当作 destinations ["bilibili"]
  "destinations": ["bilibili", "youtube"], // 新增；覆盖 mode 时只按 destinations
  "private": true,              // B 站默认仅自己可见（沿用）
  "youtube": {
    "privacy": "unlisted",      // "private" | "unlisted" | "public"，默认 private
    "description": "",
    "categoryId": "",
    "tags": [],
    "notifySubscribers": false
  }
}
```

- 不写 `destinations`：旧行为不变。
- `destinations` 含 `youtube` 时，额外上传 `merge` 后的 plain mp4 到 YouTube（单视频）。
- B 站分 P 规则不动；YouTube 不承担 danmu/livechat 分 P（避免砍成多个视频），后续可再做。
- 上传成功的 YouTube 视频 ID/URL 放到 `sync_jobs` 台账和通知里，和 B 站 `bv` 并列存储。

## 落地拆解

- [x] feature branch：`codex/youtube-upload`
- [x] Task 1: `scripts/install-youtubeuploader.sh`
- [x] Task 1b: Docker master 镜像预装 `youtubeuploader`，worker installer 加缺失预警
- [x] Task 2: `packages/app/src/upload/youtube.ts`（args builder / run / URL 解析 / 预检）
- [x] Task 3: `@drec/app` 导出 + CLI `upload-youtube` 子命令
- [x] Task 4: `GET /api/youtube/status` + 设置页 YouTube 状态区块
- [x] Task 5: `PipelineCfg.uploadDestinations` + `uploadYoutube` dep + pipeline 接线（`youtube_plain` 节点、`ytId` 台账、恢复不重传）
- [x] Task 6: 配置文档 + settings 文案 + hub 规则弹窗目的地/隐私
- [x] Task 6b: `docs/worker-install.md` 明确 youtubeuploader 是 master 可选依赖
- [ ] Task 7: UAT checklist（见下）

## 不破坏现有部署

- 本轮全部在 `codex/youtube-upload` branch，不 bump 版本。
- 现有 `upload.mode`、`uploadPlain`/`appendGroup`、B 站设置、Web UI 都不改动默认行为。
- 新代码只按新字段/新命令启用；缺失密钥时只影响显式 YouTube 操作。
- Docker/VPS 现有镜像不重启不升级：feature 合并前 keepalive 与日常录制完全不变。

## UAT checklist

- [ ] Google 测试项目上传 private video 成功，URL 可打开且状态 private（需要真凭据）。
- [ ] `upload-youtube --video ... --title ...` 成功返回 `https://youtu.be/<id>`（需要真凭据）。
- [x] 未安装凭据时 `/api/youtube/status` 返回 `ready:false`，设置页显示未就绪。
- [x] 两份凭据文件就位后 `/api/youtube/status` 返回 `ready:true`。
- [x] 缺 `client_secrets.json` 时预检给中文错误。
- [x] 缺 `request.token` 时预检给中文错误(headless/docker 不会误进 OAuth 循环)。
- [x] Docker master 镜像可使用：`docker compose build douyin-rec` 通过；镜像内 `youtubeuploader -version` 输出 `1.25.5`。
- [ ] Docker master 里把 `client_secrets.json`/`request.token` 放入 config/youtube，跑手动 CLI 成功。
- [ ] 房间配置 `destinations: ["youtube"]` 后，收播自动传 YouTube、台账出现 YouTube URL。
- [ ] 房间配置 `destinations: ["bilibili", "youtube"]` 后，B 站分 P 与 YouTube 单视频都成功。
- [ ] 移除 `destinations` 后变回只 B 站/只 stage，行为与 feature 前一致。
- [ ] 发版只在新版本 bump：UAT 通过且用户同意后。
