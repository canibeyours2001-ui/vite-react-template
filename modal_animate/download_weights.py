"""Fetch the official Wan2.2-Animate-14B core inference weights into Modal Volume.

CPU + storage only; no GPU. Does not touch existing Wan TI2V services.
Usage: modal run download_weights.py
"""

from pathlib import Path

import modal

MODEL_ID = "Wan-AI/Wan2.2-Animate-14B"
MODEL_DIR = Path("/models/Wan2.2-Animate-14B")
MAX_TOTAL_BYTES = 60_000_000_000

# Official repo root files required by the baseline animation inference path.
# The already-downloaded process_checkpoint directory remains untouched.
# Optional replacement/relighting weights and redundant XLM-R model formats
# are intentionally excluded for the first animation-only test.
REQUIRED = (
    "config.json",
    "configuration.json",
    "diffusion_pytorch_model.safetensors.index.json",
    "Wan2.1_VAE.pth",
    "models_clip_open-clip-xlm-roberta-large-vit-huge-14.pth",
    "models_t5_umt5-xxl-enc-bf16.pth",
    "diffusion_pytorch_model-00001-of-00004.safetensors",
    "diffusion_pytorch_model-00002-of-00004.safetensors",
    "diffusion_pytorch_model-00003-of-00004.safetensors",
    "diffusion_pytorch_model-00004-of-00004.safetensors",
)

app = modal.App("wan22-animate-core-weight-download")
volume = modal.Volume.from_name("wan22-animate-models", create_if_missing=False)
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("huggingface_hub>=1.0,<2", "hf_xet>=1.0,<2")
)


@app.function(
    image=image,
    volumes={"/models": volume},
    cpu=2,
    memory=4096,
    timeout=14400,
    min_containers=0,
    max_containers=1,
)
def download_core_weights() -> dict:
    import os
    from huggingface_hub import HfApi, snapshot_download

    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    MODEL_DIR.mkdir(parents=True, exist_ok=True)

    info = HfApi().model_info(MODEL_ID, files_metadata=True)
    files = {s.rfilename: s for s in (info.siblings or [])}
    missing = [name for name in REQUIRED if name not in files]
    if missing:
        raise RuntimeError("Official model files missing: " + ", ".join(missing))

    sizes: dict[str, int] = {}
    for name in REQUIRED:
        sibling = files[name]
        size = sibling.size
        if size is None and sibling.lfs:
            size = sibling.lfs.get("size")
        if size is None or size <= 0:
            raise RuntimeError("Cannot verify Hugging Face file size for " + name)
        sizes[name] = int(size)

    expected_total = sum(sizes.values())
    if expected_total > MAX_TOTAL_BYTES:
        raise RuntimeError("Safety limit exceeded: requested core files total over 60 GB")
    print("Official repository:", MODEL_ID)
    print("Pinned revision:", info.sha)
    print("Expected core file total (GB):", round(expected_total / 1e9, 2))
    print("Destination: Modal volume wan22-animate-models")
    print("CPU-only operation. No GPU video generation.")
    print("Existing process_checkpoint/ and other Modal volumes are preserved.")

    total_present = 0
    for name in REQUIRED:
        target = MODEL_DIR / name
        target.parent.mkdir(parents=True, exist_ok=True)
        expected = sizes[name]
        if target.is_file() and target.stat().st_size == expected:
            total_present += 1
            print("Already complete:", name)
            continue

        print("Downloading:", name, "(GB:", round(expected / 1e9, 2), ")")
        snapshot_download(
            repo_id=MODEL_ID,
            revision=info.sha,
            allow_patterns=[name],
            local_dir=str(MODEL_DIR),
            max_workers=2,
        )
        if not target.is_file() or target.stat().st_size != expected:
            raise RuntimeError("Downloaded size validation failed for " + name)

        # Make each completed item persistent in case a later download fails.
        volume.commit()
        total_present += 1
        print("Saved:", name, "|", total_present, "/", len(REQUIRED))

    for name, expected in sizes.items():
        target = MODEL_DIR / name
        if not target.is_file() or target.stat().st_size != expected:
            raise RuntimeError("Final validation failed: " + name)

    checkpoint = MODEL_DIR / "process_checkpoint"
    checkpoint_found = checkpoint.is_dir() and any(checkpoint.iterdir())
    volume.commit()
    result = {
        "source": MODEL_ID,
        "revision": info.sha,
        "core_files": len(REQUIRED),
        "core_size_gb": round(expected_total / 1e9, 2),
        "preprocessing_checkpoint_found": checkpoint_found,
        "gpu_used": False,
        "model_inference_enabled": False,
    }
    print("Core weights download complete:", result)
    return result


@app.local_entrypoint()
def main():
    download_core_weights.remote()
