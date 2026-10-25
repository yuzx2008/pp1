#!/usr/bin/env bash
# 在 zmlp 开发机里把 pp1 的四个服务拉起来。
#
# 为什么需要它：开发机容器是 RestartPolicyNever，没有 systemd/supervisor，
# 机器 stop/start 或 Pod 重建后服务不会自己回来。重启后 SSH 进去跑这一条即可。
#
#   ./pp1-up.sh              # 幂等启动（已在跑且健康就跳过）
#   ./pp1-up.sh --dry-run    # 只打印将要执行的命令，不创建目录、不启动
#   ./pp1-up.sh --only tts   # 只处理一个服务
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=0
ONLY="${PP1_ONLY:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --only) ONLY="${2:?--only 需要服务名}"; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

# shellcheck source=pp1.env
. "$HERE/pp1.env"

case "$ONLY" in
  ""|asr|tts|chat|brain) ;;
  *) echo "--only 只接受 asr / tts / chat / brain，收到: $ONLY" >&2; exit 2 ;;
esac

# 同一张卡上同时跑 asr 和 tts 是设计如此；如果两个变量写相等，chat 会把它们挤爆。
if [ "$PP1_ASR_TTS_GPU" = "$PP1_CHAT_GPU" ]; then
  echo "PP1_ASR_TTS_GPU 和 PP1_CHAT_GPU 相同（$PP1_ASR_TTS_GPU），整卡隔离失效，拒绝启动" >&2
  exit 2
fi

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }

# 删掉日志里可能出现的凭据形态。brain 正常不打印 token，这里是兜底。
redact() {
  sed -E 's/(MIGHT_BRAINS_TOKEN|Authorization|token)([=: ]+)[^[:space:]]+/\1\2***/g'
}

runtime_detect() {
  if [ "$PP1_RUNTIME" != "auto" ]; then
    printf '%s' "$PP1_RUNTIME"
    return
  fi
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    printf 'docker'
    return
  fi
  if command -v nerdctl >/dev/null 2>&1 && nerdctl info >/dev/null 2>&1; then
    printf 'nerdctl'
    return
  fi
  echo "找不到可用的 docker 或 nerdctl（或当前用户无权限）" >&2
  exit 1
}

RT=()
if [ -n "$PP1_RUNTIME_SUDO" ]; then
  RT+=("$PP1_RUNTIME_SUDO")
fi
RT+=("$(runtime_detect)")
rt() { "${RT[@]}" "$@"; }

ensure_dirs() {
  if [ "$DRY_RUN" = 1 ]; then
    return
  fi
  mkdir -p "$PP1_LOG_DIR" "$PP1_SECRET_DIR" \
    "$PP1_DATA/logs/moss" "$PP1_DATA/run/moss" "$PP1_DATA/logs/brain"
}

pid_of() { cat "$PP1_RUN_DIR/$1.pid" 2>/dev/null || true; }

is_running() {
  local pid
  pid="$(pid_of "$1")"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

port_busy() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "( sport = :$1 )" 2>/dev/null | grep -q LISTEN
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
  fi
}

http_ok() { curl -fsS --max-time 5 -o /dev/null "$1" 2>/dev/null; }

brain_ok() {
  # brain 除四个端点外全是 404，用 TCP 连通性判断，不能要求 2xx。
  curl -sS --max-time 3 -o /dev/null "http://127.0.0.1:$PP1_BRAIN_PORT/" 2>/dev/null
}

tail_log() {
  local f="$PP1_LOG_DIR/$1.log"
  [ -f "$f" ] || return 0
  echo "----- $1 日志最后 30 行（已脱敏）-----" >&2
  tail -n 30 "$f" | redact >&2
  echo "------------------------------------" >&2
}

