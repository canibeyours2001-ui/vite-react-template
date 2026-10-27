"""Download official Wan2.2-Animate preprocessing checkpoints into Modal Volume.

Run from Oracle VPS: modal run download_models.py
CPU only. This does NOT download the full ~72GB model or start GPU inference.
"""

import modal

app = modal.App("wan22-animate-checkpoint-download")

volume = modal.Volume.from_name("wan22-animate-models", create_if_missing=False)
image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "huggingface_hub>=0.35,<2",
    "hf_xet>=1.1,<2",
)

MODEL_ID = "Wan-AI/Wan2.2-Animate-14B"
OUTPUT_PATH = "/models/Wan2.2-Animate-14B"


@app.function(
    image=image,
    volumes={"/models": volume},
    cpu=2,
    memory=4096,
    timeout=7200,
    min_containers=0,
    max_containers=1,
)
def download_preprocessing_checkpoints() -> dict:
    import os
    from pathlib import Path

    from huggingface_hub import snapshot_download

    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    path = Path(OUTPUT_PATH)
    path.mkdir(parents=True, exist_ok=True)

    print("Downloading official preprocessing checkpoints only (roughly 4.17 GB).")
    print("Source:", MODEL_ID)
    print("Destination: persistent Modal Volume, not the Oracle VPS disk.")
    print("No GPU requested. Full Animate-14B weights are NOT downloaded.")

    snapshot_download(
        repo_id=MODEL_ID,
        allow_patterns=["process_checkpoint/**"],
        local_dir=str(path),
        max_workers=4,
    )

    checkpoint_dir = path / "process_checkpoint"
    required = [
        checkpoint_dir / "det",
        checkpoint_dir / "pose2d",
        checkpoint_dir / "sam2",
    ]
    for item in required:
        if not item.is_dir() or not any(p.is_file() for p in item.rglob("*")):
            raise RuntimeError("Checkpoint incomplete; missing content in " + str(item))

    file_count = 0
    byte_count = 0
    for item in checkpoint_dir.rglob("*"):
        if item.is_file():
            file_count += 1
            byte_count += item.stat().st_size

    volume.commit()
    info = {
        "source": MODEL_ID,
        "stored_path": str(checkpoint_dir),
        "files": file_count,
        "size_gb": round(byte_count / 1e9, 2),
        "gpu": "none",
        "full_model_downloaded": False,
    }
    print("Preprocessing checkpoints saved to Modal Volume:", info)
    return info


@app.local_entrypoint()
def main():
    result = download_preprocessing_checkpoints.remote()
    print("Done:", result)
