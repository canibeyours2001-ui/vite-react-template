# Qwen Image 2.1 on Kaggle → Hono Telegram (research prototype)

## Status

- Kaggle GPU test notebook: https://www.kaggle.com/code/cyawzin/qwen-image-2-1-uncensored-gguf-6-step-t4-research
- Hono bot: `vite-react-template`
- Model: `KasugaiSakura/Qwen-Image-2.1-Uncensored-Abenzerps-GGUF`, `qwen-image-2.1-UC-Q4_K_M.gguf`
- Accelerator: Viggle v0.3 six-step LoRA **r128** (T4 memory-saving variant; Space uses r256), Euler and raw sigma nodes `1, 0.9375, 0.875, 0.75, 0.5, 0.25`
- Security: **research only**; disabled by default via `QWEN_KAGGLE_ENABLED=0`
- Reuses existing Worker secrets `KAGGLE_API_TOKEN`, `TELEGRAM_BOT_TOKEN` and bound D1 `MEMORY_DB`. Never commit tokens or put tokens in Telegram messages.

## Telegram commands

`/qwenimage A realistic red ceramic cup beside a rainy window`

`/qwenimage --size=768 A cinematic mountain landscape`

`/qwenimage_status` — latest job status for the current chat.

`/qwenimage_help` — limits and licensing.

## Processing pipeline

Telegram allowlist → Hono webhook → D1 job → Cloudflare minute cron → private Kaggle Python script → ComfyUI inference → Kaggle PNG output → Telegram `sendDocument`. No public GPU tunnel, no long-lived Kaggle service, no secrets in Kaggle kernel. One image per job. Other Kaggle services are respected by the D1 cross-service busy check.

When Kaggle submission is ambiguous, the job is marked `submit-uncertain` (never auto-retried). When Telegram delivery is ambiguous, the job is marked `delivery-uncertain` (never auto-retried). Jobs have a status command.

## Release checklist

1. Kaggle kernel v1 must complete successfully with a real generated PNG and matching dimensions.
2. Inspect GPU OOM errors and Kaggle output listing. Adjust loader if the T4 cannot fit the entire model pipeline.
3. Confirm the existing Cloudflare Worker has `KAGGLE_API_TOKEN` secret, not just the OCI CLI.
4. Confirm production Worker baseline/version and staging parity before deployment.
5. After success only, set `QWEN_KAGGLE_ENABLED=1` through the approved Worker deployment, then send one Telegram test prompt. Verify D1 status and receipt.
6. Keep Qwen Research License usage non-commercial; obtain written licensing authorization before business use.

**Do not flip the enable flag while Kaggle render is queued, failed, or unverified.**

## Verification performed

`python3 -m py_compile qwen-kaggle/generate.py`

`node --experimental-strip-types tools/test-qwen-image21.mjs`

`npm run build`

`npx wrangler deploy --dry-run`

The Kaggle kernel is private. The feature is not enabled in production by creating this branch.
