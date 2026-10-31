# Telegram → Cloudflare → private Kaggle pyVideoTrans video dubbing

**Status: staged / compatibility testing. `/dub` is intentionally disabled (private D1 `pyvt_config.enabled=0`) until Kaggle Python 3.10 and video runtime tests succeed.** The existing VoxCPM2 text-only API, MVSEP, WAN and Telegram allowlist are not modified.

## Engines
- `edge`: Microsoft Edge TTS, existing pyVideoTrans provider ID **0**. Example Burmese female voice: `my-MM-NilarNeural` (male: `my-MM-ThihaNeural`). Edge speech generation itself is CPU/network, but transcription can still need a GPU.
- `vox`: native VoxCPM2 in pyVideoTrans provider ID **38**, on Kaggle GPU. This is different from the existing Gradio provider ID 15.
- The source pyVideoTrans CLI and provider implementation are merged into `canibeyours2001-ui/pyvideotrans` main.

## Planned Telegram commands
```text
/dub_help
/dub edge en my
/dub vox en my
/dub vox en my 1    # reuse private saved VoxCPM2 voice profile slot 1
/dub_status
```
Attach a video with a `/dub ...` caption, or reply to an existing video. The first beta is limited to **20 MB input**, matching Telegram Bot API's `getFile` limit, and **49 MB output** for `sendVideo`. It uses pyVideoTrans `--task vtv` to transcribe, translate with its free Google translation provider (ID 0), dub and assemble. Translation might fail due to upstream changes and provider rate limits; there are no quality guarantees for Burmese. Use only personal, non-commercial media consistent with the service terms.

## Signed video transport; no R2 or OCI

Cloudflare's existing Access public exception on `/telegram/webhook` allows **GET** with an HMAC SHA-256 token for a particular queued video ID and 12-hour expiry. The Worker verifies the signature and D1 job status, then fetches the video with its existing private Telegram bot secret and streams it to Kaggle. Kaggle's **private notebook** receives an expiring media URL only: no bot token, Cloudflare key or Kaggle token is embedded in notebook source. Telegram POST webhook validation remains unchanged. Invalid/expired signatures return 404. Do not remove the existing Access protection from other routes.

## Kaggle dispatch
An independent private Kaggle kernel `cyawzin/pyvideotrans-telegram-dub` receives only one queued job at a time. Cloudflare invokes the official Kaggle API `POST /v1/kernels/push`, polls `GET /v1/kernels/status` and `GET /v1/kernels/output`, then sends the final MP4 through Telegram. Ambiguous submissions and uncertain deliveries are never automatically retried.

Kaggle script downloads the video from signed URL, clones pinned pyVideoTrans main source, provisions Python 3.10 via `uv` and installs the declared dependencies, and launches `tools/kaggle_video_dub_job.py` with the selected Edge/Vox provider.

**Important:** pyVideoTrans `uv sync` can be heavyweight and is not yet proven on Kaggle's current environment. Do not enable `pyvt_config` before a full CPU compatibility test and one controlled MP4 end-to-end test. This avoids burning GPU quota on predictable dependency errors.

## Safe preflight

There is a separate CPU-only private kernel `cyawzin/pyvideotrans-compatibility-check` which is triggered **once** when D1 contains:
```sql
INSERT INTO pyvt_preflight(id,status) VALUES(1,'requested')
ON CONFLICT(id) DO UPDATE SET status='requested',version=NULL,detail='',updated_at=unixepoch();
```
The cron checks `pyvt_preflight`, submits a private CPU kernel, installs Python 3.10 and pyVideoTrans deps, tests `python cli.py --list providers`, and records status/version. This preflight doesn't use video, API media, GPU or Telegram messages. It is opt-in and not automatically resubmitted if uncertain.

## Code locations
- Cloudflare: `src/worker/pyvt-kaggle.ts`, integrated in `src/worker/index.ts`.
- pyVideoTrans: `videotrans/tts/_voxcpm2kaggle.py`, `tools/kaggle_video_dub_job.py`.
- Production bot remains `vite-react-template` with the original bindings kept intact.

References: https://core.telegram.org/bots/api and https://github.com/Kaggle/kaggle-cli/blob/main/docs/kernels.md.

### Private activation switch

The Worker creates `pyvt_config` only when a `/dub` request or poll needs it. If no row exists, video GPU submissions are disabled. After CPU preflight and a controlled successful video integration test, the administrator can deliberately enable `pyvt_config.enabled=1` using Cloudflare D1 (never via Telegram). This keeps existing users from accidentally consuming GPU quota on untested video builds.

The optional numeric 1–5 in `/dub vox ...` reuses the Telegram user's saved VoxCPM2 reference sample. The sample is embedded only into the private Kaggle job source (never into a public file URL); that job decodes it to a WAV and supplies `--reference-wav` to native VoxCPM2 to improve timbre consistency over subtitle segments. Edge TTS takes a Microsoft voice name instead of a numbered slot.

## Telegram target-language and voice wizard

Send `/dub` in your private bot chat to choose through inline Telegram buttons:

1. **Target language:** English or Burmese. The wizard initially assumes the opposite source language (Burmese → English or English → Burmese).
2. **Dubbing engine:** Microsoft Edge TTS (network voice) or VoxCPM2 (Kaggle T4 GPU).
3. **Voice:**
   - English Edge: Aria (US woman), Guy (US man), Christopher (US man).
   - Burmese Edge: Nilar (woman), Thiha (man).
   - VoxCPM2: new/default voice or an existing private saved-voice slot 1–5 (from `/voxvoices`).

These selections are saved per private Telegram chat in D1 `pyvt_dub_selections`. After choosing, send a video (maximum 20 MB) or reply to an existing video using `/dub`. The previously supported direct commands, including `/dub edge en my` and `/dub vox en my 1`, remain available. The direct command parser also now correctly accepts single-digit saved-voice slots.

**Safety:** This is the *selection UI only*. Actual video jobs remain disabled unless the private `pyvt_config.enabled` flag is set after successful Kaggle runtime and MP4 delivery tests. Current CPU-only environment preflight and voice-provider checks do not automatically enable dubbing jobs. There is no public menu endpoint, and all callbacks require existing Telegram private-chat authorization.
