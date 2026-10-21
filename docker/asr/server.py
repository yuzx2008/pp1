"""Qwen3-ASR-1.7B served over an OpenAI-compatible transcription API.

Endpoints
---------
POST /v1/audio/transcriptions   multipart/form-data (OpenAI Whisper shape)
GET  /health                    readiness (the model is loaded before uvicorn starts)

The model directory is taken from ASR_MODEL (default /models/Qwen3-ASR-1.7B).
"""

from fastapi import FastAPI, Request, UploadFile, File, Form, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from qwen_asr import Qwen3ASRModel
import base64, os, tempfile, time, torch

MODEL = os.getenv("ASR_MODEL", "/models/Qwen3-ASR-1.7B")

LANGUAGE_CODES = {
    "zh": "Chinese", "en": "English", "yue": "Cantonese", "ar": "Arabic",
    "de": "German", "fr": "French", "es": "Spanish", "pt": "Portuguese",
    "id": "Indonesian", "it": "Italian", "ko": "Korean", "ru": "Russian",
    "th": "Thai", "vi": "Vietnamese", "ja": "Japanese", "tr": "Turkish",
    "hi": "Hindi", "ms": "Malay", "nl": "Dutch", "sv": "Swedish",
    "da": "Danish", "fi": "Finnish", "pl": "Polish", "cs": "Czech",
    "fil": "Filipino", "fa": "Persian", "el": "Greek", "ro": "Romanian",
    "hu": "Hungarian", "mk": "Macedonian",
}
LANGUAGE_NAMES = {name.lower(): name for name in LANGUAGE_CODES.values()}


def _resolve_language(value: str | None) -> str | None:
    """Accept ISO-639-1 codes, English names, or anything the model understands."""
    if not value or not value.strip():
        return None
    raw = value.strip()
    key = raw.lower().replace("_", "-")
    base = key.split("-")[0]
    if key in LANGUAGE_NAMES:
        return LANGUAGE_NAMES[key]
    if base in LANGUAGE_NAMES:
        return LANGUAGE_NAMES[base]
    if base in LANGUAGE_CODES:
        return LANGUAGE_CODES[base]
    return raw


print(f"Loading {MODEL} ...", flush=True)
asr_model = Qwen3ASRModel.from_pretrained(
    pretrained_model_name_or_path=MODEL,
    torch_dtype=torch.float16,
    device_map="auto",
)
print("Ready.", flush=True)
# 权重加载完还不算真的就绪：第一次 transcribe 还有一笔一次性开销（见文件末尾的 _warmup）。

app = FastAPI()


@app.middleware("http")
async def log_timing(request: Request, call_next):
    start = time.time()
    response = await call_next(request)
    elapsed = time.time() - start
    print(f"{request.method} {request.url.path} {response.status_code} {elapsed:.3f}s", flush=True)
    return response


class InputAudio(BaseModel):
    data: str
    format: str = "wav"


class TranscriptionRequest(BaseModel):
    model: str | None = None
    input_audio: InputAudio


def _transcribe_file(filepath: str, language: str | None = None, context: str = "") -> str:
    results = asr_model.transcribe(
        audio=filepath,
        context=context or "",
        language=language or None,
    )
    return results[0].text


# 预热输入：随镜像分发的真实语音片段（Ogg Opus，约 5 秒，用本项目自己的 TTS 合成，
# 内容无所谓）。必须用语音而不是现场造的噪声——实测噪声预热只吃掉 13 秒里的 4 秒，
# 剩下 9 秒要等第一次真正跑起解码循环、碰到长输入时才付出，那样它还是会落到用户的
# 第一句话上。
WARMUP_AUDIO = "/app/warmup.ogg"


def _warmup() -> None:
    """在 uvicorn 开始监听之前先跑一次完整推理，把冷启动开销提前付掉。

    实测：权重是在 import 期加载的（上面的 from_pretrained），但**第一次**
    transcribe 还有一整批一次性初始化——transformers 首次 generate、CUDA kernel /
    cuDNN 选择、冷容器里的驱动与页缓存加载，以及第一次真正跑解码循环要占的显存和算子。
    整笔实测 13.3 秒，而 brain 侧的 STT 超时是写死的 13 秒（pp-brain-server
    `apps/brains/src/brain-center.ts`：`AbortSignal.timeout(13000)`），于是 asr 每次
    重启后用户说的第一句话必然被判超时（客户端看到 502），重说一遍才好。

    这里把它挪进启动流程：uvicorn 要等本模块 import 完才开始监听，k8s 又只在
    `/health` 通得过之后才把 pod 置为 Ready，所以预热跑完之前 Service 一直没有
    endpoint——brain 永远打不到冷的 asr。
    """
    if not os.path.exists(WARMUP_AUDIO):
        print(f"Warmup skipped: {WARMUP_AUDIO} 不存在，冷启动后的第一次转写会变慢", flush=True)
        return
    started = time.time()
    try:
        text = _transcribe_file(WARMUP_AUDIO)
        print(f"Warmup done in {time.time() - started:.2f}s (text={text!r})", flush=True)
    except Exception as e:  # 预热失败不值得拦住整个服务，退回未预热的老行为并留下痕迹
        print(f"Warmup FAILED ({type(e).__name__}: {e}); 冷启动后的第一次转写可能再次超时", flush=True)


async def _handle_transcription(
    file: UploadFile,
    language: str | None,
    prompt: str | None,
    response_format: str,
):
    fmt = (response_format or "json").strip().lower()
    if fmt not in ("json", "text"):
        raise HTTPException(
            status_code=400,
            detail=f"unsupported response_format '{response_format}', supported: json, text",
        )
    suffix = os.path.splitext(file.filename or ".wav")[1]
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
    try:
        try:
            text = _transcribe_file(
                tmp.name,
                language=_resolve_language(language),
                context=prompt or "",
            )
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
    finally:
        os.unlink(tmp.name)
    if fmt == "text":
        return PlainTextResponse(text)
    return {"text": text}


@app.post("/v1/audio/transcriptions")
@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    model: str | None = Form(None),
    language: str | None = Form(None),
    prompt: str | None = Form(None),
    response_format: str = Form("json"),
    temperature: float | None = Form(None),
):
    return await _handle_transcription(file, language, prompt, response_format)


@app.post("/audio/transcriptions")
async def audio_transcriptions(req: TranscriptionRequest):
    """Legacy base64 endpoint kept for older clients."""
    suffix = f".{req.input_audio.format.lstrip('.')}"
    raw = base64.b64decode(req.input_audio.data)
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(raw)
    try:
        text = _transcribe_file(tmp.name)
        return {"text": text}
    finally:
        os.unlink(tmp.name)


@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL}


# 必须放在文件末尾：预热要调用上面定义的 _transcribe_file。模块 import 完之前
# uvicorn 不会开始监听，所以这行就是「开始对外服务」之前最后一道动作。
_warmup()