start_one() {
  local name="$1" port="$2"
  shift 2
  local -a cmd=("$@")
  local pidf="$PP1_RUN_DIR/$name.pid" logf="$PP1_LOG_DIR/$name.log"

  if is_running "$name"; then
    log "$name 已在运行（pid $(pid_of "$name")），继续等健康检查"
    return 0
  fi

  # 上次用 kill -9 杀了 docker 客户端时，容器可能还留着；不清掉会撞名字。
  if rt ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "pp1-$name"; then
    log "清理残留容器 pp1-$name"
    [ "$DRY_RUN" = 1 ] || rt rm -f "pp1-$name" >/dev/null 2>&1 || true
  fi

  if [ "$DRY_RUN" = 0 ] && port_busy "$port"; then
    echo "端口 $port 已被占用，但 pp1-$name 没有在跑：可能被别的进程占了" >&2
    exit 1
  fi

  if [ "$DRY_RUN" = 1 ]; then
    # 打印出来的命令要能直接复制执行；token 一律替换成 ***。
    printf '  %s\n' "$(printf '%q ' "${cmd[@]}" | redact)"
    return 0
  fi

  if [ -n "${GPU_OF[$name]:-}" ]; then
    log "启动 $name（GPU ${GPU_OF[$name]}）"
  else
    log "启动 $name"
  fi
  nohup "${cmd[@]}" >>"$logf" 2>&1 &
  echo $! >"$pidf"
  sleep 2
  if ! is_running "$name"; then
    echo "$name 启动后立刻退出" >&2
    tail_log "$name"
    exit 1
  fi
}

wait_ready() {
  local name="$1" timeout="$2" check="$3" url="$4"
  local deadline=$((SECONDS + timeout))
  if [ "$DRY_RUN" = 1 ]; then
    log "[dry-run] 将等待 $name 健康：$url（最多 ${timeout}s）"
    return 0
  fi
  log "等待 $name 就绪（最多 ${timeout}s）"
  while [ "$SECONDS" -lt "$deadline" ]; do
    if "$check" "$url"; then
      log "$name 就绪"
      return 0
    fi
    if ! is_running "$name"; then
      echo "$name 在等待期间退出" >&2
      tail_log "$name"
      exit 1
    fi
    sleep 5
  done
  echo "$name 在 ${timeout}s 内没有就绪" >&2
  tail_log "$name"
  exit 1
}

build_asr() {
  ASR_CMD=("${RT[@]}" run --name pp1-asr --network "$PP1_NETWORK" --gpus all
    -e "CUDA_VISIBLE_DEVICES=$PP1_ASR_TTS_GPU"
    -e "ASR_MODEL=$ASR_MODEL"
    -v "$PP1_WEIGHTS/asr:/models:ro"
    "$PP1_ASR_IMAGE")
}

build_tts() {
  local vars=(
    MOSS_MODELS_DIR MOSS_VOICES_DIR MOSS_DAEMON_SOCK MOSS_LOG_DIR MOSS_LISTEN_PORT
    MOSS_NGL MOSS_MODEL_FILE MOSS_DECODER_FILE MOSS_DAEMONS MOSS_LANGUAGE
    MOSS_AUDIO_TEMPERATURE MOSS_AUDIO_TOP_P MOSS_AUDIO_TOP_K
    MOSS_AUDIO_REPETITION_PENALTY MOSS_STREAM_WINDOW MOSS_STREAM_OVERLAP
    MOSS_STREAM_LOOKAHEAD MOSS_CTX_ROWS MOSS_CTX_KEEP MOSS_PREFILL_UBATCH
    MOSS_PREFILL_BUDGET_MIB MOSS_MAX_INPUT_CHARS MOSS_QUEUE_MAX MOSS_QUEUE_WAIT
    MOSS_LOG_TEXT MOSS_DISABLE_NONSTREAM
  )
  TTS_CMD=("${RT[@]}" run --name pp1-tts --network "$PP1_NETWORK" --gpus all
    -e "CUDA_VISIBLE_DEVICES=$PP1_ASR_TTS_GPU"
    -v "$PP1_WEIGHTS/tts:/models:ro"
    -v "$PP1_WEIGHTS/voices:/voices"
    -v "$PP1_DATA/run/moss:/run/moss"
    -v "$PP1_DATA/logs/moss:/var/log/moss")
  if [ -n "$PP1_TTS_USER" ]; then
    TTS_CMD+=(--user "$PP1_TTS_USER")
  fi
  local v
  for v in "${vars[@]}"; do
    TTS_CMD+=(-e "$v=${!v}")
  done
  TTS_CMD+=("$PP1_TTS_IMAGE")
}

build_chat() {
  CHAT_CMD=("${RT[@]}" run --name pp1-chat --network "$PP1_NETWORK" --gpus all
    -e "CUDA_VISIBLE_DEVICES=$PP1_CHAT_GPU"
    -v "$PP1_WEIGHTS/chat:/models:ro"
    -v "$HERE/templates:/templates:ro"
    --entrypoint vllm
    "$PP1_CHAT_IMAGE" serve)
  CHAT_CMD+=("${PP1_CHAT_ARGS[@]}")
}

