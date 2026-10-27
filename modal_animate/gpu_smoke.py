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
def check_gpu_image_cpu() -> dict:
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
    if "--task" not in inspect.stdout or "--src_root_path" not in inspect.stdout:
        raise RuntimeError("Unexpected Wan generate.py CLI; do NOT run paid GPU.")
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
    for filename in ("src_ref.png", "src_pose.mp4", "src_face.mp4"):
        needed.append(PREPARED / filename)
    for filename in needed:
        if not filename.is_file() or filename.stat().st_size == 0:
            raise RuntimeError("Missing preflight input: " + str(filename))

    summary = {
        "cpu_preflight_passed": True,
        "sibling_import": "preprocess_smoke",
        "flash_attention_import": "OK",
        "torch_version": str(torch.__version__),  # cast TorchVersion to built-in str for Modal client deserialization
        "preprocessed_example_available": True,
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
    timeout=1200,
    min_containers=0,
    max_containers=1,
    scaledown_window=15,
)
def generate_short_preview() -> dict:
    import subprocess
    import time
    from uuid import uuid4

    import torch
    from flash_attn import flash_attn_func

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

    for name in ("src_ref.png", "src_pose.mp4", "src_face.mp4"):
        p = PREPARED / name
        if not p.is_file() or p.stat().st_size < 100:
            raise RuntimeError(
                "Persisted preprocessed input missing: " + name
                + ". First run: modal run preprocess_smoke.py"
            )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    video_path = OUT_DIR / ("preview-" + uuid4().hex[:12] + ".mp4")
    command = [
        "python", "-u", "generate.py",
        "--task", "animate-14B",
        "--ckpt_dir", str(ROOT),
        "--src_root_path", str(PREPARED),
        "--refert_num", "1",
        "--frame_num", "17",             # 4n+1, one short segment.
        "--sample_steps", "4",           # low-quality diagnostic, not final output
        "--sample_guide_scale", "1",
        "--t5_cpu",                      # conserve 80 GB GPU memory
        "--offload_model", "True",
        "--base_seed", "42",
        "--save_file", str(video_path),
    ]
    print("Official Wan command:", " ".join(command), flush=True)
    started = time.monotonic()
    # The Modal function's hard timeout of 1200 seconds prevents runaway
    # inference charges. This process receives slightly less time for saving.
    subprocess.run(
        command,
        cwd="/opt/Wan2.2",
        check=True,
        timeout=1100,
    )
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
        "sampling_steps": 4,
        "frame_num": 17,
        "mode": "animation_only",
        "production_endpoint_changed": False,
    }
    print("VIDEO SAVED:", summary, flush=True)
    return summary


@app.local_entrypoint()
def main(execute: bool = False):
    print("Checking the GPU image, sibling module imports and persisted inputs")
    print("using CPU only; no GPU is allocated for this preflight.")
    check_gpu_image_cpu.remote()

    if not execute:
        print("CPU preflight passed. No GPU has been requested.")
        print("To authorize a PAID, bounded A100 GPU test, explicitly run:")
        print("  modal run gpu_smoke.py --execute")
        return

    print("Explicit --execute received; starting one A100-80GB GPU test.")
    print("Maximum GPU function runtime: 1200 seconds (20 minutes).")
    result = generate_short_preview.remote()
    print("RESULT:", result)
