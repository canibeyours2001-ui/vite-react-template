# VoxCPM2 reusable generated voice profiles (Cloudflare + Kaggle)

This adds **five private saved voice slots per Telegram account**, independent of the existing MVSEP Qwen voices. No OCI, R2 billing, or changes to the original seven-cell `cyawzin/voxcpm2-full-working` studio.

## Workflow

1. Generate short sample with `/vox မင်္ဂလာပါ။`
2. Listen to the audio delivered by the Telegram bot.
3. Tap **⭐ Save this voice**, then choose slot 1–5.
4. List your profiles with `/voxvoices`.
5. Rename with `/voxrename 1 Documentary`.
6. Generate with that voice: `/voxvoice 1 မင်္ဂလာပါ။`.
7. For long scripts, send a UTF-8 `.txt` file captioned `/voxvoice 1`, or reply to a `.txt` with `/voxvoice 1`.

The bot generates an extra **8-second / 96-kbps MP3 voice reference** alongside the full result inside the same Kaggle job. It does not run a separate GPU job to create the sample. At completion the Worker temporarily stores the reference MP3 as base64 in `vox_voice_samples`, which allows the Save button to be used later. When the user chooses a slot, the short clip is copied to `vox_saved_voices` in D1. Existing sample names are replaced on slot overwrite.

On future `/voxvoice SLOT` requests, Cloudflare embeds the saved short reference (not its Telegram token) into the **private** Kaggle batch script. Kaggle reconstructs the clip, decodes it to WAV with FFmpeg and calls `model.generate(reference_wav_path=...)`. **No reference transcript required**. Kaggle is still the only GPU compute layer. Sample audio is persisted in Cloudflare D1, not R2. A sample is limited to 180 kB, safely below D1's 2 MB value limit. Only the authorized private Telegram chat can list and manipulate its slots.

Potential issue: generation may approximate rather than exactly reproduce a voice. A clear 5–10 second initial clip with steady timbre is recommended. Voice timbre across several long chunks may not be identical. Saved voice data is injected into private Kaggle notebook code per job, so that notebook version's private source retains a copy of the sample; users should not publish the notebook version.

## Commands

- `/vox TEXT` — generate a new voice
- `/voxvoices` — list five saved VoxCPM2 voices
- `/voxvoice 1 TEXT` — generate using saved voice slot 1
- `/voxrename 1 Narrator` — rename slot 1
- `/vox_status` — check job status

Current MVSEP `/clone`, `/voices`, WAN commands, Cloudflare AI helper, and Telegram allowlist remain unchanged.

The deployed code requires a live user-triggered GPU job to confirm voice fidelity and completed Telegram Save flow. Do not automatically launch GPU jobs on merge.
