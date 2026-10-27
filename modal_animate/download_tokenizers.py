"""Download and validate Wan2.2 Animate tokenizer files without duplicate model weights.

WAN's native WanAnimate loader expects local:
    /models/Wan2.2-Animate-14B/google/umt5-xxl/
    /models/Wan2.2-Animate-14B/xlm-roberta-large/
The previous 10-file download fetched the large tensors, not these tokenizers.

Run: modal run download_tokenizers.py
This uses Modal CPU only and preserves model files, preprocess assets and bot.
"""

import modal

app = modal.App("wan22-animate-tokenizer-download")
volume = modal.Volume.from_name("wan22-animate-models", create_if_missing=False)
image = modal.Image.debian_slim(python_version="3.11").pip_install(
    # transformers==4.51.3 requires huggingface-hub>=0.30.0,<1.0.
    # Keep both in the same compatible range to avoid pip ResolutionImpossible.
    "huggingface_hub>=0.34,<1.0",
    "hf_xet>=1.0,<2",
    "transformers==4.51.3",
    "sentencepiece>=0.2,<1",
)
REPO = "Wan-AI/Wan2.2-Animate-14B"
ROOT = "/models/Wan2.2-Animate-14B"
DIRS = ("google/umt5-xxl", "xlm-roberta-large")
SUFFIXES = (".json", ".model", ".txt", ".vocab", ".bpe")
# Only very small metadata/tokenizer files, never model weights.
MAX_FILE_BYTES = 150_000_000
MAX_TOTAL_BYTES = 250_000_000


@app.function(
    image=image,
    volumes={"/models": volume},
    cpu=2,
    memory=4096,
    timeout=1800,
    min_containers=0,
    max_containers=1,
)
def download_tokenizers():
    import os
    from pathlib import Path
    from huggingface_hub import HfApi, snapshot_download
    from transformers import AutoTokenizer

    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    root = Path(ROOT)
    remote = HfApi().model_info(REPO, files_metadata=True)
    selected = []
    total_bytes = 0
    for file in remote.siblings or []:
        name = file.rfilename
        if not any(name.startswith(d + "/") for d in DIRS):
            continue
        if Path(name).suffix not in SUFFIXES:
            continue
        # Only files directly in expected tokenizer roots. Avoid the extra
        # ONNX and alternative pretrained-model subdirectories.
        if Path(name).parent.as_posix() not in DIRS:
            continue
        size = file.size if file.size is not None else (file.lfs or {}).get("size")
        if not isinstance(size, int) or size < 1 or size > MAX_FILE_BYTES:
            raise RuntimeError("Unexpected tokenizer file size: " + name)
        total_bytes += size
        selected.append(name)
    if not selected or total_bytes > MAX_TOTAL_BYTES:
        raise RuntimeError("Tokenizer safety limit or file listing failed")
    for folder in DIRS:
        if not any(name.startswith(folder + "/") for name in selected):
            raise RuntimeError("Missing tokenizer directory in HF source: " + folder)
    print("Download official tokenizer metadata:", sorted(selected))
    print("Remote total MB:", round(total_bytes / 1e6, 2))
    print("Pinned commit:", remote.sha)
    print("No GPU and no root model weights requested.")

    snapshot_download(
        repo_id=REPO,
        revision=remote.sha,
        allow_patterns=selected,
        local_dir=ROOT,
        max_workers=4,
    )

    # Verify that Transformers can use the exact local paths expected by Wan,
    # so we detect missing tokenizer config before paying for inference GPU.
    report = {}
    os.environ["HF_HUB_OFFLINE"] = "1"
    for folder in DIRS:
        full = root / folder
        tok = AutoTokenizer.from_pretrained(str(full), local_files_only=True)
        tokens = tok("A person is moving.", return_tensors=None)
        if not tokens["input_ids"]:
            raise RuntimeError("Tokenizer did not produce token IDs: " + folder)
        report[folder] = {
            "tokenizer_class": type(tok).__name__,
            "token_count": len(tokens["input_ids"]),
        }
        print("Local tokenizer validation OK:", folder, report[folder])

    volume.commit()
    print("Tokenizers saved and validated; no GPU used.")
    return report


@app.local_entrypoint()
def main():
    download_tokenizers.remote()
