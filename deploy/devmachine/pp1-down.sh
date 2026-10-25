#!/usr/bin/env bash
# 停掉 pp1 的四个服务。默认全停；--keep-chat 保留 chat（调 asr/tts 时不用重载 22GB 权重）。
#
# 停止顺序：brain 先停，避免它继续往已经关掉的 STT/TTS 发请求。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEEP_CHAT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --keep-chat) KEEP_CHAT=1 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

# shellcheck source=pp1.env
. "$HERE/pp1.env"

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }

RT=()
if [ -n "$PP1_RUNTIME_SUDO" ]; then
  RT+=("$PP1_RUNTIME_SUDO")
fi
if [ "$PP1_RUNTIME" = "auto" ]; then
  if command -v docker >/dev/null 2>&1; then RT+=(docker); else RT+=(nerdctl); fi
else
  RT+=("$PP1_RUNTIME")
fi
rt() { "${RT[@]}" "$@"; }

stop_one() {
  local name="$1"
  local pidf="$PP1_RUN_DIR/$name.pid"
  local pid=""
  pid="$(cat "$pidf" 2>/dev/null || true)"

  if rt ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "pp1-$name"; then
    # SIGTERM（容器内 1 号进程）→ 最多等 20s → SIGKILL。
    log "停止 $name"
    rt stop -t 20 "pp1-$name" >/dev/null 2>&1 || rt kill "pp1-$name" >/dev/null 2>&1 || true
  fi
  # 清理挂着的 docker/nerdctl 客户端进程（nohup 的那个）。
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    local i
    for i in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$pidf"
}

for svc in brain chat tts asr; do
  if [ "$svc" = chat ] && [ "$KEEP_CHAT" = 1 ]; then
    log "保留 chat"
    continue
  fi
  stop_one "$svc"
done

log "已停止"
