# pp1 — all-in-one voice-assistant backend

Self-hosted **speech-to-text + text-to-speech + brain server** for the
[PP Friend](https://github.com/thautwarm/pp-friend) voice assistant, wired together
and started with a single compose file.

```
 phone / agent                         ┌──────────────────────────────┐
   │  MessagePack + Ogg Opus           │  brain  (pp-brain-server)    │
   └──────────────────────────────────▶│  :8787                       │
                                       │   ├─ STT ─▶ asr   :8082      │
                                       │   ├─ TTS ─▶ tts   :6677      │
                                       │   └─ revise ▶ chat (external) │
                                       └──────────────────────────────┘
```

| Component | What it is | VRAM |
| --- | --- | --- |
| **asr** | [Qwen3-ASR-1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B), OpenAI-compatible `/v1/audio/transcriptions` | ~5 GB |
| **tts** | [moss-tts-windowed](https://github.com/thautwarm/moss-tts-windowed) — MOSS-TTS 8B, resident, streaming Ogg/Opus | ~6.8 GB per daemon |
| **brains** | [pp-brain-server](https://github.com/thautwarm/pp-brain-server) — the Brain API the app talks to | — |

The brain also needs a **chat endpoint** for its background revision pass. That is
deployment configuration, not part of pp1: the endpoint must natively accept audio
input (see [Chat endpoint](#chat-endpoint-required)).

---

## Requirements

| | |
| --- | --- |
| GPU | NVIDIA, ≥ 12 GB for STT + TTS (the chat endpoint can run elsewhere) |
| Disk | ~35 GB (weights ~14 GB, images ~20 GB) |
| Host | Linux (or WSL2). Docker + [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) |
| Build | `bash` is used for the TTS build (present on Linux/macOS/WSL) |

The TTS service keeps one model resident per daemon: one daemon is enough for
real-time speech (RTF ≈ 0.2); two or three let several conversations synthesize
in parallel. `onboard` picks a count from the VRAM it finds.

## Quick start

```bash
git clone https://github.com/thautwarm/pp1
cd pp1

# 1. grab the setup binary for your platform (or skip it and use Deno below)
curl -L -o pp1-setup-linux-x64 \
  https://github.com/thautwarm/pp1/releases/download/v0.1.0/pp1-setup-linux-x64
chmod +x pp1-setup-linux-x64
#    no binary? deno run -A scripts/onboard.ts all

# 2. check the machine, download weights, build images, write .env
./pp1-setup-linux-x64 all

# 3. start STT + TTS + brain
docker compose up -d

# 4. verify end to end
./pp1-setup-linux-x64 smoke
```

`all` is idempotent: downloads are checksum-verified and skipped when complete,
`.env` keeps edits you made, image builds are cached.

Then create a profile in the PP Friend app:

* **Brain URL** — `http://<host>:8787`
* **Brain ID** — `hw` (any name; the server creates it on first use)

Point an agent at the same brain ID and the loop is complete: speak → transcript →
agent text → speech.

## Ports

| Service | Host port | Endpoint |
| --- | --- | --- |
| brain | 8787 | `POST /human-to-brain`, `/brain-to-human`, `/agent-to-brain`, `/brain-to-agent` |
| TTS | 6677 | `GET /health`, `POST /v1/audio/speech/stream` |
| ASR | 8082 | `GET /health`, `POST /v1/audio/transcriptions` |

Ports live in `.env` (`PP1_*_PORT`); the compose network addresses used by the
brain are `http://asr:8082/v1` and `http://tts:8080/v1`.

## Commands

```
pp1-setup <command>          # or: deno run -A scripts/onboard.ts <command>

  all        doctor + fetch + env + build (default)
  doctor     docker / GPU / compute cap / disk checks
  components clone/update the pinned component checkouts
  models     download TTS / ASR weights
  images     build asr / tts / brain images
  env        write/update .env
  fetch      components + models
  build      images
  dist       cross-compile pp1-setup-{os}-{arch}
  up         docker compose up -d
  down       docker compose down
  status     container state + HTTP probes
  smoke      end-to-end: TTS, STT, brain
```

Useful flags: `--hf-endpoint https://hf-mirror.com` (or set `HF_ENDPOINT`),
`--source modelscope` for the ASR weights, `--daemons N` to change TTS parallelism.
`--chat-base-url` / `--chat-api-key` / `--chat-model` set the required chat endpoint.

Prebuilt `pp1-setup-{linux,darwin,windows}-{x64,arm64}` binaries are attached to
[releases](https://github.com/thautwarm/pp1/releases). They are self-contained —
run them in the repository root.

## Voices

`male-fun` is a synthetic voice (Qwen TTS voice design), included as a demo.
Add your own reference audio:

```bash
curl -X POST http://127.0.0.1:6677/api/v1/voices \
  -F voice=alice -F file=@alice.wav
```

The service stores `voices/alice.wav` plus a precomputed `.codes.bin`. Use it with
`{"voice": "alice"}` on the stream endpoint, or change the default in `.env`
(`TTS_VOICE`).

## Configuration

Everything is in `.env` (see [.env.example](.env.example)). The ones you are most
likely to touch:

| Key | Meaning |
| --- | --- |
| `MOSS_DAEMONS` | resident TTS workers; each ≈ 6.8 GB VRAM |
| `MOSS_LANGUAGE` | TTS language hint (`zh`, `en`, …) |
| `TTS_VOICE` | default voice for messages without `x-brain-voice` |
| `MIGHT_CHAT_API_BASE_URL` / `_KEY` / `_MODEL` | **required** audio-capable chat endpoint (see below) |
| `MIGHT_BRAINS_TOKEN` | bearer token for the brain API; empty = auth off |
| `MIGHT_LOG_LLM` | `1` = dump LLM requests/responses to `logs/brains/` (contains conversation text) |

### Chat endpoint (required)

The brain runs an **asynchronous ASR revision** in the background: every three
history writes it sends the most recent audio clips (up to 7) together with their
transcripts to the chat model. If the model thinks a transcript may have misled
the agent, it calls the `notify(warning)` tool; the brain wraps the result in
`<asr-warning>…</asr-warning>` and puts it on the agent queue, where the agent
picks it up via `/brain-to-agent` and can correct its later work. Nothing is
spoken to the user, and the phone never sees the warning.

Because the model compares the audio with what was transcribed, the endpoint
**must natively accept audio input** (`input_audio` parts, base64 Ogg/Opus) — a
text-only model receives the request but rejects the audio part.

`pp1` deliberately does not bundle one; point it at whatever you already run:

```bash
pp1-setup env --chat-base-url https://api.example.com/v1 \
              --chat-api-key sk-... --chat-model qwen-omni
pp1-setup up
```

Suitable deployments include Qwen2.5-Omni, Voxtral, Gemini and GPT-4o-audio, or
your own vLLM/SGLang endpoint serving an audio model. The key must be non-empty
even when the endpoint has no auth; `onboard` writes the placeholder `none` in
that case.

## Troubleshooting

**`CUDA error: no kernel image is available for execution on the device`** — the
daemon was compiled for another architecture. `onboard` reads
`nvidia-smi --query-gpu=compute_cap` and passes `CUDA_ARCH`; re-run
`pp1-setup build` if you changed GPUs.

**Downloads are slow** — use a HuggingFace mirror
(`--hf-endpoint https://hf-mirror.com`) or `--source modelscope` (fast in CN).
ASR weights are also on ModelScope under the same id.

**The first TTS request takes 2–3 s** — that is the CUDA graph build per daemon;
subsequent requests are first-byte ≈ 0.6 s.

**Ports are taken** — `--tts-port 16677` etc. (also updates `.env`).

**No NVIDIA GPU** — the stack targets CUDA. macOS builds of `pp1-setup` can fetch
and configure, but TTS/ASR need a Linux GPU host.

## Development

```sh
deno task check                          # type-check scripts/onboard.ts
deno run -A scripts/onboard.ts dist      # cross-compile dist/pp1-setup-{os}-{arch}
```

The whole setup is a [nomake](https://github.com/thautwarm/nomake) dependency graph
defined in `scripts/onboard.ts`: resources (`components`, `models`), `images`,
`env`, the `all` aggregate, and one `deno compile` target per platform for `dist`.
nomake is imported by URL, so no installation is needed — `deno run -A
scripts/onboard.ts <target>` is enough, and `pp1-setup <target>` is the same file
compiled.

## Layout

```
docker-compose.yml        three services, one network
docker/asr/               Qwen3-ASR server (OpenAI-compatible)
scripts/onboard.ts        the setup tool (Deno, single file)
build.ts                  nomake makefile: pp1-setup-* binaries
voices/                   demo voice + your references
models/                   downloaded weights (gitignored)
.components/              pinned checkouts of tts / brain (gitignored)
```

## Security

The brain is a personal/home service: state is in memory, there is no tenancy or
hardening. Run it on a trusted LAN or behind a VPN; keep the ports off the public
internet. `MIGHT_BRAINS_TOKEN` adds a bearer check to all four endpoints.

## Licenses

pp1 itself is MIT. The container images and weights carry their own licenses:
Qwen3-ASR is Apache-2.0; MOSS-TTS weights and
moss-tts-windowed are covered by their upstream repositories — check them before
commercial use.
