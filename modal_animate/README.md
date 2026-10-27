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


## Stage 2: Download the official preprocessing checkpoints to your Modal volume (CPU only)

The Modal volume `wan22-animate-models` must already exist. To update your existing Oracle VPS clone and download only the official preprocessing assets, run:

```bash
cd "$HOME/wan22-animate-setup"
git pull --ff-only
cd modal_animate
modal run download_models.py
modal volume ls wan22-animate-models /
```

This downloads approximately 4.17 GB from `Wan-AI/Wan2.2-Animate-14B/process_checkpoint` directly to Modal's persisted volume, where it is saved under `/Wan2.2-Animate-14B/process_checkpoint`. It does not need that disk space on the VPS. No GPU is configured; CPU and persistent storage may still incur Modal charges. The script commits the Volume after validating that the `det`, `pose2d`, and `sam2` folders have files.

This is **not** the full model or a working GPU pipeline. The official model weights (~72.4 GB total repository) and official inference dependencies need another validated stage before enabling /motion generation. Do not deploy or overwrite your existing Wan TI2V service.

Sources:
- https://huggingface.co/Wan-AI/Wan2.2-Animate-14B/tree/main/process_checkpoint
- https://modal.com/docs/guide/volumes


## Stage 3: Download official Animate-14B core inference weights (CPU only)

The preceding preprocessing download should report 400 files / ~4.17 GB. For the first animation-only test, download the official root inference weights: the four diffusion checkpoint shards, weight index, VAE, CLIP image encoder, T5 text encoder, and configuration files. Together these are roughly **51 GB**. This is not a GPU benchmark or proof of compatibility.

From your existing Oracle VPS clone:

```bash
cd "$HOME/wan22-animate-setup"
git pull --ff-only
cd modal_animate
modal run download_weights.py
```

The downloader pins the current official Hugging Face commit, checks each file size before proceeding, excludes optional relighting/replacement files, commits each finished file into the pre-existing Modal Volume, and skips exact-size-complete files if restarted.

This takes place **inside Modal**; your Oracle VPS does not download or store the weights. The CPU download, network, and stored volume may have charges depending on your Modal plan. No GPU is requested, and no video can be generated by this script.

After completion:

```bash
modal volume ls wan22-animate-models /Wan2.2-Animate-14B
```

Only after the actual core-weight download succeeds will we add the validated official preprocessing/inference runtime and an explicit, user-approved short GPU test. The separate `wan22-animate-14b` preflight app and your TI2V production app are not altered by the download.

Sources:
- https://huggingface.co/Wan-AI/Wan2.2-Animate-14B/tree/main
- https://github.com/Wan-Video/Wan2.2
- https://modal.com/docs/guide/volumes
