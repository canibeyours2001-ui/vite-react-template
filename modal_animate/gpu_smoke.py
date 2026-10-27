"""Isolated, opt-in first Wan2.2 Animate-14B GPU generation test.

Prerequisite:
  modal run preprocess_smoke.py   # CPU; persists 12-frame example assets

No GPU runs unless you explicitly pass --execute:
  modal run gpu_smoke.py --execute

The test uses upstream Wan generate.py and your saved checkpoint volume,
not a separate HF Diffusers checkpoint download. No existing API/bot is changed.
"""

from pathlib import Path
import modal

from preprocess_smoke import preprocess_image

app = modal.App("wan22-animate-first-gpu-smoke")
weights = modal.Volume.from_name("wan22-animate-models", create_if_missing=False)
results = modal.Volume.from_name("wan22-animate-test-results", create_if_missing=False)

# Official release wheel, compiled for: CUDA 12 / PyTorch 2.5 / Python 3.11
# / Linux x86_64 / cxx11abiFALSE. The proven preprocess_image installs
# torch==2.5.1. No nvcc or expensive GPU image-build step is necessary.
FLASH_ATTN_WHEEL = (
    "https://github.com/Dao-AILab/flash-attention/releases/download/"
    "v2.8.3.post2/"
    "flash_attn-2.8.3.post2+cu12torch2.5cxx11abiFALSE-"
    "cp311-cp311-linux_x86_64.whl"
)

gpu_image = (
    preprocess_image
    # Required by official wan/modules/vae2_1.py (not listed explicitly
    # in Wan2.2's requirements.txt). Missing it caused the first GPU failure.
    .pip_install(
        "einops==0.8.1",
        # Upstream wan/__init__.py eagerly imports S2V, whose
        # wan/modules/s2v/audio_encoder.py unconditionally imports librosa,
        # even for animate-14B and the --help-only CPU preflight.
        "librosa==0.11.0",
    )
    .pip_install(FLASH_ATTN_WHEEL, extra_options="--no-deps")
    # Modal 1.x no longer automatically mounts imported sibling modules.
    # gpu_smoke.py imports preprocess_image from preprocess_smoke.py;
    # the latter must exist when the remote function is hydrated.
    .add_local_python_source("preprocess_smoke")
)

ROOT = Path("/models/Wan2.2-Animate-14B")
PREPARED = Path("/results/upstream-demo/preprocessed")
OUT_DIR = Path("/results/upstream-demo/generated")
LONG_PREPARED = Path("/results/upstream-demo-long/preprocessed")
LONG_OUT_DIR = Path("/results/upstream-demo-long/generated")


