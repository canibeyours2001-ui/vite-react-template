# Qwen Image 2.1 on Kaggle → Hono Telegram (research prototype)

## Architecture

Telegram command → Hono webhook → D1 job queue → minute cron → private Kaggle GPU kernel → ComfyUI Qwen-Image-2.1 GGUF Q4_K_M + Viggle Turbo r256 6-step → Kaggle PNG output → Telegram sendDocument.

The Hono Worker reuses existing secrets/bindings: `KAGGLE_API_TOKEN`, `TELEGRAM_BOT_TOKEN`, `MEMORY_DB`. No API keys are stored in this repository or sent to Kaggle. Kaggle is a batch GPU runner, not an always-on API. One image requires one new kernel execution; first setup/model downloads add latency.

## Telegram commands

- `/qwenimage A detailed image prompt`
- `/qwenimage --size=768 A detailed image prompt`
- `/qwenimage_status`
- `/qwenimage_help`

Allowed sizes: 512, 768, 1024 square. One active job per chat. One Kaggle job at a time across the existing VSR, Vox, pyVideoTrans and Qwen queues. Ambiguous submissions/deliveries are not automatically retried.

## Model settings

- Uncensored Qwen-Image-2.1 GGUF Q4_K_M; SHA-256 verified.
- Qwen3-VL 8B INT8 ConvRot text encoder.
- Qwen Image 2.1 BF16 VAE, CPU offload.
- Viggle Turbo v0.3 six-step r256 LoRA, strength 1.0.
- Euler + BasicGuider, no CFG, native Viggle sigma schedule.
- Default 1024 × 1024.
- ComfyUI and model cache in `/tmp/qwen-comfy`; only final PNG/report are written to `/kaggle/working`.

The first Kaggle attempt exposed a missing `qwen_image21` entry in vanilla ComfyUI-GGUF's `IMG_ARCH_LIST`. The generator now applies the minimal allowlist patch without renaming architecture metadata. A second run using r128 successfully produced a 1024 × 1024 PNG (1,823,007 bytes); ComfyUI execution took 294.64 seconds. The Space default r256 adapter is being validated in the next run.

## Release gates

1. r256 Kaggle render succeeds and output API returns the PNG.
2. PNG is downloaded and validated.
3. Hono queue submission, polling, and Telegram image delivery are tested end to end.
4. Only then set `QWEN_KAGGLE_ENABLED=1` and deploy. Current flag remains `0`.

## License

Research/evaluation only. The Qwen Research License does not permit commercial use without separate permission. Do not use for paid Hypit or client work without a separate license.
