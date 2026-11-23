# Qwen Image 2.1 on Kaggle → Hono Telegram

## Architecture

Telegram command → Hono webhook → shared D1 Qwen job queue → minute cron → private Kaggle T4 kernel → ComfyUI Qwen-Image-2.1 GGUF Q4_K_M + Viggle Turbo r128 six-step LoRA → Kaggle PNG output → Telegram.

The single-image and batch commands share the existing qwen_image21_jobs table. They do not create a second GPU queue or bypass the scheduler. Only one Kaggle job is submitted at a time across the bot's existing Kaggle workers.

The Worker reuses the existing KAGGLE_API_TOKEN, TELEGRAM_BOT_TOKEN, and MEMORY_DB bindings. No API keys are stored in this repository or sent to Kaggle. Kaggle is a batch GPU runner, not an always-on inference API.

## Telegram commands

- /qwenimage A detailed image prompt — one image, one Kaggle execution.
- /qwenimage --size=768 A detailed image prompt — one image at the selected square size.
- /qwenimage_status — latest Qwen job status.
- /qwenimage_help — single-image help.
- /qwenbatch --size=1024 followed by 2–4 prompts, one prompt per line — one Kaggle execution for the entire batch.
- /qwenbatch_status — latest batch status.
- /qwenbatch_help — batch usage and limits.

Allowed square dimensions: 512, 768, or 1024. The batch limit is four images. A batch is processed sequentially, not as a four-image VRAM batch: ComfyUI and model weights are initialized once, then one image graph is run at a time. When all PNGs are at most 9 MiB each, Telegram receives one media album. Larger files are sent individually as documents. Batch output is capped at 15 MiB per PNG and 40 MiB total for safe Worker delivery.

The one-image and batch jobs share the same D1 queue row format. Batch prompts are stored with a versioned internal prefix; no additional D1 migration is required. Each image receives a deterministic distinct seed derived from the batch seed. /qwenimage remains backward-compatible.

## Model settings

- Uncensored Qwen-Image-2.1 GGUF Q4_K_M; SHA-256 verified.
- Qwen3-VL 8B INT8 ConvRot text encoder.
- Qwen Image 2.1 BF16 VAE, CPU offload.
- Viggle Turbo v0.3 six-step r128 LoRA, strength 1.0.
- Euler + BasicGuider, no CFG, native Viggle sigma schedule.
- Default 1024 × 1024.
- ComfyUI and model cache in /tmp/qwen-comfy; only final PNGs and JSON report are written to /kaggle/working.

The verified single-image r128 T4 render produced a 1024 × 1024 PNG (1,823,007 bytes); ComfyUI execution took 294.64 seconds. The batch implementation keeps the same model graph and loads its weights once per Kaggle execution. Real multi-image T4 runtime and memory use remain to be measured with the first live batch.

## Deployment and verification

QWEN_KAGGLE_ENABLED is already set to 1 in the Worker configuration. This enables the existing single-image backend; it does not mean the new batch code has been deployed or GPU-tested.

Batch verification includes command parsing, D1 queue insertion, Kaggle push payload construction, output-file matching, PNG validation, and Telegram media-album delivery using mocked API responses. A real batch generation is still required to verify Kaggle execution and end-to-end delivery. Do not treat mocked tests as a live GPU test.

## License

Research/evaluation only. The Qwen Research License does not permit commercial use without separate permission. Do not use for paid Hypit or client work without a separate license.
