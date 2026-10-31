# VoxCPM2 Telegram → Kaggle GPU (Cloudflare-only)

## Production architecture (no OCI required)
Telegram private authorized chat `/vox TEXT` → Cloudflare Hono Worker → D1 job queue → Kaggle API with the secret `KAGGLE_API_TOKEN` → private Kaggle T4 GPU run → signed WAV output URL → Telegram sendAudio.

The existing `cyawzin/voxcpm2-full-working` (Version 7) notebook is unchanged. A separate private job kernel `cyawzin/voxcpm2-telegram-worker` runs isolated batch scripts using the same official model and generator API. The batch worker currently supports **text-to-speech only**, not all 12 original voice profiles, dual-GPU chunk scheduling, cloning or the interactive Gradio UI.

## Verified API behavior
Kaggle secret exists as Cloudflare Worker `KAGGLE_API_TOKEN`. Verified read-only from live Worker with HTTP 200:
- `GET https://api.kaggle.com/v1/kernels/list?user=cyawzin&pageSize=1`
- `GET https://api.kaggle.com/v1/kernels/status?userName=cyawzin&kernelSlug=voxcpm2-full-working`
- `GET https://api.kaggle.com/v1/kernels/output?userName=cyawzin&kernelSlug=voxcpm2-full-working`
- Push uses Kaggle's official `POST https://api.kaggle.com/v1/kernels/push` JSON RPC; **not end-to-end GPU tested yet**.

## Telegram
- `/vox မင်္ဂလာပါ။` — enqueue short Burmese speech (up to 450 characters).
- `/vox_status` — return the current or latest job state.
- `/vox_help` — usage.

The existing minute cron authenticates periodically, submits at most one Kaggle version, polls status/output, and uploads completed WAV directly through the Telegram Bot API. D1 has the `vox_kaggle_health`, `vox_kaggle_jobs` and `vox_kaggle_rpc_probe` tables. It does not expose the Kaggle secret.

## Operational safety
- Requires live successful Kaggle auth check before accepting /vox.
- One GPU run at a time globally to avoid output-version collisions.
- No automatic retry on uncertain Kaggle submission or uncertain Telegram delivery.
- The new kernel and speech text are private (isPrivate true); do not publish them.
- GPU quota and limits apply to each run; no continuously running inference API.
- Model first-run download can be substantial. Kaggle kernels may fail from quota or package/model changes.
- Existing WAN 2.2, MVSEP, Telegram and allowlist remain intact.

## Repository
Source: `src/worker/vox-kaggle-direct.ts`, imported into `src/worker/index.ts`.
Production Cloudflare Worker: `vite-react-template`.
Working Kaggle studio: https://www.kaggle.com/code/cyawzin/voxcpm2-full-working

Official references: https://github.com/Kaggle/kaggle-cli/blob/main/docs/kernels.md and https://openbmb.cn/docs/en/guides/voxcpm/voxcpm-2

## Fast-completion fix (October 31, 2026)

First live VoxCPM2 job took 12 minutes 14 seconds end to end. Script logs showed `VOX_GENERATED_SUCCESS` around 113 seconds into the Kaggle execution, but the Kaggle run continued for several minutes afterward.

Root-cause hypothesis: the generator downloaded the multi-gigabyte VoxCPM2 checkpoint to `/kaggle/working/VoxCPM2`, which Kaggle automatically packages in each saved notebook version's output. These large weights do not need to be saved to deliver the WAV.

Changed **only the separate Telegram batch worker's** model download directory from `/kaggle/working/VoxCPM2` to `/kaggle/temp/VoxCPM2`; `/kaggle/working/vox_generated.wav` remains the only intended persisted media output. Model weights are downloaded afresh into temporary space for each cold batch run. Model settings and audio generation are unchanged. Added timestamps `VOX_STAGE ..._seconds` for measured stage performance on the next run.

Expected improvement is mainly in Kaggle **post-generation output finalization**, not a guaranteed speedup in model inference or queue time. For genuinely low-latency repeated TTS, Kaggle's per-request Save & Run All batch model is intrinsically cold-started; a persistent, warm GPU session or paid inference endpoint would be a different architecture.

Do not modify the original `cyawzin/voxcpm2-full-working` studio.
