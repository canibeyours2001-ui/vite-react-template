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


### SAM2 build fix for CPU-only preprocessing smoke test

If the previous image build failed with `OSError: CUDA_HOME environment variable is not set`, the reason is that **Wan's officially pinned SAM2 commit** (`0e78a118995e66bb27d78518c4bd9a3e95b4e266`) has an older `setup.py` that **always** requests the CUDA extension and **does not** support the `SAM2_BUILD_CUDA=0` switch. (The switch only appears in newer SAM2 releases.)

The `preprocess_smoke.py` image now fetches the **exact upstream Wan-pinned SAM2 revision**, verifies that its setup code contains the expected optional extension call, patches **only the build-time copy of `setup.py`** to omit `ext_modules`, then installs it editable with `--no-build-isolation` and checks its imports. The original SAM2 GitHub repository is unmodified. Do not install a CUDA toolkit or change the Oracle VPS CUDA settings for this CPU-only smoke test.

```bash
cd "$HOME/wan22-animate-setup"
git pull --ff-only
cd modal_animate
modal run preprocess_smoke.py
```

The new run has **not yet been verified** to pass all other preprocessing steps. If another error occurs, inspect the next first failure. This change does not start any GPU, alter model files, or redeploy the production endpoints.

Official source: https://github.com/facebookresearch/sam2/blob/main/INSTALL.md


## Stage 6: Native Animate inference tokenizers (CPU, no GPU)

The official `wan/configs/wan_animate_14B.py` points at two **local tokenizer directories**:

- `google/umt5-xxl/`
- `xlm-roberta-large/`

The earlier core downloader intentionally fetched just the 10 large root files. The official `WanAnimate` constructor uses these additional directories before any generation; without them an expensive GPU container would hit a missing-tokenizer error.

```bash
cd "$HOME/wan22-animate-setup"
git pull --ff-only
cd modal_animate
modal run download_tokenizers.py
modal run check_readiness.py
```

The downloader fetches just first-level JSON, text, vocabulary, and SentencePiece files from the official `Wan-AI/Wan2.2-Animate-14B` repository. It rejects any single file over 150 MB and total over 250 MB; it excludes redundant multi-gigabyte encoder weight formats and ONNX weight directories. It verifies that `transformers.AutoTokenizer.from_pretrained` can tokenize entirely offline from both local directories and commits the result to the existing `wan22-animate-models` Volume. **It does not start a GPU**. Download, CPU, memory and persisted storage may incur charges.

The corrected readiness checker now checks both tokenizer directories before returning `readiness_check_passed: true`. An inference run still needs a separately prepared CUDA-capable image and a controlled GPU invocation. We have **not** tested GPU inference or created a Telegram video endpoint; the existing HTTP preflight remains unchanged.

Official evidence:
- https://github.com/Wan-Video/Wan2.2/blob/main/wan/configs/wan_animate_14B.py
- https://github.com/Wan-Video/Wan2.2/blob/main/wan/animate.py
- https://huggingface.co/Wan-AI/Wan2.2-Animate-14B/tree/main/google/umt5-xxl
- https://huggingface.co/Wan-AI/Wan2.2-Animate-14B/tree/main/xlm-roberta-large


### Tokenizer image build dependency fix

If the initial `download_tokenizers.py` image fails to build, note that `transformers==4.51.3` has an explicit dependency on `huggingface-hub>=0.30.0,<1.0`. The initial downloader mistakenly requested `huggingface_hub>=1.0,<2`, a conflicting constraint. It now uses `huggingface_hub>=0.34,<1.0` instead, with no changes to the stored model weights.

Additionally, Wan's XLM-R directory can validly contain `config.json` and `sentencepiece.bpe.model` without a `tokenizer_config.json`; the readiness checker now allows that upstream layout.

```bash
cd "$HOME/wan22-animate-setup"
git pull --ff-only
cd modal_animate
modal run download_tokenizers.py
modal run check_readiness.py
```

