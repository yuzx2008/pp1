# Qwen3-ASR-1.7B behind an OpenAI-compatible transcription endpoint.
#
#   POST /v1/audio/transcriptions   (multipart/form-data, OpenAI shape)
#   GET  /health
#
# The model is NOT baked into the image: mount a snapshot of
# Qwen/Qwen3-ASR-1.7B at /models/Qwen3-ASR-1.7B (pp1 onboard downloads it).
#
# If PyPI is slow from your network, add `-i https://<mirror>/simple` to the
# second pip install; the torch wheels come from download.pytorch.org.
FROM pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime

# The base image ships cu124 wheels; replace them with cu130 builds.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cu130 \
      torch==2.12.0+cu130 torchaudio==2.11.0+cu130 torchvision==0.27.0+cu130

RUN pip install --no-cache-dir \
      transformers==4.57.6 qwen-asr==0.0.6 \
      fastapi uvicorn python-multipart

WORKDIR /app
COPY server.py /app/server.py
# 预热素材：一段真实语音（本项目 TTS 合成）。server.py 的 _warmup() 会在 uvicorn
# 开始监听之前用它跑一次完整推理，把 13 秒的冷启动开销从「用户第一句话」挪到启动期。
COPY warmup.ogg /app/warmup.ogg

EXPOSE 8082
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8082"]
