"""Repair the ViTPose preprocessing checkpoint layout for official Wan2.2 Animate.

The Wan-AI HF repo currently exposes process_checkpoint/pose2d/
vitpose_h_wholebody.onnx as a directory of tensors, not an ONNX model file.
Wan's official preprocess_data.py expects an actual ONNX file at that name.

This CPU-only utility downloads Kijai's documented ViTPose-Huge ONNX export
and companion external data, verifies them, and installs them into the
Wan-expected path. Existing source directory is retained under a backup name.
Does not touch diffusion weights, other Modal volumes or production apps.

Usage: modal run repair_vitpose.py
"""

from pathlib import Path
import modal

app = modal.App("wan22-animate-vitpose-repair")
volume = modal.Volume.from_name("wan22-animate-models", create_if_missing=False)
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("huggingface_hub>=1.0,<2", "hf_xet>=1.0,<2", "onnx>=1.16,<2")
)

HF_MODEL = "Kijai/vitpose_comfy"
MODEL_ONNX = "onnx/vitpose_h_wholebody_model.onnx"
MODEL_BIN = "onnx/vitpose_h_wholebody_data.bin"
POSE = Path("/models/Wan2.2-Animate-14B/process_checkpoint/pose2d")
STAGE = POSE / ".vitpose_onnx_download"
FINAL_ONNX = POSE / "vitpose_h_wholebody.onnx"
FINAL_BIN = POSE / "vitpose_h_wholebody_data.bin"
BACKUP_DIR = POSE / "vitpose_h_wholebody.onnx.hf-tensor-backup"


def verify_onnx(model: Path, binary: Path) -> None:
    import onnx

    if not model.is_file() or not binary.is_file():
        raise RuntimeError("Missing ONNX model or its companion external data")
    # load_external_data=False avoids loading ~2.55 GB into memory.
    proto = onnx.load_model(str(model), load_external_data=False)
    if not proto.graph.node:
        raise RuntimeError("ViTPose ONNX has no compute graph")
    external_locations = set()
    for tensor in proto.graph.initializer:
        if tensor.data_location == onnx.TensorProto.EXTERNAL:
            location = next(
                (pair.value for pair in tensor.external_data if pair.key == "location"),
                "",
            )
            external_locations.add(location)
    if external_locations != {"vitpose_h_wholebody_data.bin"}:
        raise RuntimeError(
            "Unexpected ONNX external data locations: " + str(external_locations)
        )


@app.function(
    image=image,
    volumes={"/models": volume},
    cpu=2,
    memory=4096,
    timeout=7200,
    min_containers=0,
    max_containers=1,
)
def repair() -> dict:
    import os
    from huggingface_hub import HfApi, snapshot_download

    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    POSE.mkdir(parents=True, exist_ok=True)

    repo_info = HfApi().model_info(HF_MODEL, files_metadata=True)
    lookup = {f.rfilename: f for f in repo_info.siblings or []}
    expected = {}
    for name in (MODEL_ONNX, MODEL_BIN):
        f = lookup.get(name)
        if not f:
            raise RuntimeError("Missing expected file in community export: " + name)
        size = f.size if f.size is not None else (f.lfs or {}).get("size")
        if not isinstance(size, int) or size <= 0:
            raise RuntimeError("Unable to verify remote size for: " + name)
        expected[name] = size
    if expected[MODEL_BIN] > 3_000_000_000 or expected[MODEL_ONNX] > 2_000_000:
        raise RuntimeError("Export is larger than the expected safety limits")

    if FINAL_ONNX.is_file() and FINAL_BIN.is_file():
        if (
            FINAL_ONNX.stat().st_size == expected[MODEL_ONNX]
            and FINAL_BIN.stat().st_size == expected[MODEL_BIN]
        ):
            verify_onnx(FINAL_ONNX, FINAL_BIN)
            print("Already repaired. No new download needed.")
            return {"ready": True, "already_fixed": True, "gpu_started": False}
        raise RuntimeError("Existing target files differ from the known export; aborting")

    print("ViTPose-Huge source:", HF_MODEL)
    print("Pinned revision:", repo_info.sha)
    print("Downloading two files to staged Modal Volume directory.")
    print("No GPU started; Oracle VPS does not store these weights.")
    snapshot_download(
        repo_id=HF_MODEL,
        revision=repo_info.sha,
        allow_patterns=[MODEL_ONNX, MODEL_BIN],
        local_dir=str(STAGE),
        max_workers=2,
    )
    source_onnx = STAGE / MODEL_ONNX
    source_bin = STAGE / MODEL_BIN
    for source, name in ((source_onnx, MODEL_ONNX), (source_bin, MODEL_BIN)):
        if not source.is_file() or source.stat().st_size != expected[name]:
            raise RuntimeError("Size validation failed for: " + name)
    verify_onnx(source_onnx, source_bin)
    volume.commit()  # Preserve complete staged files before adjusting paths.

    if FINAL_ONNX.is_dir():
        if BACKUP_DIR.exists():
            raise RuntimeError("ViTPose backup already exists. Aborting to avoid overwrite.")
        FINAL_ONNX.rename(BACKUP_DIR)
        print("Preserved original tensor directory:", BACKUP_DIR)
    elif FINAL_ONNX.exists() and not FINAL_ONNX.is_file():
        raise RuntimeError("Unexpected checkpoint path type, refusing overwrite")

    # Both files must live in the same directory: the ONNX file references the
    # sibling .bin by relative name. Moves happen within the same Modal Volume.
    if not FINAL_BIN.exists():
        source_bin.rename(FINAL_BIN)
    elif FINAL_BIN.stat().st_size != expected[MODEL_BIN]:
        raise RuntimeError("Existing external data file has unexpected size")

    if not FINAL_ONNX.exists():
        source_onnx.rename(FINAL_ONNX)
    elif FINAL_ONNX.stat().st_size != expected[MODEL_ONNX]:
        raise RuntimeError("Existing ONNX model has unexpected size")

    verify_onnx(FINAL_ONNX, FINAL_BIN)
    volume.commit()
    result = {
        "ready": True,
        "source": HF_MODEL,
        "onnx_file": str(FINAL_ONNX),
        "companion_data_file": str(FINAL_BIN),
        "original_tensors_preserved": BACKUP_DIR.is_dir(),
        "gpu_started": False,
    }
    print("ViTPose ONNX repair complete:", result)
    return result


@app.local_entrypoint()
def main():
    repair.remote()
