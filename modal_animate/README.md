# Wan2.2 Animate-14B — separate Modal app (Stage 1)

**This is an image/video validation API, NOT live Animate-14B GPU inference.** It deliberately disables generation until the official preprocessing checkpoints and GPU have been verified. The existing `wan22-ti2v-5b` Modal deployment and Cloudflare `main` branch are unchanged.

## Deploy on your Oracle VPS

These commands use a **separate GitHub branch**, which is excluded from your production Cloudflare main-branch deployment.

```bash
python3 -m venv "$HOME/.venvs/wan22-animate"
. "$HOME/.venvs/wan22-animate/bin/activate"
python -m pip install --upgrade modal
modal token info
```

If not authenticated, run `modal setup`.

Create a new Modal secret at https://modal.com/secrets:

- Name: `wan22-animate-auth`
- Variable: `MOTION_API_KEY`
- Value: private random token at least 32 characters (generate with `python3 -c 'import secrets; print(secrets.token_urlsafe(32))'`).

**Do not reuse the Wan TI2V API key. Do not send the key in chat or commit it.**

Clone and deploy:

```bash
git clone --branch setup/wan22-animate-14b --single-branch \
  https://github.com/canibeyours2001-ui/vite-react-template.git \
  "$HOME/wan22-animate-setup"
cd "$HOME/wan22-animate-setup/modal_animate"
modal deploy app.py
```

Copy the exact endpoint URL printed by Modal. It should be a NEW endpoint for app `wan22-animate-14b`, not your existing TI2V endpoint.

## Verify without any GPU inference

```bash
curl -fsS "https://YOUR-ACTUAL-ENDPOINT.modal.run/health"
```

Expected output: JSON with `"gpu_generation_enabled":false`.

Optional: test your own reference image and a short driving MP4 (0.5–5 seconds) using the protected preflight:

```bash
curl -sS -X POST "https://YOUR-ACTUAL-ENDPOINT.modal.run/v1/motion/preflight" \
  -H "Authorization: Bearer YOUR_PRIVATE_MOTION_API_KEY" \
  -F "image=@/path/to/character.jpg" \
  -F "driving_video=@/path/to/motion.mp4"
```

Preflight validates format and duration only; it does not persist either upload and does not launch a GPU job.

## Subsequent implementation

1. Provision the **official** `Wan-AI/Wan2.2-Animate-14B` weights and `process_checkpoint` in a separate Modal Volume. Official: https://github.com/Wan-Video/Wan2.2
2. Install/verify the official `wan/modules/animate/preprocess/preprocess_data.py` dependencies. This is part of the animation model pipeline; a text prompt alone is insufficient.
3. Run one explicitly approved short image+driving-video generation on a compatible **80 GB** GPU. L40S compatibility is not verified for this workflow.
4. Add an authenticated, asynchronous GPU job API and private output storage.
5. Add distinct Telegram `/motion_start`, image, driving-video, and `/motion_status` commands using the existing Cloudflare/D1 project. Preserve the existing `/video` command.

**Verification status:** Python source syntax checked offline. No live Modal deploy or actual motion transfer has been run through this starter.

Official references:
- https://github.com/Wan-Video/Wan2.2/blob/main/wan/modules/animate/preprocess/UserGuider.md
- https://modal.com/docs/guide/webhooks
- https://modal.com/docs/cli/latest/secret
