"""Isolated authenticated Modal service for Telegram Wan2.2 Animate 14B.

Deploy on purpose: modal deploy motion_service.py
Create the wan22-motion-flags secret with MOTION_GPU_ENABLED=0 before deploy.\nThe HTTP endpoint deploys WITHOUT launching any GPU.
To allow new paid jobs: modal secret create wan22-motion-flags MOTION_GPU_ENABLED=1
and redeploy, then explicitly configure the Telegram Worker secrets.

This service does not modify the existing TI2V 5B app or Telegram bot.
"""
import modal
from pathlib import Path
from preprocess_smoke import preprocess_image
from gpu_smoke import gpu_image

# Modal 1.x mounts only the function module automatically. Imported sibling
# files must be included explicitly in each remote container image.

app = modal.App("wan22-animate-telegram")
weights = modal.Volume.from_name("wan22-animate-models", create_if_missing=False)
results = modal.Volume.from_name("wan22-animate-test-results", create_if_missing=False)

# Existing generated Motion API secret: MOTION_API_KEY
AUTH = modal.Secret.from_name("wan22-animate-auth")
# Separate *disabled by default* authorization for billable generation.
FLAGS = modal.Secret.from_name("wan22-motion-flags", required_keys=["MOTION_GPU_ENABLED"])

api_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "fastapi>=0.115,<1", "python-multipart>=0.0.12,<1",
        "pillow>=11,<13",
    )
    # motion_service.py imports gpu_smoke -> preprocess_smoke at module
    # import time; without these mounts, API containers crash on startup.
    .add_local_python_source("preprocess_smoke", "gpu_smoke")
)

# Both function containers must have the sibling imports on PYTHONPATH.
# This adds only source files; it does not start a GPU or download weights.
render_image = gpu_image.add_local_python_source("gpu_smoke")

MODEL = Path("/models/Wan2.2-Animate-14B")
OUTPUT_ROOT = Path("/results/telegram-motion/generated")