build_brain() {
  local token=""
  if [ "$PP1_REQUIRE_BRAIN_TOKEN" = 1 ]; then
    if [ "$DRY_RUN" = 1 ]; then
      # dry-run 不读密钥文件，只标记存在性；命令里会显示成 ***。
      token="DRY_RUN"
      [ -s "$PP1_BRAIN_TOKEN_FILE" ] || echo "注意：token 文件不存在（$PP1_BRAIN_TOKEN_FILE）" >&2
    elif [ ! -s "$PP1_BRAIN_TOKEN_FILE" ]; then
      echo "缺少 brain token 文件：$PP1_BRAIN_TOKEN_FILE" >&2
      echo "创建方式：mkdir -p '$(dirname "$PP1_BRAIN_TOKEN_FILE")' && openssl rand -hex 24 > '$PP1_BRAIN_TOKEN_FILE' && chmod 600 '$PP1_BRAIN_TOKEN_FILE'" >&2
      exit 1
    else
      token="$(cat "$PP1_BRAIN_TOKEN_FILE")"
    fi
  fi
  BRAIN_CMD=("${RT[@]}" run --name pp1-brain --network "$PP1_NETWORK"
    -e "MIGHT_BRAINS_PORT=$MIGHT_BRAINS_PORT"
    -e "MIGHT_BRAINS_POLL_TIMEOUT_MS=$MIGHT_BRAINS_POLL_TIMEOUT_MS"
    -e "MIGHT_LOG_LLM=$MIGHT_LOG_LLM"
    -e "STT_API_BASE_URL=$STT_API_BASE_URL"
    -e "STT_API_KEY=$STT_API_KEY"
    -e "STT_MODEL=$STT_MODEL"
    -e "TTS_API_BASE_URL=$TTS_API_BASE_URL"
    -e "TTS_API_KEY=$TTS_API_KEY"
    -e "TTS_VOICE=$TTS_VOICE"
    -e "MIGHT_CHAT_API_BASE_URL=$MIGHT_CHAT_API_BASE_URL"
    -e "MIGHT_CHAT_API_KEY=$MIGHT_CHAT_API_KEY"
    -e "MIGHT_CHAT_MODEL=$MIGHT_CHAT_MODEL"
    -v "$PP1_DATA/logs/brain:/app/logs")
  if [ -n "$token" ]; then
    BRAIN_CMD+=(-e "MIGHT_BRAINS_TOKEN=$token")
  fi
  BRAIN_CMD+=("$PP1_BRAIN_IMAGE")
}

declare -A GPU_OF=([asr]="$PP1_ASR_TTS_GPU" [tts]="$PP1_ASR_TTS_GPU" [chat]="$PP1_CHAT_GPU")

wanted() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

ensure_dirs

# 顺序有意义：先起后端，最后起 brain；brain 一起来就会登录 agent 队列。
if wanted asr; then
  build_asr
  start_one asr "$PP1_ASR_PORT" "${ASR_CMD[@]}"
  wait_ready asr "$PP1_ASR_TIMEOUT" http_ok "http://127.0.0.1:$PP1_ASR_PORT/health"
fi

if wanted tts; then
  build_tts
  start_one tts "$PP1_TTS_PORT" "${TTS_CMD[@]}"
  wait_ready tts "$PP1_TTS_TIMEOUT" http_ok "http://127.0.0.1:$PP1_TTS_PORT/health"
fi

if wanted chat; then
  build_chat
  start_one chat "$PP1_CHAT_PORT" "${CHAT_CMD[@]}"
  wait_ready chat "$PP1_CHAT_TIMEOUT" http_ok "http://127.0.0.1:$PP1_CHAT_PORT/v1/models"
fi

if wanted brain; then
  build_brain
  start_one brain "$PP1_BRAIN_PORT" "${BRAIN_CMD[@]}"
  wait_ready brain "$PP1_BRAIN_TIMEOUT" brain_ok "http://127.0.0.1:$PP1_BRAIN_PORT/"
fi

if [ "$DRY_RUN" = 0 ]; then
  log "全部完成；状态见 ./pp1-status.sh"
fi
