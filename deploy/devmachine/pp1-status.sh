#!/usr/bin/env bash
# 看四个服务的进程 / 端口 / 健康状态，以及 GPU 显存占用。
# 只读：不启动、不停止任何东西。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pp1.env
. "$HERE/pp1.env"

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

check_http() {
  # 第三个参数为 1 表示只要 TCP 通（brain 没有根路由）。
  if [ "${3:-0}" = 1 ]; then
    curl -sS --max-time 3 -o /dev/null "http://127.0.0.1:$2/" 2>/dev/null && echo up || echo down
  else
    curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$2$1" 2>/dev/null && echo up || echo down
  fi
}

printf '%-6s %-8s %-6s %-8s %s\n' SVC PID PORT HEALTH CONTAINER
for row in "asr /health $PP1_ASR_PORT 0" "tts /health $PP1_TTS_PORT 0" \
  "chat /v1/models $PP1_CHAT_PORT 0" "brain / $PP1_BRAIN_PORT 1"; do
  set -- $row
  svc="$1" path="$2" port="$3" tcp="$4"
  pid="$(cat "$PP1_RUN_DIR/$svc.pid" 2>/dev/null || true)"
  alive="-"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then alive="$pid"; fi
  state="$(rt ps --filter "name=pp1-$svc" --format '{{.Status}}' 2>/dev/null | head -1 || true)"
  printf '%-6s %-8s %-6s %-8s %s\n' "$svc" "$alive" "$port" "$(check_http "$path" "$port" "$tcp")" "${state:--}"
done

echo
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=index,memory.used,memory.total,utilization.gpu \
    --format=csv,noheader
else
  echo "nvidia-smi 不可用"
fi

echo
echo "日志目录：$PP1_LOG_DIR"
