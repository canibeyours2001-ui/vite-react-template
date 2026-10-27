"""Prepare three seconds of official Wan2.2 Animate demo motion at 30 FPS.

CPU-only. Uses the already-proven Wan preprocessing environment and checkpoint
volume; does not overwrite the short demo. The A100 is NOT started here.

Run: modal run preprocess_long.py
"""
import json
import shutil
import subprocess
from pathlib import Path

import modal
from preprocess_smoke import preprocess_image

app = modal.App("wan22-animate-preprocess-long")
model_volume = modal.Volume.from_name("wan22-animate-models", create_if_missing=False)
result_volume = modal.Volume.from_name("wan22-animate-test-results", create_if_missing=False)

image = preprocess_image.add_local_python_source("preprocess_smoke")
MODEL = Path("/models/Wan2.2-Animate-14B")
PREPARED = Path("/results/upstream-demo-long/preprocessed")
DURATION = 3.0
FPS = 30
EXPECTED_FRAMES = 90


def check_run(argv: list[str], cwd: str | None = None, timeout: int = 800) -> None:
    print("$", " ".join(argv), flush=True)
    subprocess.run(argv, cwd=cwd, check=True, timeout=timeout)


def video_frames(path: Path) -> int:
    args = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-count_frames", "-show_entries", "stream=nb_read_frames",
        "-of", "default=noprint_wrappers=1:nokey=1", str(path)
    ]
    output = subprocess.check_output(args, text=True, timeout=60).strip()
    return int(output)


@app.function(
    image=image,
    volumes={
        "/models": model_volume.with_mount_options(read_only=True),
        "/results": result_volume,
    },
    cpu=4,
    memory=16384,
    timeout=1500,
    min_containers=0,
    max_containers=1,
)
def prepare_long_motion() -> dict:
    repo = Path("/opt/Wan2.2")
    demo = repo / "examples/wan_animate/animate"
    driving_video = demo / "video.mp4"
    reference_image = demo / "image.jpeg"
    checkpoint = MODEL / "process_checkpoint"

    if not driving_video.is_file() or not reference_image.is_file():
        raise RuntimeError("Official Wan Animate example source files not present.")
    if not (checkpoint / "pose2d/vitpose_h_wholebody.onnx").is_file():
        raise RuntimeError("ViTPose checkpoint missing; model Volume must be mounted.")

    # Do not silently loop a shorter video or pad still frames: that would
    # produce unnatural motion and waste GPU money.
    duration_str = subprocess.check_output(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(driving_video)
        ],
        text=True, timeout=30,
    ).strip()
    source_duration = float(duration_str)
    print("Official demo source duration (seconds):", source_duration, flush=True)
    if source_duration + 0.03 < DURATION:
        raise RuntimeError(
            f"Official sample is only {source_duration:.2f}s, shorter than 3s. "
            "No repetitive looping was applied; choose a longer driving video."
        )

    work = Path("/tmp/animate-long-preprocess")
    work.mkdir(parents=True, exist_ok=True)
    normalized = work / "drive_3s_30fps.mp4"
    processed = work / "processed"
    processed.mkdir(exist_ok=True)

    check_run([
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(driving_video),
        "-t", str(DURATION), "-vf", f"fps={FPS},scale=640:-2",
        "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(normalized)
    ])

    num_input_frames = video_frames(normalized)
    if num_input_frames != EXPECTED_FRAMES:
        raise RuntimeError(
            f"Expected {EXPECTED_FRAMES} normalized frames, got {num_input_frames}; "
            "aborting before paid GPU."
        )
    print("Normalized driving video: 3 seconds, 30 FPS, 90 frames", flush=True)

    check_run([
        "python", "-u", "wan/modules/animate/preprocess/preprocess_data.py",
        "--ckpt_path", str(checkpoint),
        "--video_path", str(normalized),
        "--refer_path", str(reference_image),
        "--save_path", str(processed),
        "--resolution_area", "640", "360",
        "--fps", str(FPS),
    ], cwd=str(repo), timeout=1100)

    names = ("src_ref.png", "src_pose.mp4", "src_face.mp4")
    output_info = {}
    for name in names:
        f = processed / name
        if not f.is_file() or f.stat().st_size < 100:
            raise RuntimeError(f"Missing preprocessing output {name}")
        info = {"bytes": f.stat().st_size}
        if name.endswith(".mp4"):
            info["frames"] = video_frames(f)
            if info["frames"] != EXPECTED_FRAMES:
                raise RuntimeError(f"{name} has {info['frames']} frames, expected 90.")
        output_info[name] = info

    PREPARED.mkdir(parents=True, exist_ok=True)
    for name in names:
        shutil.copy2(processed / name, PREPARED / name)
    manifest = {
        "fps": FPS,
        "source_duration_seconds": DURATION,
        "frames": EXPECTED_FRAMES,
        "frame_num_per_generation_segment": 77,
        "generation_segments": 2,
        "resolution_target": [640, 360],
        "official_sample_inputs": True,
        "outputs": output_info,
    }
    (PREPARED / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    result_volume.commit()
    print("LONG PREPROCESS SAVED:", json.dumps(manifest, indent=2), flush=True)
    return {
        "preprocessing_passed": True,
        "duration_seconds": DURATION,
        "fps": FPS,
        "frames": EXPECTED_FRAMES,
        "saved_volume": "wan22-animate-test-results",
        "saved_path": "/upstream-demo-long/preprocessed",
        "gpu_started": False,
    }


@app.local_entrypoint()
def main():
    print("CPU-only 3-second/30-FPS preprocessing; no A100 will start.", flush=True)
    print("Uses an independent results path; short demo and model weights untouched.")
    result = prepare_long_motion.remote()
    print("RESULT:", result)