If a *new* image build still fails, inspect `modal image logs <IMAGE_ID>` and capture the **first** pip error lines; the generic `ImageBuildError` summary does not identify the cause by itself. No GPU is enabled by these commands.

Evidence:
- https://raw.githubusercontent.com/huggingface/transformers/v4.51.3/setup.py
- https://huggingface.co/Wan-AI/Wan2.2-Animate-14B/tree/main/xlm-roberta-large


## Stage 7: Persistent demo preprocessing and opt-in first GPU video

**Official preprocessing smoke test passed** with repaired ViTPose ONNX. The updated CPU script now persists a shorter **1.0-second, 12 fps** excerpt from Wan's published example to a separate `wan22-animate-test-results` Volume at `/upstream-demo/preprocessed`. This ensures the first paid A100 test need not repeat CPU pose extraction.

```bash
cd "$HOME/wan22-animate-setup"
git pull --ff-only
cd modal_animate
modal run preprocess_smoke.py
modal volume ls wan22-animate-test-results /upstream-demo/preprocessed
```

Confirm `outputs_persisted: true` and that `src_ref.png`, `src_pose.mp4`, `src_face.mp4` are present. Your 51.19 GB model Volume is mounted read-only; the new results Volume is separate from your earlier `wan22-results` TI2V Volume. **These commands do not allocate a GPU.**

A new `gpu_smoke.py` (not tested yet) follows the upstream `python generate.py --task animate-14B` single-GPU command, using the *already downloaded* native weights, 17 generated frames, four denoising steps, CPU T5 offloading, and 80 GB A100 VRAM. It installs the **official precompiled** FlashAttention 2 wheel for CUDA 12 / PyTorch 2.5 / Python 3.11 from upstream release v2.8.3.post2, and runs with 48 GiB CPU RAM. **This is only a diagnostic preview**; do not infer final image quality from four steps.

**No GPU is launched by pulling GitHub or running the default command below.** The GPU function is dispatched only when the user deliberately includes `--execute`.

```bash
# Safe: build/check entrypoint, no GPU request:
modal run gpu_smoke.py

# OPTIONAL PAID GPU DIAGNOSTIC, only if comfortable with the cost:
modal run gpu_smoke.py --execute
```

The paid function has an enforced `timeout=1200` (20 minutes), `max_containers=1`, `min_containers=0`, and a 15-second scale-down window. It attempts **one** clip, then commits `preview-<id>.mp4` under `/upstream-demo/generated/` to the independent results volume. No Cloudflare Worker, pre-existing TI2V app, or deployed preflight API is modified.

As of Oct 27 2026 Modal lists A100 80 GB GPU at **$0.000694/sec** (about **$2.50/hr**). A full 20 min GPU reservation costs about **$0.83 for GPU alone**, plus CPU and RAM charges; warm-up overhead may be billed and allocation availability is not guaranteed. Total model compatibility, resource use, and output quality remain unverified.

After successful paid generation:

```bash
modal volume ls wan22-animate-test-results /upstream-demo/generated
# Download from the Modal Volume after checking the exact MP4 name:
# modal volume get wan22-animate-test-results /upstream-demo/generated/<actual-file>.mp4 ./preview.mp4
```

Sources:
- https://github.com/Wan-Video/Wan2.2#run-wan-animate
- https://github.com/Dao-AILab/flash-attention/releases/tag/v2.8.3.post2
- https://modal.com/pricing
- https://modal.com/docs/cli/latest/volume


### Fix for `ModuleNotFoundError: No module named 'preprocess_smoke'` in GPU container

The GPU image successfully installed the precompiled FlashAttention wheel, but the first A100 run failed **during container function loading**, before starting native Wan inference: Modal's version 1.x behavior does not automatically mount an imported sibling Python file. The script imported `preprocess_image` from `preprocess_smoke.py` without adding the imported module to the GPU image.

The script now explicitly calls `.add_local_python_source("preprocess_smoke")` on the GPU image, following the official Modal documentation. It also runs `check_gpu_image_cpu` with the **same image**, checks that the module and FlashAttention can be imported, and verifies the saved model and preprocessing assets **without a GPU**.