@app.function(
    image=gpu_image,
    cpu=2,
    memory=4096,
    volumes={
        "/models": weights.with_mount_options(read_only=True),
        "/results": results.with_mount_options(read_only=True),
    },
    timeout=180,
    min_containers=0,
    max_containers=1,
)
def check_gpu_image_cpu(long: bool = False) -> dict:
    """Import the real GPU image and validate inputs, without allocating a GPU."""
    import importlib
    import torch

    module = importlib.import_module("preprocess_smoke")
    from flash_attn import flash_attn_func

    # This is the exact import/CLI entrypoint used by the paid GPU function.
    # Run argparse --help on CPU: Wan and its core modules must import
    # successfully, but no weights are loaded and no CUDA device is needed.
    import subprocess
    # Wan's upstream T5EncoderModel defines a constructor default of
    # device=torch.cuda.current_device(). This executes at *import time*
    # even for --help. On CPU preflight only, stub that default lookup
    # in a disposable child process. The real paid GPU runner remains
    # untouched and calls the unmodified native generate.py directly.
    # This tests dependencies/CLI imports, NOT actual GPU inference.
    cpu_help_probe = (
        "import sys, runpy, torch; "
        "torch.cuda.current_device = lambda: 0; "
        "sys.argv = ['generate.py', '--help']; "
        "runpy.run_path('generate.py', run_name='__main__')"
    )
    inspect = subprocess.run(
        ["python", "-u", "-c", cpu_help_probe],
        cwd="/opt/Wan2.2",
        text=True,
        capture_output=True,
        timeout=120,
    )
    if inspect.returncode:
        print("Official Wan generate.py --help failed:", flush=True)
        print(inspect.stdout[-6000:], flush=True)
        print(inspect.stderr[-8000:], flush=True)
        raise RuntimeError(
            "Official Wan generate.py cannot import on CPU; do NOT run paid GPU."
        )
    required_flags = (
        "--task",
        "--src_root_path",
        "--frame_num",
        "--sample_steps",
        "--offload_model",
        "--convert_model_dtype",
    )
    if any(flag not in inspect.stdout for flag in required_flags):
        raise RuntimeError("Unexpected Wan generate.py CLI flags; do NOT run paid GPU.")
    print(
        "Official Wan generate.py --help: OK "
        "(CPU dependency check with simulated CUDA device lookup)",
        flush=True,
    )

    if not hasattr(module, "preprocess_image"):
        raise RuntimeError("Imported preprocessing module lacks its image definition")
    needed = [
        ROOT / "config.json",
        ROOT / "models_t5_umt5-xxl-enc-bf16.pth",
        ROOT / "models_clip_open-clip-xlm-roberta-large-vit-huge-14.pth",
        ROOT / "Wan2.1_VAE.pth",
    ]
    prepared = LONG_PREPARED if long else PREPARED
    for filename in ("src_ref.png", "src_pose.mp4", "src_face.mp4"):
        needed.append(prepared / filename)
    if long:
        import json
        manifest_path = prepared / "manifest.json"
        if not manifest_path.is_file():
            raise RuntimeError(
                "No 3-second inputs. First run: modal run preprocess_long.py"
            )
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("fps") != 30 or manifest.get("frames") != 90:
            raise RuntimeError(
                "Long preprocessing must be exactly 90 frames at 30 FPS"
            )

    for filename in needed:
        if not filename.is_file() or filename.stat().st_size == 0:
            raise RuntimeError("Missing preflight input: " + str(filename))

    summary = {
        "cpu_preflight_passed": True,
        "sibling_import": "preprocess_smoke",
        "flash_attention_import": "OK",
        "torch_version": str(torch.__version__),  # cast TorchVersion to built-in str for Modal client deserialization
        "preprocessed_example_available": True,
        "long_motion_checked": long,
        "model_files_available": True,
        "official_generate_cli_cpu_import": True,
        "simulated_cuda_lookup_in_cpu_probe": True,
        "gpu_started": False,
    }
    print("GPU IMAGE CPU PREFLIGHT:", summary, flush=True)
    return summary


