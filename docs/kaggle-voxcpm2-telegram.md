# VoxCPM2 Telegram → Kaggle GPU batch bridge

Status: **source integration in draft PR**, not production/fully connected. Original Kaggle notebook **cyawzin/voxcpm2-full-working** is not modified.

## Architecture

- Telegram `/vox Burmese text` → existing Hono webhook (authorized private users only).
- Hono D1 stores job text and state.
- OCI CPU-only dispatcher calls `POST /api/vox/claim` with a separate `VOX_WORKER_KEY`.
- Kaggle CLI pushes a **separate private** `cyawzin/voxcpm2-telegram-worker` script with T4×2 selected, runs it as a batch job.
- Dispatcher monitors `kaggle kernels status` and fetches `vox_generated.wav` using `kaggle kernels output`.
- Dispatcher sends the WAV to Hono `POST /api/vox/complete`; Hono delivers with Telegram Bot API.
- The dispatcher uses a **single lock** and submits at most one Kaggle run at a time. Kaggle status/output are for the notebook's latest run; parallel versions risk mixing outputs.

The batch adapter uses the official `openbmb/VoxCPM2` model and its `model.generate(text=..., cfg_value=2.0, inference_timesteps=10)` method. It is a **minimal separate script**, not a validated extraction of all options from the working 7-cell Gradio notebook. Voice-library settings, dual-GPU parallel scheduling, and original notebook parity are NOT yet confirmed. Test before activation.

## API commands (Hono)

- `/vox TEXT` — queue one speech request, 1–800 characters.
- `/vox_status` — latest job status, private per chat.
- `/vox_help` — usage help.
- `POST /api/vox/claim` — worker claim (private key).
- `POST /api/vox/update` — worker status update (private key).
- `POST /api/vox/complete` — worker sends small WAV and Hono sends Telegram audio (private key).

Until the Hono secret `VOX_WORKER_KEY` (32+ chars) is configured, `/vox` does not queue requests.
Uncertain Kaggle submissions are never automatically retried. Telegram delivery uncertainty is flagged to avoid duplicate messages.

## Prerequisites before activation

1. **Kaggle CLI authentication on the OCI dispatcher:** Either `kaggle auth login`, a current Kaggle API token as supported by the CLI, or a protected `~/.kaggle/kaggle.json` (chmod 600). Never paste credentials in chat or GitHub.
2. **Cloudflare Worker secret:** Generate a random 48-byte value on the server and configure the same `VOX_WORKER_KEY` secret on the deployed Cloudflare Worker. Do not commit this key.
3. **Cloudflare Access:** Since the Workers hostname is behind Cloudflare Access, the OCI client also needs approved service-token headers (`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`) or a narrowly scoped, separately authenticated route. Do not disable global Access.
4. **Kaggle GPU quota:** T4×2 and internet must be available. `cyawzin/voxcpm2-cache` dataset access may be private. The worker defaults to downloading the open-source model from Hugging Face; this can take time/space.
5. **Official CLI:** `kaggle kernels push -p <folder> --accelerator NvidiaTeslaT4` runs a new version; `kaggle kernels status` and `kaggle kernels output` monitor/retrieve it.

## OCI setup (after prerequisites)

```bash
mkdir -p ~/vox-kaggle && cd ~/vox-kaggle
python3 -m venv .venv
. .venv/bin/activate
pip install --upgrade kaggle requests
# Copy tools/vox-kaggle-dispatcher.py and tools/kaggle-vox-batch.py here.
export VOX_API_BASE='https://vite-react-template.canibeyours2001.workers.dev'
export VOX_KAGGLE_KERNEL='cyawzin/voxcpm2-telegram-worker'
# Set VOX_WORKER_KEY, CF_ACCESS_CLIENT_ID/SECRET and Kaggle auth in protected environment files.
python3 vox-kaggle-dispatcher.py --check
```

After `--check` verifies auth and the Worker accepts credentialed requests, install a locked-down service that launches:
```bash
flock -n /tmp/vox-kaggle.lock /home/ubuntu/vox-kaggle/.venv/bin/python /home/ubuntu/vox-kaggle/vox-kaggle-dispatcher.py
```
Use a persistent supervisor/timer only after one live smoke-test succeeds; do not activate an untested recurring GPU trigger.

## Cost and privacy

Kaggle GPU quota is limited; the server does not provide an always-on inference URL. Each queued job creates a private Kaggle notebook version. The private kernel source necessarily contains the requested speech text so it can run offline. Treat the notebook source and results as private. The design does not send the Kaggle API token to Cloudflare or Telegram.

References:
- https://github.com/Kaggle/kaggle-cli/blob/main/docs/kernels.md
- https://github.com/Kaggle/kaggle-cli/blob/main/docs/kernels_metadata.md
- https://www.kaggle.com/code/cyawzin/voxcpm2-full-working