```bash
cd "$HOME/wan22-animate-setup"
git pull --ff-only
cd modal_animate

# CPU-only; verifies the fixed container imports without paying for an A100:
modal run gpu_smoke.py

# Once the preflight reports cpu_preflight_passed: True,
# explicitly authorize a new paid attempt:
modal run gpu_smoke.py --execute
```

Do not repeat `modal run preprocess_smoke.py`: its successful output is already stored in `wan22-animate-test-results/upstream-demo/preprocessed`. If CPU preflight fails, share its first traceback; **do not** start another GPU test. The fix and preflight are committed in GitHub but have not yet been run on your Modal account. The earlier failed GPU import may already have incurred limited GPU startup charges.

Reference: https://modal.com/docs/sdk/py/latest/Image#add_local_python_source


### Fixed first GPU run: missing `einops` after A100 allocation

The October 27 2026 first A100 attempt confirmed CUDA 12.4, 79.3 GiB VRAM, FlashAttention, model volume and preprocessing inputs, but failed during `import wan`: `ModuleNotFoundError: No module named 'einops'`. The upstream `wan/modules/vae2_1.py` imports `einops.rearrange`, but upstream `requirements.txt` does not explicitly list `einops`.

The GPU image now installs pinned `einops==0.8.1`. More importantly, the existing **CPU-only preflight** now runs the exact upstream `python -u generate.py --help` from `/opt/Wan2.2`, which imports `wan` and initializes its argument parser without allocating a GPU or loading the huge model. The CLI import test must succeed before another A100 invocation; failures print the first actionable traceback.

```bash
cd "$HOME/wan22-animate-setup"
git pull --ff-only
cd modal_animate
modal run gpu_smoke.py
```

Only after receiving `'official_generate_cli_cpu_import': True` and `'gpu_started': False` should another **optional paid** A100 inference be attempted with `modal run gpu_smoke.py --execute`. This source change is committed but **the new Modal CPU preflight is not yet executed**. Saved model weights and demo inputs do not need to be downloaded again.

Sources: https://github.com/Wan-Video/Wan2.2/blob/main/wan/modules/vae2_1.py and https://github.com/Wan-Video/Wan2.2/blob/main/requirements.txt


### CPU preflight false failure: upstream T5 import invokes CUDA

Upstream `wan/modules/t5.py` defines `T5EncoderModel.__init__` with `device=torch.cuda.current_device()` as a **default-argument expression**. Python evaluates that expression when the module is imported, so even `python generate.py --help` fails in a CPU-only Modal container with `RuntimeError: Found no NVIDIA driver`. This does *not* indicate the actual GPU runtime is broken.

The preflight now runs `generate.py --help` in a **separate CPU child Python process**, replacing `torch.cuda.current_device` in **only that child process** with a non-GPU stub returning `0`. The real `generate_short_preview()` GPU function still calls the original, unmodified `python generate.py` with CUDA available. This CPU check can catch further missing Python imports and CLI mismatches, but does **not** prove GPU inference, memory fit, or output quality.

```bash
cd "$HOME/wan22-animate-setup"
git pull --ff-only
cd modal_animate
modal run gpu_smoke.py
```

Expect `'official_generate_cli_cpu_import': True`, `'simulated_cuda_lookup_in_cpu_probe': True`, and `'gpu_started': False`. If an import error remains, fix that without launching paid GPU. Only after preflight passes, `modal run gpu_smoke.py --execute` remains the *separate*, explicitly paid attempt.


### CPU inference-import preflight found missing librosa

The CPU-only CLI test now passes Wan's import-time `torch.cuda.current_device()` by stubbing that lookup **only within its child process**. It next discovered `ModuleNotFoundError: No module named 'librosa'`, because upstream `wan/__init__.py` eagerly imports `WanS2V` and `wan/modules/s2v/audio_encoder.py` imports `librosa`, even for Animate-14B. Upstream `requirements_s2v.txt` also lists `librosa`. `gpu_smoke.py` now installs `librosa==0.11.0` alongside `einops==0.8.1`.

