# MVSEP live Telegram status + optional Qwen3-TTS voice cloning

## Current integration status

- `MVSEP_API_TOKEN` exists in the Cloudflare Worker (secret value remains unreadable).
- This branch ADDS an MVSEP Telegram command and a one-minute polling loop.
- Existing cron schedule `* * * * *` is reused. No new cron or D1 database is required.
- No MVSEP audio separation was submitted during development (avoids using credits).
- Qwen voice cloning is **not active** until a separate supported GPU endpoint is deployed.

## MVSEP Telegram usage

1. Send an audio file (up to 12 MB) in the authorized Telegram chat.
2. Reply directly to that audio with `/separate 40`. This submits a job to the Singapore MVSEP region.
3. Bot posts a status message and updates it on status or queue movement, at most once per existing 1-minute cron execution.
4. Use `/sep_status` for a fresh status check. `/sep_status HASH` checks a specific job.
5. Use `/sep_help` for bot help.

MVSEP status: waiting, processing, distributing, merging, done, failed.
The API does **not** guarantee progress percentages. Queue position and chunk counts are displayed only when returned.
Completed jobs display download links where provided.

A new `mvsep_live_jobs` table is created lazily in the existing D1 database. Existing `messages` and `wan_video_jobs` tables are untouched.

## Protected Hono endpoints

`GET /api/mvsep/status/HASH` (MVSEP public status through your Worker)

Requires the same `X-AI-Access-Key` header as your already-existing `/api/ai` endpoint.

## Qwen3-TTS 1.7B Base voice cloning

`POST /api/qwen/clone`: the route is **gated** and returns 503 until both bindings are configured:

- `QWEN_TTS_API_BASE` as an HTTPS origin ending in `.modal.run`
- `QWEN_TTS_API_KEY` as a Cloudflare secret

It forwards a multipart body containing:
- `ref_audio`: short WAV/FLAC voice recording (up to 6 MB)
- `ref_text`: exact spoken transcript
- `text`: desired speech text
- `language`: e.g., `English`

It expects the GPU backend to accept `POST /v1/clone` with bearer-token authentication and return `audio/wav` bytes.

A Qwen GPU model deployment is **not included** in the active Worker. An MVSEP API token cannot pay for or authenticate a Qwen service. Qwen's official open-source clone model is `Qwen/Qwen3-TTS-12Hz-1.7B-Base`, distinct from `VoiceDesign`.

Burmese is not among the model's ten officially supported languages. Do not represent Burmese output as verified.

Only clone your own voice or a voice for which you have permission.

## Deployment safety

Review the diff and build `npm ci && npm run build` before merging this branch.
The source branch does not automatically prove the Cloudflare production Worker was updated.
Verify the deployed Worker has the MVSEP routes before testing and keep all preexisting WAN commands intact.

There is no `/clone` generation on Telegram yet: `/clone_help` explains the GPU prerequisite and `/clone` safely refuses to spend on an unconfigured service.
