"""CPU-only official Wan Animate preprocessing smoke test.

Uses the upstream sample image + driving video, not user secrets.
Runs the official preprocess_data.py (animation mode only) on a short clip.
It does not invoke generate.py, download model weights, or reserve a GPU.

Run on Oracle VPS: modal run preprocess_smoke.py
"""
import json
import subprocess
from pathlib import Path

import modal

app = modal.App("wan22-animate-preprocess-smoke")

# Mount only the already-downloaded checkpoint volume, as read-only.
models = modal.Volume.from_name("wan22-animate-models", create_if_missing=False)
MODEL = Path("/models/Wan2.2-Animate-14B")

# The upstream preprocessing module requires PyTorch, SAM2, ONNX Runtime,
# decord, and other dependencies even when running animation (not replacement).
# CPU-only ONNX Runtime will fall back to the CPUExecutionProvider if a CUDA
# provider is unavailable, but end-to-end CPU compatibility is not yet proven.
preprocess_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg", "libgl1", "libglib2.0-0", "libsm6", "libxext6")
    .pip_install(
        "torch==2.5.1",
        "torchvision==0.20.1",
        "numpy>=1.23.5,<2",
        "opencv-python-headless>=4.9,<5",
        "onnxruntime==1.22.1",
        "diffusers==0.35.1",
        "transformers==4.51.3",
        "accelerate>=1.1.1",
        "decord==0.6.0",
        "moviepy==1.0.3",
        "peft",
        "pandas",
        "matplotlib",
        "loguru",
        "sentencepiece",
        "imageio[ffmpeg]",
        "easydict",
        "ftfy",
        "dashscope",
        "scipy",
        "pillow",
    )
    .pip_install(
        "git+https://github.com/facebookresearch/sam2.git@0e78a118995e66bb27d78518c4bd9a3e95b4e266"
    )
    .run_commands("git clone --depth 1 https://github.com/Wan-Video/Wan2.2.git /opt/Wan2.2")
)


def run_checked(args: list[str], cwd: str | None = None) -> None:
    print("$", " ".join(args), flush=True)
    subprocess.run(args, cwd=cwd, check=True, timeout=700)


@app.function(
    image=preprocess_image,
    volumes={"/models": models.with_mount_options(read_only=True)},
    cpu=4,
    memory=16384,
    timeout=900,
    min_containers=0,
    max_containers=1,
)
def preprocess_upstream_demo() -> dict:
    repo = Path("/opt/Wan2.2")
    demo = repo / "examples/wan_animate/animate"
    source_video = demo / "video.mp4"
    source_image = demo / "image.jpeg"
    checkpoint = MODEL / "process_checkpoint"
    if not source_image.is_file() or not source_video.is_file():
        raise RuntimeError("Official demo inputs are unavailable in upstream checkout")
    if not (checkpoint / "pose2d/vitpose_h_wholebody.onnx").is_file():
        raise RuntimeError("ViTPose ONNX not found, or checkpoint volume not mounted")
    if not (checkpoint / "pose2d/vitpose_h_wholebody_data.bin").is_file():
        raise RuntimeError("ViTPose ONNX external data missing")

    work = Path("/tmp/animate-preprocess-demo")
    work.mkdir(exist_ok=True)
    short_video = work / "drive_short.mp4"
    output = work / "processed"
    output.mkdir(exist_ok=True)

    # A short demonstration input is cheaper than the full video.
    run_checked([
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(source_video), "-t", "1.5",
        "-vf", "fps=12,scale=640:-2",
        "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(short_video)
    ])

    # Basic animation: no FLUX, no SAM2 replacement, no pose retargeting.
    # These can be added after the low-cost smoke test succeeds.
    run_checked([
        "python", "wan/modules/animate/preprocess/preprocess_data.py",
        "--ckpt_path", str(checkpoint),
        "--video_path", str(short_video),
        "--refer_path", str(source_image),
        "--save_path", str(output),
        "--resolution_area", "640", "360",
        "--fps", "12",
    ], cwd=str(repo))

    expected = ("src_ref.png", "src_face.mp4", "src_pose.mp4")
    sizes = {}
    for name in expected:
        path = output / name
        if not path.is_file() or path.stat().st_size < 100:
            raise RuntimeError("Official preprocessing did not produce " + name)
        sizes[name] = path.stat().st_size
    result = {
        "preprocessing_passed": True,
        "outputs": sizes,
        "official_example_inputs": True,
        "gpu_started": False,
        "model_generation_started": False,
        "outputs_persisted": False,
        "warning": "Demo outputs are temporary; pass this stage before adding user uploads.",
    }
    print(json.dumps(result, indent=2))
    return result


@app.local_entrypoint()
def main():
    print("Running a CPU-only official preprocessing smoke test.")
    print("This builds a fairly large Python image and may incur CPU/storage costs.")
    print("It does not launch any GPU or full-model inference.")
    preprocess_upstream_demo.remote()
