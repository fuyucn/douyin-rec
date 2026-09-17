# Worker 安装

worker 是 Linux 录制节点：运行 `task serve`，接收 master 下发的受管任务并录制。

## 边界

安装器只负责：

- 安装 `dist/douyin-rec.mjs` 和 `mesio`
- 生成 systemd service
- 可选安装 Tailscale 或 cloudflared 客户端

安装器不负责：

- 生成、复制或保存 SSH key
- 执行 `tailscale up`、`cloudflared login`
- 管理 Tailscale ACL、Cloudflare Access、防火墙或 VPN
- 在配置或数据库中保存 Secret

network 和认证由用户现有基础设施负责。drec master 只保存可达的 SSH endpoint。

## 前置条件

- Linux + systemd
- Node.js 24+
- `ffmpeg` / `ffprobe`
- worker 能被 master 通过 SSH 访问；可达方式可以是公网 SSH、LAN、WireGuard、Tailscale 或其他 tunnel

Debian / Ubuntu 示例：

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg
```

## 安装

发布版本：

```bash
curl -fsSL https://github.com/fuyucn/douyin-rec/releases/latest/download/install-worker.sh \
  | sudo sh
```

默认安装 GitHub 最新 Release。需要复现或固定版本时传
`--version x.y.z`。

默认安装位置是 `/srv/drec`，service 名为 `drec-worker`，只监听
`127.0.0.1:7860`。SSH 登录用户默认继承 `sudo` 调用者，确保 master 通过 SSH
执行隐藏命令时和 service 使用同一个数据根权限。

可选参数：

```text
--root <dir>            数据根与安装目录
--version <x.y.z>       固定发布版本（默认 latest）
--port <n>              监听端口
--host <host>           监听地址
--user <name>           service 运行用户
--service <name>        systemd service 名
--tunnel <mode>         none|tailscale|cloudflared
--archive <path|url>    本地或私有镜像中的 worker tar.gz
--tz <name>             时区
--no-start              只安装，不启动
--dry-run               检查参数和归档，不写系统
```

## Tunnel

`--tunnel none`

安装器不碰网络。适合公网 SSH、LAN、Tailscale/WireGuard 已由用户配置好的场景。

`--tunnel tailscale`

缺少 Tailscale 时安装客户端，但不会登录：

```bash
sudo tailscale up
sudo tailscale status
```

master 使用 tailnet 主机名：

```json
{
  "id": "vps1",
  "kind": "ssh",
  "host": "drec-vps",
  "dataRoot": "/srv/drec"
}
```

`--tunnel cloudflared`

缺少 cloudflared 时安装客户端，但不会创建或登录 tunnel：

```bash
cloudflared tunnel login
cloudflared tunnel run <tunnel-name>
```

master 侧通过用户自己的 `~/.ssh/config` 使用 tunnel：

```sshconfig
Host drec-vps
  HostName drec-vps.example.com
  User ubuntu
  ProxyCommand cloudflared access ssh --hostname %h
```

## Master 配置

drec 不知道 key/token，只调用 SSH alias：

```json
{
  "id": "vps1",
  "name": "香港 VPS",
  "kind": "ssh",
  "host": "drec-vps",
  "dataRoot": "/srv/drec"
}
```

在 master 的 `~/.ssh/config` 中配置认证：

```sshconfig
Host drec-vps
  HostName 203.0.113.10
  User ubuntu
  IdentityFile ~/.ssh/drec_vps
```

连通性检查：

```bash
ssh drec-vps -- node /srv/drec/dist/douyin-rec.mjs _tasks /srv/drec
```

## 运维

```bash
sudo systemctl status drec-worker
sudo journalctl -u drec-worker -f
curl -fsS http://127.0.0.1:7860/api/version
```

升级 worker 时重新运行 install 命令即可。安装器会更新 bundle、mesio 和
systemd 配置，但不会修改 SSH、Tailscale、Cloudflare 或任何用户凭据。

## 发布

发布 tag `vX.Y.Z` 时，GitHub Actions 会构建：

```text
douyin-rec-worker-linux-amd64.tar.gz
douyin-rec-worker-linux-arm64.tar.gz
```

本地构建：

```bash
pnpm bundle
scripts/build-worker-release.sh --version 0.0.9 --arch all
```