@app.function(
    image=render_image,
    volumes={"/models": weights.with_mount_options(read_only=True), "/results": results},
    gpu="A100-80GB",
    cpu=4,
    memory=49152,
    timeout=1200,
    max_containers=1,
    min_containers=0,
    scaledown_window=15,
)
def render_motion(image_bytes: bytes, video_bytes: bytes, steps: int = 20, quality: str = "standard") -> dict:
    """Preprocess user inputs and generate <=3 seconds in an isolated paid job."""
    import json
    import os
    import signal
    import subprocess
    import tempfile
    import time
    from uuid import uuid4
    from PIL import Image

    if steps != 20:
        raise ValueError("Only official 20-step sampling is supported for Telegram.")
    if quality not in ("standard", "hq"):
        raise ValueError("Quality must be standard or hq")
    # HQ is opt-in to avoid unexpectedly higher A100 charges.
    # A shorter 49-frame HQ window reduces peak VRAM pressure on 80 GB A100.
    area = (854, 480) if quality == "hq" else (640, 360)
    segment_frames = 49 if quality == "hq" else 77
    print("Motion settings:", quality, "target area:", area,
          "segment frames:", segment_frames, flush=True)
    if not image_bytes or len(image_bytes) > 5 * 1024 * 1024:
        raise ValueError("Image must be at most 5 MB.")
    if not video_bytes or len(video_bytes) > 20 * 1024 * 1024:
        raise ValueError("Video must be at most 20 MB.")

    def run(cmd, cwd=None, timeout=900):
        print("$", " ".join(cmd), flush=True)
        subprocess.run(cmd, cwd=cwd, timeout=timeout, check=True)

    with tempfile.TemporaryDirectory(prefix="wan-motion-") as temp:
        tempdir = Path(temp)
        # Upstream copies this file to src_ref.png without re-encoding.
        # OpenCV chooses its decoder from the content signature, so JPEG
        # bytes remain readable even at Wan's fixed src_ref.png path.
        # This bypasses the observed libpng/zlib decode failure.
        reference = tempdir / "reference.jpg"
        raw_video = tempdir / "raw_video.mp4"
        reference_out = tempdir / "processed"
        reference_out.mkdir()
        with Image.open(__import__("io").BytesIO(image_bytes)) as im:
            if im.format not in ("JPEG", "PNG", "WEBP") or max(im.size) > 4096:
                raise ValueError("Invalid image format or excessive dimensions")
            im.convert("RGB").save(
                reference, format="JPEG", quality=97, subsampling=0,
            )
        raw_video.write_bytes(video_bytes)
        probe = subprocess.check_output(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(raw_video)],
            text=True, timeout=20,
        ).strip()
        duration = float(probe)
        if not (1 <= duration <= 10):
            raise ValueError("Driving video must contain 1-10 seconds of footage.")
        duration = min(duration, 3.0)
        # Wan Animate expects 4n+1 frame window. 90-frame input is trimmed after
        # two 77-frame segments, then emitted at the official 30 FPS.
        frame_count = int(duration * 30)
        if frame_count < 30:
            raise ValueError("Too few source frames")
        processed_video = tempdir / "drive.mp4"
        run([
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(raw_video), "-t", str(duration),
            "-vf", f"fps=30,scale={area[0]}:-2", "-an", "-c:v", "libx264",
            "-pix_fmt", "yuv420p", str(processed_video),
        ], timeout=120)
        run([
            "python", "-u", "wan/modules/animate/preprocess/preprocess_data.py",
            "--ckpt_path", str(MODEL / "process_checkpoint"),
            "--video_path", str(processed_video),
            "--refer_path", str(reference),
            "--save_path", str(reference_out),
            "--resolution_area", str(area[0]), str(area[1]), "--fps", "30",
        ], cwd="/opt/Wan2.2", timeout=500)
        for name in ("src_ref.png", "src_pose.mp4", "src_face.mp4"):
            file = reference_out / name
            if not file.is_file() or file.stat().st_size < 100:
                raise RuntimeError("Preprocessing output is missing: " + name)
        # Check the exact reference passed to Wan BEFORE loading the 14B
        # checkpoints. Decode in a separate Python process just like Wan.
        src_ref = reference_out / "src_ref.png"
        with src_ref.open("rb") as fp:
            if fp.read(3) != b"\xff\xd8\xff":
                raise RuntimeError("Reference output is not normalized JPEG data")
        probe_code = (
            "import cv2,sys; "
            "im=cv2.imread(sys.argv[1], cv2.IMREAD_COLOR); "
            "assert im is not None and im.ndim == 3 and im.shape[2] == 3, "
            "'OpenCV cannot read src_ref.png'; "
            "print('REFERENCE_DECODER_OK:', im.shape, flush=True)"
        )
        decoder = subprocess.run(
            ["python", "-c", probe_code, str(src_ref)],
            capture_output=True, text=True, timeout=25,
        )
        if decoder.returncode != 0:
            raise RuntimeError("Reference output failed independent OpenCV decode")
        print(decoder.stdout.strip(), flush=True)
        name = "motion-" + uuid4().hex
        dest = OUTPUT_ROOT / (name + ".mp4")
        OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
        command = [
            "python", "-u", "generate.py", "--task", "animate-14B",
            "--ckpt_dir", str(MODEL),
            "--src_root_path", str(reference_out),
            "--frame_num", str(segment_frames),
            "--refert_num", "1",
            "--sample_steps", str(steps),
            "--sample_guide_scale", "1",
            "--offload_model", "True",
            "--convert_model_dtype",
            "--base_seed", "42",
            "--save_file", str(dest),
        ]
        started = time.monotonic()
        process = subprocess.Popen(command, cwd="/opt/Wan2.2", start_new_session=True)
        try:
            process.wait(timeout=650)
            if process.returncode:
                raise subprocess.CalledProcessError(process.returncode, command)
        finally:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                    process.wait(timeout=8)
                except (ProcessLookupError, subprocess.TimeoutExpired):
                    try: os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError: pass
        if not dest.is_file() or dest.stat().st_size < 1000:
            raise RuntimeError("Wan failed to produce valid MP4")

        # Wan-Animate produces silent video. Reuse the FIRST 3 seconds of the
        # driving video's own audio if it has an audio stream; this is a cheap
        # FFmpeg remux, not an additional generative model or GPU render.
        # If the driving video has no audio, leave the result silent.
        audio_included = False
        audio_probe = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=index", "-of", "csv=p=0",
             str(raw_video)],
            capture_output=True, text=True, timeout=20,
        )
        if audio_probe.returncode == 0 and audio_probe.stdout.strip():
            with_audio = OUTPUT_ROOT / (name + "-mux.mp4")
            try:
                run([
                    "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-y", "-i", str(dest), "-i", str(raw_video),
                    "-map", "0:v:0", "-map", "1:a:0",
                    "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
                    "-t", str(duration), "-shortest",
                    "-movflags", "+faststart", str(with_audio)
                ], timeout=90)
                if not with_audio.is_file() or with_audio.stat().st_size < 1000:
                    raise RuntimeError("Audio remux did not create a valid MP4")
                os.replace(with_audio, dest)
                audio_included = True
            except (subprocess.SubprocessError, RuntimeError, OSError) as exc:
                print("Original audio remux failed; preserving silent video:",
                      type(exc).__name__, flush=True)
                with_audio.unlink(missing_ok=True)
        if dest.stat().st_size > 45 * 1024 * 1024:
            dest.unlink()
            raise RuntimeError("MP4 exceeds Telegram file delivery limit")
        results.commit()
        print("MOTION_VIDEO_SAVED:", str(dest), flush=True)
        return {
            "status": "succeeded", "video_path": str(dest).removeprefix("/results"),
            "seconds": round(duration, 2),
            "quality": quality, "processing_area": list(area),
            "audio_included": audio_included,
            "bytes": dest.stat().st_size, "elapsed_gpu_seconds": round(time.monotonic()-started, 1),
        }


