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

## Five reusable voice profiles and custom cloning

A separate Telegram conversational flow now supports five named slots using D1 metadata and Telegram file IDs:

1. Send a **3–15-second** clear reference voice/audio recording to the authorized Telegram bot.
2. **Reply to that message** with `/savevoice 1 Narrator | the exact words spoken in the recording`.
3. Repeat with slots **1–5** and labels of your choice.
4. Send `/voices` to list saved profiles, or `/clone` to display Telegram inline buttons for each saved voice and **Upload custom voice**.
5. When using a saved profile, type the target speech text. For custom voice, upload recording, provide its exact reference transcript, then enter desired speech text.
6. Confirm the **Generate audio** button. No inference starts until confirmed.
7. A scheduled Worker checks one explicitly confirmed job at a time and returns a WAV through Telegram once the Qwen GPU backend is configured.

`/clone_help`, `/clonelang English`, and `/cancel` are also supported. Available language names: Auto, English, Chinese, Japanese, Korean, German, French, Russian, Portuguese, Spanish, Italian. **Burmese is experimental/unsupported** by the official model.

IMPORTANT: Qwen inference will respond **not configured** until `QWEN_TTS_API_BASE` and `QWEN_TTS_API_KEY` are available. Voice selection and saving reference metadata do not require any GPU. The reference audio is **not stored in D1 or R2**: the bot records the Telegram `file_id` and fetches the recording when generating speech. This is convenient but relies on Telegram file availability. A permanent storage enhancement should use private R2 objects for durability.

Use only voices you own or have permission to clone. Reference transcripts and saved voice labels are private chat metadata inside D1; avoid uploading secret audio to public services.

For delivery, a Modal-compatible endpoint must accept `POST /v1/clone` multipart fields `ref_audio`, `ref_text`, `text`, `language`, and return WAV audio. It must decode OGG/Opus Telegram voice messages as well as WAV/MP3/FLAC or require WAV uploads.

## AI chat assistant and conversational command help

The existing Cloudflare Workers AI chatbot is retained; it continues to keep the most recent **20** Telegram user/assistant messages in D1, with old messages cleaned up after 7 days.
The assistant now receives **sanitized, text-only live context** for the five voice slots, the current /clone wizard stage, last Qwen clone job, last WAN video job, and last MVSEP job. It receives **no audio bytes, reference transcripts, Telegram file IDs, or API credentials** through this context.

- Send `/help` or `/commands` for an exact command menu.
- Send `/ask How do I clone using voice 2?` for context-sensitive AI instructions.
- Ordinary text outside an active /clone wizard also goes to AI.
- Inside a voice selection workflow, use `/ask ...` to ask questions without accidentally treating the question as speech text.
- Telegram's native slash-command menu is configured when the Worker updates its existing webhook subscriptions to include `callback_query` for inline voice-profile picker buttons.

The AI is an **advisor**, not an unguarded tool executor. It never launches paid GPU work just because the user mentioned it in conversation. GPU requests require the explicit **Generate audio** confirmation. The bot does not have access to separate ChatGPT conversations or to pre-existing Telegram chat history that it never stored.