@app.function(
    image=gpu_image,
    gpu="A100-80GB",
    cpu=4,
    memory=49152,
    volumes={
        "/models": weights.with_mount_options(read_only=True),
        "/results": results,
    },
    timeout=720,  # 12-minute HARD GPU container limit for the diagnostic
    min_containers=0,
    max_containers=1,
    scaledown_window=15,
)
def generate_short_preview(steps: int = 20, long: bool = False) -> dict:
    import subprocess
    import time
    import os
    import signal
    from uuid import uuid4

    import torch
    from flash_attn import flash_attn_func

    if steps not in (4, 10, 20):
        raise ValueError("Choose one of 4, 10, or 20 sampling steps.")

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable on this Modal GPU container")
    print("GPU:", torch.cuda.get_device_name(0), flush=True)
    print("VRAM total GiB:", round(torch.cuda.get_device_properties(0).total_memory / 2**30, 1), flush=True)
    print("PyTorch:", torch.__version__, "CUDA:", torch.version.cuda, flush=True)
    print("FlashAttention import: OK", flush=True)

    mandatory = [
        ROOT / "config.json",
        ROOT / "models_t5_umt5-xxl-enc-bf16.pth",
        ROOT / "models_clip_open-clip-xlm-roberta-large-vit-huge-14.pth",
        ROOT / "Wan2.1_VAE.pth",
    ] + sorted(ROOT.glob("diffusion_pytorch_model-*-of-00004.safetensors"))
    if len(mandatory) != 8:
        raise RuntimeError("Expected exactly four DiT shards and four other model files")
    for path in mandatory:
        if not path.is_file() or not path.stat().st_size:
            raise RuntimeError("Missing stored checkpoint " + str(path))
    if not (ROOT / "google/umt5-xxl/tokenizer.json").is_file():
        raise RuntimeError("UMT5 tokenizer is missing")
    if not (ROOT / "xlm-roberta-large/tokenizer.json").is_file():
        raise RuntimeError("XLM-R tokenizer is missing")

    prepared = LONG_PREPARED if long else PREPARED
    output_dir = LONG_OUT_DIR if long else OUT_DIR
    frame_num = 77 if long else 17

    if long:
        import json
        manifest_path = prepared / "manifest.json"
        if not manifest_path.is_file():
            raise RuntimeError("Run modal run preprocess_long.py first")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("fps") != 30 or manifest.get("frames") != 90:
            raise RuntimeError("Long assets are not 3 seconds at 30 FPS")

    for name in ("src_ref.png", "src_pose.mp4", "src_face.mp4"):
        p = prepared / name
        if not p.is_file() or p.stat().st_size < 100:
            raise RuntimeError(
                "Persisted preprocessed input missing: " + name
                + ". First run: modal run preprocess_smoke.py"
            )

    output_dir.mkdir(parents=True, exist_ok=True)
    video_path = output_dir / ("preview-" + uuid4().hex[:12] + ".mp4")
    command = [
        "python", "-u", "generate.py",
        "--task", "animate-14B",
        "--ckpt_dir", str(ROOT),
        "--src_root_path", str(prepared),
        "--refert_num", "1",
        "--frame_num", str(frame_num),  # 17 short or 77 long (two segments).
        "--sample_steps", str(steps),    # 20 is official Wan Animate baseline
        "--sample_guide_scale", "1",
        # On a single A100 80GB, avoid the ~11 GB T5-XXL CPU bottleneck.
        # Wan's recommended A14B single-GPU recipe uses the dtype
        # conversion + offloading combination without --t5_cpu.
        "--offload_model", "True",
        "--convert_model_dtype",
        "--base_seed", "42",
        "--save_file", str(video_path),
    ]
    print("Official Wan command:", " ".join(command), flush=True)
    started = time.monotonic()
    # Inherit stdout/stderr so Wan's tqdm/INFO logs stream into Modal.
    # Also print GPU utilization once per minute so long encoding/denoising
    # periods are distinguishable from a stalled container.
    # Start in its own process group so children are cleaned up on failure.
    process = subprocess.Popen(
        command,
        cwd="/opt/Wan2.2",
        start_new_session=True,
    )
    deadline = time.monotonic() + 660  # 11-min subprocess; 12-min hard Modal cap
    try:
        while process.poll() is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, 660)
            try:
                process.wait(timeout=min(60, remaining))
            except subprocess.TimeoutExpired:
                pass
            if process.poll() is None:
                print(
                    "HEARTBEAT: elapsed_sec=",
                    round(time.monotonic() - started),
                    "| GPU utilization and VRAM below:",
                    flush=True,
                )
                subprocess.run(
                    [
                        "nvidia-smi",
                        "--query-gpu=utilization.gpu,memory.used,memory.total",
                        "--format=csv,noheader,nounits",
                    ],
                    check=False,
                    timeout=15,
                )
        if process.returncode:
            raise subprocess.CalledProcessError(process.returncode, command)
    finally:
        if process.poll() is None:
            print("Stopping timed-out Wan generation process group.", flush=True)
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait(timeout=5)
    if not video_path.is_file() or video_path.stat().st_size < 1000:
        raise RuntimeError("Wan generate.py exited without a valid saved MP4")
    results.commit()
    summary = {
        "video_generated": True,
        "result_volume": "wan22-animate-test-results",
        "remote_path": str(video_path).removeprefix("/results"),
        "bytes": video_path.stat().st_size,
        "elapsed_seconds": round(time.monotonic() - started, 1),
        "gpu": torch.cuda.get_device_name(0),
        "sampling_steps": steps,
        "frame_num": frame_num,
        "input_frames": 90 if long else 12,
        "expected_duration_seconds": 3.0 if long else 0.4,
        "input_set": "long_3_seconds" if long else "short_preview",
        "t5_on_gpu": True,
        "convert_model_dtype": True,
        "mode": "animation_only",
        "production_endpoint_changed": False,
    }
    print("VIDEO SAVED:", summary, flush=True)
    return summary


@app.local_entrypoint()
def main(execute: bool = False, steps: int = 20, long: bool = False):
    if steps not in (4, 10, 20):
        raise ValueError("Choose --steps 4, --steps 10, or --steps 20.")

    print("Checking the GPU image, sibling module imports and persisted inputs")
    print("using CPU only; no GPU is allocated for this preflight.")
    print("Selected input:", "3 seconds at 30 FPS" if long else "short diagnostic")
    check_gpu_image_cpu.remote(long)

    if not execute:
        print("CPU preflight passed. No GPU has been requested.")
        print("To authorize a PAID, bounded A100 GPU test, explicitly run:")
        print("  modal run gpu_smoke.py --execute --steps 20" + (" --long" if long else ""))
        return

    print("Explicit --execute received; starting one A100-80GB GPU test.")
    print("Sampling steps:", steps)
    print("Expected output duration:", "3 seconds" if long else "0.4 seconds")
    print("Maximum GPU function runtime: 720 seconds (12 minutes).")
    result = generate_short_preview.remote(steps, long)
    print("RESULT:", result)