@app.function(
    image=api_image,
    secrets=[AUTH, FLAGS],
    volumes={"/results": results.with_mount_options(read_only=True)},
    timeout=180,
    min_containers=0,
    max_containers=2,
)
@modal.asgi_app()
def web_api():
    import io
    import os
    import re
    import secrets
    import subprocess
    import tempfile
    from pathlib import Path
    from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
    from fastapi.responses import FileResponse
    from PIL import Image, UnidentifiedImageError

    api = FastAPI(title="Wan Animate 14B Telegram", version="0.1.0")
    call_pattern = re.compile(r"^fc-[a-zA-Z0-9_-]{8,96}$")
    MAX_IMAGE = 5 * 1024 * 1024
    MAX_VIDEO = 20 * 1024 * 1024

    def check_auth(authorization: str | None):
        secret = os.environ.get("MOTION_API_KEY", "")
        candidate = authorization[7:] if authorization and authorization.startswith("Bearer ") else ""
        if not secret or not secrets.compare_digest(candidate, secret):
            raise HTTPException(401, "Unauthorized")

    def enabled():
        return os.environ.get("MOTION_GPU_ENABLED") == "1"

    def validate_id(call_id: str):
        if not call_pattern.fullmatch(call_id):
            raise HTTPException(400, "Invalid job id")

    def poll(call_id: str):
        validate_id(call_id)
        try:
            call = modal.FunctionCall.from_id(call_id)
            return call.get(timeout=0)
        except TimeoutError:
            return None
        except subprocess.CalledProcessError:
            # Remote generate.py finished unsuccessfully. Do not leave Telegram
            # /motion_status stuck on "running" or expose the private command.
            return {"status": "failed"}
        except Exception as exc:
            # Never expose private Modal traceback / request bytes to callers.
            print("Motion job status retrieval failed:", type(exc).__name__, flush=True)
            raise HTTPException(502, "Motion job failed or result is unavailable") from None

    @api.get("/health")
    def health():
        return {"ok": True, "service": "wan22-animate-telegram",
                "gpu_generation_enabled": enabled()}

    @api.post("/v1/motion/jobs")
    async def submit(
        image: UploadFile = File(...), driving_video: UploadFile = File(...),
        quality: str = Form("standard"),
        authorization: str | None = Header(default=None),
    ):
        check_auth(authorization)
        if not enabled():
            raise HTTPException(503, "Motion GPU submissions disabled by administrator")
        if quality not in ("standard", "hq"):
            raise HTTPException(400, "Invalid quality preset")
        im_bytes = await image.read(MAX_IMAGE + 1)
        vi_bytes = await driving_video.read(MAX_VIDEO + 1)
        if not im_bytes or len(im_bytes) > MAX_IMAGE:
            raise HTTPException(400, "Reference image must be at most 5 MB")
        if not vi_bytes or len(vi_bytes) > MAX_VIDEO:
            raise HTTPException(400, "Driving video must be at most 20 MB")
        try:
            with Image.open(io.BytesIO(im_bytes)) as picture:
                if picture.format not in ("PNG", "JPEG", "WEBP") or max(picture.size) > 4096:
                    raise ValueError()
                picture.verify()
        except (UnidentifiedImageError, ValueError, OSError):
            raise HTTPException(400, "Invalid reference image") from None
        with tempfile.TemporaryDirectory() as d:
            video = Path(d) / "motion.mp4"
            video.write_bytes(vi_bytes)
            try:
                info = subprocess.check_output(
                    ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                     "-of", "default=noprint_wrappers=1:nokey=1", str(video)],
                    text=True, timeout=12).strip()
                duration = float(info)
            except (ValueError, subprocess.SubprocessError):
                raise HTTPException(400, "Invalid driving video") from None
        if not (1 <= duration <= 10):
            raise HTTPException(400, "Driving video must be 1–10 seconds long")
        call = await render_motion.spawn.aio(im_bytes, vi_bytes, 20, quality)
        return {"id": call.object_id, "status": "running",
                "quality": quality, "estimated_output_seconds": min(3, duration)}

    @api.get("/v1/motion/jobs/{call_id}")
    def status(call_id: str, authorization: str | None = Header(default=None)):
        check_auth(authorization)
        response = poll(call_id)
        return {
            "id": call_id,
            "status": "running" if response is None else response.get("status", "succeeded"),
        }

    @api.get("/v1/motion/jobs/{call_id}/video")
    def video(call_id: str, authorization: str | None = Header(default=None)):
        check_auth(authorization)
        outcome = poll(call_id)
        if outcome is None:
            raise HTTPException(409, "Motion video not ready")
        if outcome.get("status") == "failed":
            raise HTTPException(409, "Motion generation failed")
        relative = outcome.get("video_path", "")
        if not re.fullmatch(r"/telegram-motion/generated/motion-[a-f0-9]{32}\.mp4", relative):
            raise HTTPException(502, "Invalid render output location")
        results.reload()
        file = Path("/results") / relative.lstrip("/")
        if not file.is_file():
            raise HTTPException(404, "Rendered MP4 not found")
        return FileResponse(str(file), media_type="video/mp4", filename="wan-motion.mp4")

    return api