Retry **CPU-only** first:
```bash
cd "$HOME/wan22-animate-setup"
git pull --ff-only
cd modal_animate
modal run gpu_smoke.py
```

Do **not** run `modal run gpu_smoke.py --execute` while the CPU preflight reports an import error. The previous A100 failure was unrelated to the 51.19 GB model weights, which remain mounted read-only. This code update has been committed but has not yet been executed on the user's Modal account.

Evidence: https://github.com/Wan-Video/Wan2.2/blob/main/wan/modules/s2v/audio_encoder.py and https://github.com/Wan-Video/Wan2.2/blob/main/requirements_s2v.txt


### Timed-out first full A100 model inference; bounded next diagnostic

The first fully loaded A100 attempt reached `[INFO] Generating video ...` at 21:46:41 (+07) and was stopped at 22:02:13 with `subprocess.TimeoutExpired(... after 1100 seconds)`. All four DiT shards, T5, CLIP and VAE loaded. No completed MP4 was reported. **This is a generation-time timeout, not a missing model or dependency.** The native `WanAnimate.generate` logger should report `real frames: ... target frames: ...` after reading its input videos and **performing T5 encoding**, so the missing line suggests the old `--t5_cpu` may have caused a major CPU-side bottleneck; it is not proof of the bottleneck.

For the **next optional paid attempt**, `gpu_smoke.py` now follows Wan's published single-GPU 14B memory recipe more closely:

- **Remove** `--t5_cpu`, allowing text-encoder execution on the 80 GB A100 rather than only CPU.
- **Add** `--convert_model_dtype`, leave `--offload_model True` enabled to control VRAM use.
- Keep `--frame_num 17`, `--sample_steps 4` (diagnostic quality), `--refert_num 1`.
- Print a periodic `HEARTBEAT` with GPU utilization and VRAM use every 60 seconds. These measurements help distinguish actual CUDA compute from long CPU/offload phases but cannot by themselves prove forward progress.
- Stop the underlying subprocess after **660 seconds** (11 minutes); Modal hard timeout after **720 seconds** (12 minutes) to bound potential charges. The subprocess group is terminated on errors to prevent orphan work.
- Keep all weights read-only; video files are written only to `wan22-animate-test-results`.

The official model's CPU-vs-GPU memory and time tradeoffs remain workload-dependent. **The revised settings have not been tested** on this Modal account and can still OOM or time out; no successful Animate MP4 exists yet.

```bash
cd "$HOME/wan22-animate-setup"
git pull --ff-only
cd modal_animate
# First: CPU-only import and input check; no A100 allocated
modal run gpu_smoke.py
# Optional new paid A100 diagnostic after CPU preflight passes
modal run gpu_smoke.py --execute
```

At an illustrative A100 GPU list rate of about $2.50/hour, 12 minutes of GPU alone would cost about $0.50, with additional CPU/memory charges; actual costs may differ. The `--execute` invocation is optional and should be chosen only if the user wishes to spend credits. No Cloudflare Telegram bot or previous Wan 5B app deployment is modified.

Official Wan references:
- https://github.com/Wan-Video/Wan2.2/blob/main/wan/animate.py
- https://github.com/Wan-Video/Wan2.2


### Cheapest quality improvement after the first successful Animate-14B preview

The first end-to-end video was **only a 4-step diagnostic** with **12 frames of 640x360 conditioning video**, generated in ~120.8 sec on A100 80 GB and saved in `wan22-animate-test-results`. The upstream `WanAnimate` configuration uses **20 steps** for its base model, and increasing steps improves quality at additional render time (no distillation/acceleration LoRA is installed). The sample source was preprocessed at **12 FPS**, whereas the native `wan_animate_14B.py` output FPS is **30**; the final generator trims to the number of input frames. Therefore, the clip is very short and may play back faster than the original source. Higher denoising steps alone do not change the source resolution or that FPS mismatch.

