#!/bin/sh
# dev worker 启动脚本(issue #82):起 sshd + 刷新 dist 软链 + exec node task serve(不带 --hub)。
# 4 处 dev 层必修之一:SshTransport 默认调 `node <dataRoot>/dist/douyin-rec.mjs`,
# 而镜像里程序在 /app/dist,故在数据根建 dist -> /app/dist 软链(每次启动刷新,防镜像更新后指旧程序)。
set -eu
DATA=/output-data
MARK="$DATA/.drec-dev-e2e"

# 防误挂线上数据根:必须有 e2e-verify 在宿主侧写下的标记。
if [ "${DREC_DEV:-}" != "1" ] || [ ! -f "$MARK" ]; then
  echo "[dev-worker] 拒绝启动:$DATA 无 dev 标记(.drec-dev-e2e),疑似挂了非 dev 数据根" >&2
  exit 1
fi
case "$(hostname)" in
  drec-dev*-node-[0-9]*) ;;
  *) echo "[dev-worker] 拒绝启动:主机名 $(hostname) 不是 dev 节点形态" >&2; exit 1 ;;
esac

# dist 软链:若已是真目录/文件则拒绝(不覆盖不明内容)。
if [ -e "$DATA/dist" ] && [ ! -L "$DATA/dist" ]; then
  echo "[dev-worker] 拒绝:$DATA/dist 存在且不是软链" >&2; exit 1
fi
ln -sfn /app/dist "$DATA/dist"

# 假 cookies(节点侧能力探测 cookies=true;内容只有 FAKE-DEV 标记)。
CK="$DATA/config/biliup/cookies.json"
mkdir -p "$(dirname "$CK")"
if [ ! -f "$CK" ]; then
  cat > "$CK" <<'JSON'
{"drec-dev-fake":true,"cookie_info":{"cookies":[{"name":"SESSDATA","value":"FAKE-DEV-SESSDATA"},{"name":"bili_jct","value":"FAKE-DEV-JCT"},{"name":"DedeUserID","value":"0"}]},"token_info":{"access_token":"FAKE-DEV","refresh_token":"FAKE-DEV"}}
JSON
fi

# sshd:主机密钥持久化在数据卷(重启不变 → controller 的 known_hosts 不报警,S4 重启接管要用)。
HK="$DATA/.dev-sshd"
mkdir -p "$HK" /run/sshd /root/.ssh
chmod 700 /root/.ssh
[ -f "$HK/ssh_host_ed25519_key" ] || ssh-keygen -q -t ed25519 -N '' -f "$HK/ssh_host_ed25519_key"
cp /dev-keys/dev_ed25519.pub /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys

# ssh 会话不继承容器 ENV:显式 SetEnv PATH(node 在 /usr/local/bin)与 TZ。
# DEV_SSH_TZ 置空 → 不设 TZ → ssh 会话为 UTC,可复现「隐藏命令 UTC 日期语义」风险(见 docs/dev-multi-node.md §6)。
SSHD_CFG=/etc/ssh/sshd_config.dev
{
  echo "Port 22"
  echo "HostKey $HK/ssh_host_ed25519_key"
  echo "PermitRootLogin prohibit-password"
  echo "PasswordAuthentication no"
  echo "KbdInteractiveAuthentication no"
  echo "PubkeyAuthentication yes"
  echo "UsePAM no"
  echo "StrictModes no"
  echo "PidFile /run/sshd.pid"
  echo "SetEnv PATH=/usr/local/bin:/usr/bin:/bin"
  [ -n "${DEV_SSH_TZ:-}" ] && echo "SetEnv TZ=${DEV_SSH_TZ}"
} > "$SSHD_CFG"
/usr/sbin/sshd -t -f "$SSHD_CFG"
/usr/sbin/sshd -f "$SSHD_CFG"

cd /app
exec "$@"
