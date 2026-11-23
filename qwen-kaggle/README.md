# Kaggle Qwen-Image-2.1 research generator

- Base: KasugaiSakura Qwen-Image-2.1 Uncensored GGUF, Q4_K_M (SHA-256 verified)
- Text encoder: Qwen3-VL 8B INT8 ConvRot
- VAE: Qwen Image 2.1 BF16 VAE (CPU decode/offload)
- Adapter: Viggle Turbo v0.3 six-step, **r256** (Space default), strength 1.0
- Sampler: Euler, BasicGuider (no CFG), Viggle raw sigma schedule `1, 0.9375, 0.875, 0.75, 0.5, 0.25`
- Default output: 1024 × 1024 PNG
- ComfyUI checkout and model cache: `/tmp/qwen-comfy` (not included in Kaggle output)
- Result: `/kaggle/working/qwen_image21_result.png` + JSON report

Kaggle runs one private GPU kernel per image. It is not a persistent server. First run downloads several GB and installs ComfyUI; every fresh kernel run may repeat this work. GPU tested on Tesla T4 15.6 GB. A previous r128 test generated a valid 1024×1024 PNG in 294.64 seconds of ComfyUI execution. r256 is the Space default and is being validated separately.

The generator patches only the ComfyUI-GGUF image-architecture allowlist to accept `qwen_image21`, preserving the GGUF metadata so native ComfyUI QwenImage21 model detection works.

Research-only: the Space's Qwen Research License prohibits commercial use without separate permission. Do not use for paid production until licensing is resolved.