`gpu_smoke.py` now accepts `--steps` with values **4, 10, or 20**, default **20**, without modifying the checkpoint volume:

```bash
cd "$HOME/wan22-animate-setup"
git pull --ff-only
cd modal_animate

# CPU-only dependency and checkpoint preflight, no A100:
modal run gpu_smoke.py

# Optional paid quality test with the official 20-step baseline:
modal run gpu_smoke.py --execute --steps 20

# Optional slightly cheaper compromise when cost is paramount:
modal run gpu_smoke.py --execute --steps 10
```

The `--execute` guard remains mandatory for paid GPU generation, with 11-minute subprocess and 12-minute function caps. The previously used `--convert_model_dtype`, GPU T5 inference and CPU offloading remain the same.

**Before paying for longer video or 480p+ testing**, compare the same inputs/seed at 20 steps. Better spatial detail requires changing preprocessing resolution (currently 640x360), re-preprocessing only the small example input (not the 51 GB weights), and a new controlled test. For natural-speed output, align preprocessing source FPS with Wan's configured 30 FPS or adjust the export playback rate; simply raising sampling steps will not fix a fast-playback issue.

The price estimate (~$0.12–$0.20 for the *short* 20-step test) is an extrapolation from the observed 120.8-second 4-step test plus Modal's GPU+CPU+RAM published rates, NOT a verified benchmark. H100 costs more per GPU-second; L40S has less VRAM and has not been proven with this 51 GB native model. Sources:
- https://github.com/Wan-Video/Wan2.2/blob/main/wan/configs/wan_animate_14B.py
- https://github.com/Wan-Video/Wan2.2/blob/main/wan/animate.py
- https://modal.com/pricing


## Stage 8 — 3-second Animate preview with real-time 30 FPS (corrected to fit official sample)

The initial 5-second preprocessing plan could not succeed: the *official* demo driving video is only **3.537 seconds**, as confirmed by the Modal preprocessing log. This is an input-length guard working correctly, not a checkpoint failure. **Do not loop, freeze or synthetically repeat the sample** just to force five seconds.

The updated `preprocess_long.py` cuts **3.0 seconds at 30 FPS = 90 distinct source frames**, invokes the already-working official pose/face preprocessor, verifies both output videos contain 90 frames, and persists inputs at `wan22-animate-test-results:/upstream-demo-long/preprocessed`. The process uses CPU only and keeps the 51.19 GB model weights read-only.

```bash
cd "$HOME/wan22-animate-setup"
git pull --ff-only
cd modal_animate
modal run preprocess_long.py
modal volume ls wan22-animate-test-results /upstream-demo-long/preprocessed
```

Look for `preprocessing_passed: True`, `frames: 90`, `fps: 30`, `gpu_started: False`. Then validate the saved assets and GPU imports *without buying A100 time*:

```bash
modal run gpu_smoke.py --long
```

Look for `cpu_preflight_passed: True` and `long_motion_checked: True`. Only after both pass, deliberately authorize **one** paid GPU run:

```bash
modal run gpu_smoke.py --execute --steps 20 --long
```

The GPU runner uses **77 frames per Wan clip** with one-frame overlap, two denoising segments for 90 input frames, `--convert_model_dtype`, GPU T5 encoding and `--offload_model True`. It trims the generated sequence to the 90 real input frames, yielding an expected **3-second MP4** at Wan's 30 FPS (actual output must be verified).

It retains the 11-minute subprocess timeout and 12-minute Modal hard timeout. At about $2.50/hour for the GPU component, a full 12-minute A100 container runtime is about $0.50 for GPU alone, excluding CPU/RAM and any additional applicable charges. The actual multi-segment generation time has **not yet been benchmarked**.

Output files go to the independent `/upstream-demo-long/generated` directory:

```bash
modal volume ls wan22-animate-test-results /upstream-demo-long/generated
```

For **5 seconds or more**, provide a motion-driving video at least that long; the included official example is too short and should not be looped. No production Cloudflare Worker or existing Wan TI2V application was modified.
