# SeedVR2 video upscaling (CYAW AI Studio Telegram)

Status: **staged / GPU smoke test pending**. This is a separate Kaggle kernel and D1 queue; it does not alter /dub, /vox, /upscale (image), Cloudflare Access, or existing Telegram webhook security.

## Commands
- Attach a video with caption \`/vsr\` (defaults to 1080p short edge).
- Caption \`/vsr 720\` for a lower-memory output.
- Reply to a Telegram video with \`/vsr 1080\`.
- \`/vsr_status\` shows the latest job.
- \`/vsr_help\` shows help and constraints.

Beta guardrails: Telegram file only (max 20 MiB); MP4/MOV/WebM; input length 0.2-10 s, source short edge 100-720 px, max 1920 long edge, frame rate 1-30 fps. Kaggle notebook validates media with ffprobe before any model inference. Output must be a validated MP4, and Telegram output max 49 MiB.

## Design
1. Telegram webhook validates existing X-Telegram-Bot-Api-Secret-Token and private-chat allowlist.
2. Commands enqueue in a separate \`seedvr2_jobs\` D1 table (unique by chat and Telegram message ID).
3. Existing minute cron polls only when \`seedvr2_config.enabled=1\`.
4. The Worker privately pushes a single Kaggle **script** kernel \`cyawzin/seedvr2-telegram-video-upscaler\`, including only a signed media download URL, target size, and pinned SeedVR2 CLI reference. **No Telegram or Kaggle secrets are put in the kernel code**.
5. Signed GET \`/telegram/webhook?vsrfile=...&expire=...&sig=...\` verifies HMAC-SHA256 and current D1 job status, streams the original media via the Telegram file API, and returns no-store. It never exposes the bot token.
6. Kaggle T4 installs SeedVR2 CLI, downloads or loads its 3B FP16 checkpoint, enhances the clip and emits \`seedvr2_result.mp4\`.
7. The Worker polls Kaggle status, validates its output URL host, and sends the MP4 to Telegram (or marks delivery uncertain).
8. Any uncertain Kaggle push or Telegram delivery is **never retried automatically**.

Kaggle is for batch runs only. Notebook startup, model downloads, and free GPU quota are not guaranteed. There is no persistent Kaggle API server. Run one job at a time and avoid overlap with VoxCPM2 and pyVideoTrans T4 jobs.

## Activation (only after one real GPU smoke test and Telegram delivery test)
D1 is disabled by default. Do not enable until the separate Kaggle notebook verifies Python/Torch dependencies, model checkpoint download, output video decoding, and Telegram delivery in a non-production test.

Administrator-only remote D1 operation:
\`\`\`sql
INSERT INTO seedvr2_config (id, enabled) VALUES (1, 1)
ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled;
\`\`\`
Rollback: \`UPDATE seedvr2_config SET enabled=0 WHERE id=1;\` This stops new submissions but does not interrupt an already-running Kaggle version.

When a new server release is promoted, retain existing Worker bindings and secrets. The module uses \`KAGGLE_API_TOKEN\`, \`TELEGRAM_BOT_TOKEN\`, \`TELEGRAM_WEBHOOK_SECRET\`, and \`MEMORY_DB\`.

Testing:
\`\`\`bash
node tools/test-seedvr2.mjs
npm run check
\`\`\`

The unit test tests disabled gating, bad signatures, private kernel settings, generated Python syntax; it does **not** prove actual GPU inference.

Official project: https://github.com/ByteDance-Seed/SeedVR ; T4 CLI: https://github.com/delvilo/SeedVR2-CLI
## Maximum Kaggle batch runtime

New SeedVR2 submissions request a **12-hour** Kaggle CPU/GPU batch session (`43200` seconds), which is the platform maximum. The model subprocess has an **11-hour** limit (`39600` seconds) to reserve remaining time for dependencies, model loading and MP4 export. Kaggle can still stop work earlier due to quota, resource limits, or session errors. These settings **do not extend running notebooks** or bypass weekly GPU allocation; do not cancel/resubmit an in-progress video to adopt them.
