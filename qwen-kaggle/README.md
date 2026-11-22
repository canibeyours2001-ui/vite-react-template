# Kaggle research image generator for Hono Telegram

Implements Qwen-Image-2.1 Uncensored GGUF Q4_K_M with Viggle Turbo v0.3 LoRA, six steps, Euler sampler and its exact sigma schedule.

This model uses the **Qwen Research License — non-commercial research/evaluation only**. Obtain separate permission for business use.

- Runs as one private Kaggle GPU T4 x2 script per request, not a persistent GPU endpoint.
- Outputs `/kaggle/working/qwen_image21_result.png` and `qwen_image21_result.json`.
- Environment variable: `QWEN_TASK_JSON` with fields `prompt`, `width`, `height`, `seed`.
- Internet is required; first run must download ~16GB of model data and install the dependencies.
- Uses one T4 with CPU low-memory offloading. Dual GPUs do not automatically make a 32GB pool.
- A successful end-to-end GPU render must be observed before enabling the Telegram production job feature.
- This phase supports text-to-image; video and image-edit commands remain untouched.
- Uses ComfyUI, ComfyUI-GGUF, and Viggle Turbo's custom nodes fetched from upstream during the Kaggle run.
