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


## Stage 4: Verify core model asset readiness (no GPU)

After `modal run download_weights.py` reports **Succeeded** for all 10 files, verify the model index, diffusion checkpoint files, VAE, CLIP/T5 encoders and the mandatory YOLO/VitPose preprocessing checkpoints before deploying a GPU runner:

```bash
cd "$HOME/wan22-animate-setup"
git pull --ff-only
cd modal_animate
modal run check_readiness.py
```

The expected report has `readiness_check_passed: true`, `core_files_present: 10`, and `diffusion_shards_indexed: 4`. This is a **read-only metadata check**; it does not prove that the checkpoint is loadable, the ONNX pose runtime is installed, or video generation will work.

The official pipeline still requires `wan/modules/animate/preprocess/preprocess_data.py` to produce `src_pose.mp4`, `src_face.mp4`, and `src_ref.png` from the reference image and driving video before executing `generate.py --task animate-14B`. Basic animation does not require the optional FLUX image editor or SAM2 masking model; do not download FLUX or attempt replacement mode as part of the initial test. See the upstream `requirements.txt`, `requirements_animate.txt`, and preprocessing UserGuider.

GPU is not configured in this readiness-check module, and it does not change the deployed `wan22-animate-14b` HTTP preflight API or the existing TI2V bot.


## Stage 4a: ViTPose ONNX layout repair (when readiness check reports a missing pose2d ONNX file)

The official `Wan-AI/Wan2.2-Animate-14B` Hugging Face repository currently publishes
`process_checkpoint/pose2d/vitpose_h_wholebody.onnx` as a **directory containing hundreds of separate tensors**. But the upstream Wan `preprocess_data.py` explicitly opens a **single ONNX model file** at this path. Hence the initial preprocessing download can fetch ~400 files / 4.17 GB and still fail readiness.

For the Wan-compatible ONNX export, the community-maintained `Kijai/vitpose_comfy` repo provides a ~420 KB `vitpose_h_wholebody_model.onnx` alongside its required ~2.55 GB `vitpose_h_wholebody_data.bin`. Both files must sit in the same directory. The ONNX model is then renamed `vitpose_h_wholebody.onnx`, which is the exact filename required by Wan.

This staged, CPU-only fix **does not re-download any 51.19 GB Animate-14B inference weights**. It verifies the community export sizes and external data reference before making filesystem changes, preserves the previous Hugging Face tensor directory as `vitpose_h_wholebody.onnx.hf-tensor-backup`, and commits the repaired layout to the *same* Modal Volume. It may incur CPU and storage charges; no GPU is requested.

On your Oracle VPS, with the existing `setup/wan22-animate-14b` branch checked out:

```bash
cd "$HOME/wan22-animate-setup"
git pull --ff-only
cd modal_animate
modal run repair_vitpose.py
modal run check_readiness.py
```

Expected report: `"readiness_check_passed": true`; `"core_files_present": 10`; `"diffusion_shards_indexed": 4`; `"vitpose_onnx_is_file": true`.

**Important:** A passed readiness check only verifies the assets' presence and diffusion shard index, not that the CUDA/ONNX runtimes can load them. Preprocessing and GPU inference still need separate testing.

Sources:
- Official Wan preprocessing hard-coded ONNX name: https://github.com/Wan-Video/Wan2.2/blob/main/wan/modules/animate/preprocess/preprocess_data.py
- Official Hugging Face ONNX-named directory: https://huggingface.co/Wan-AI/Wan2.2-Animate-14B/tree/main/process_checkpoint/pose2d
- Community-documented compatible ViTPose ONNX + external data: https://github.com/kijai/ComfyUI-WanAnimatePreprocess/blob/main/readme.md
- Export files: https://huggingface.co/Kijai/vitpose_comfy/tree/main/onnx


## Stage 5: Validate the **official** animation preprocessing runtime (CPU-only demo)

Once `check_readiness.py` reports **true**, run a smoke test with the sample `examples/wan_animate/animate/image.jpeg` and `video.mp4` from the official `Wan-Video/Wan2.2` repository. This trial tests the actual upstream `preprocess_data.py` rather than only checking that checkpoint files are present.

```bash
cd "$HOME/wan22-animate-setup"
git pull --ff-only
cd modal_animate
modal run preprocess_smoke.py
```

The image build installs PyTorch, the official SAM2 revision, ONNX Runtime, decord, Diffusers with Flux-Kontext import support, and the preprocessing dependencies; it clones the **official** upstream Wan2.2 source. It may download several GB of dependency packages for the Docker image and incur Modal CPU/memory charges, but it **does not request any GPU**, start an Animate inference job, download model weights again, or modify the checkpoint volume. The checkpoint is mounted read-only.

The script extracts a short 1.5 s, 12 fps segment of the official driving video, invokes the upstream preprocessing command without FLUX or retargeting, and checks for generated `src_ref.png`, `src_face.mp4` and `src_pose.mp4`. These demo outputs live in the temporary function container; do not expect a persisted MP4 yet.

**Caveat:** Wan's pose detection implementation defaults to the CUDA provider, though ONNX Runtime may fall back to the CPU provider. We have not verified actual CPU preprocessing compatibility; if the smoke test fails, share the first meaningful error and inspect the runtime rather than downloading anything again. An A100/H100 GPU is **not** enabled by this module. The later full GPU inference implementation still requires a separate proof of compatibility and an explicitly controlled small test.

References:
- https://github.com/Wan-Video/Wan2.2/blob/main/README.md
- https://github.com/Wan-Video/Wan2.2/blob/main/wan/modules/animate/preprocess/UserGuider.md
- https://github.com/Wan-Video/Wan2.2/blob/main/requirements_animate.txt
- https://modal.com/docs/guide/volumes
