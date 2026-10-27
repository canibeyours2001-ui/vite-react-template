"""Read-only validation of the downloaded official Wan2.2 Animate-14B assets.

Run: modal run check_readiness.py
Runs on CPU only, does not start GPU or download additional files.
"""

import json
from pathlib import Path

import modal

app = modal.App("wan22-animate-readiness-check")
model_volume = modal.Volume.from_name("wan22-animate-models", create_if_missing=False)
model_image = modal.Image.debian_slim(python_version="3.11")

ROOT = Path("/models/Wan2.2-Animate-14B")
CORE = (
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
PREPROCESS_MANDATORY = (
    "process_checkpoint/det/yolov10m.onnx",
    "process_checkpoint/pose2d/vitpose_h_wholebody.onnx",
)
PREPROCESS_OPTIONAL_FOR_ANIMATION = (
    "process_checkpoint/sam2/sam2_hiera_large.pt",
)


@app.function(
    image=model_image,
    volumes={"/models": model_volume},
    cpu=1,
    memory=1024,
    timeout=180,
    min_containers=0,
    max_containers=1,
)
def verify_assets() -> dict:
    missing = []
    core_bytes = 0
    for name in CORE:
        file = ROOT / name
        if not file.is_file() or file.stat().st_size <= 0:
            missing.append(name)
        else:
            core_bytes += file.stat().st_size

    for name in PREPROCESS_MANDATORY:
        file = ROOT / name
        if not file.is_file() or file.stat().st_size <= 0:
            missing.append(name)

    optional = {name: (ROOT / name).is_file() for name in PREPROCESS_OPTIONAL_FOR_ANIMATION}

    # Validate the root diffusion weight index, including its shard references.
    # This is a metadata check, not an expensive cryptographic integrity scan.
    index_file = ROOT / "diffusion_pytorch_model.safetensors.index.json"
    index_shards = []
    if index_file.is_file():
        try:
            weight_map = json.loads(index_file.read_text(encoding="utf-8"))["weight_map"]
            index_shards = sorted(set(weight_map.values()))
            for shard in index_shards:
                if not isinstance(shard, str) or not (ROOT / shard).is_file():
                    missing.append("missing index shard: " + str(shard))
        except (ValueError, KeyError, TypeError, UnicodeError) as exc:
            missing.append("unreadable diffusion index: " + type(exc).__name__)
    result = {
        "readiness_check_passed": not missing,
        "missing": missing,
        "core_files_present": sum(
            1 for name in CORE if (ROOT / name).is_file() and (ROOT / name).stat().st_size > 0
        ),
        "expected_core_files": len(CORE),
        "core_size_gb": round(core_bytes / 1e9, 2),
        "diffusion_shards_indexed": len(index_shards),
        "optional_checkpoint_present": optional,
        "gpu_started": False,
        "runtime_or_inference_tested": False,
    }
    print(json.dumps(result, indent=2))
    if missing:
        raise RuntimeError("Model assets incomplete; review the 'missing' list above")
    return result


@app.local_entrypoint()
def main():
    verify_assets.remote()
