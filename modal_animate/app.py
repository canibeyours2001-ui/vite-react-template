"""Wan2.2-Animate-14B: safe API preflight, no GPU jobs in this first stage.

This is an isolated Modal application. The official Wan preprocessing and
GPU inference will be added only after input/API validation and model storage
are verified. Never use this as a claim that Animate inference is deployed.
"""

import modal

app = modal.App("wan22-animate-14b")

api_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install("fastapi>=0.115,<1", "python-multipart>=0.0.12,<1", "pillow>=11,<13")
)


@app.function(
    image=api_image,
    secrets=[modal.Secret.from_name("wan22-animate-auth")],
    min_containers=0,
    max_containers=1,
    scaledown_window=30,
    timeout=120,
)
@modal.asgi_app()
def web_api():
    import io
    import json
    import os
    import subprocess
    import tempfile
    from pathlib import Path

    from fastapi import FastAPI, File, Header, HTTPException, UploadFile
    from PIL import Image, UnidentifiedImageError
    import secrets

    api = FastAPI(title="Wan2.2 Animate 14B — Safe Setup Stage", version="0.1.0")
    MAX_IMAGE_BYTES = 5 * 1024 * 1024
    MAX_VIDEO_BYTES = 20 * 1024 * 1024

    def authorize(authorization: str | None) -> None:
        configured = os.environ.get("MOTION_API_KEY", "")
        prefix = "Bearer "
        supplied = authorization[len(prefix):] if authorization and authorization.startswith(prefix) else ""
        if not configured or not secrets.compare_digest(supplied, configured):
            raise HTTPException(status_code=401, detail="Unauthorized")

    @api.get("/health")
    def health():
        return {
            "ok": True,
            "app": "wan22-animate-14b",
            "stage": "preflight-only",
            "gpu_generation_enabled": False,
        }

    @api.post("/v1/motion/preflight")
    async def preflight(
        image: UploadFile = File(...),
        driving_video: UploadFile = File(...),
        authorization: str | None = Header(default=None),
    ):
        authorize(authorization)
        image_bytes = await image.read(MAX_IMAGE_BYTES + 1)
        video_bytes = await driving_video.read(MAX_VIDEO_BYTES + 1)
        if not image_bytes or len(image_bytes) > MAX_IMAGE_BYTES:
            raise HTTPException(400, "Image must be 1 byte–5 MiB")
        if not video_bytes or len(video_bytes) > MAX_VIDEO_BYTES:
            raise HTTPException(400, "Driving video must be 1 byte–20 MiB")

        try:
            with Image.open(io.BytesIO(image_bytes)) as picture:
                picture.verify()
            with Image.open(io.BytesIO(image_bytes)) as picture:
                width, height = picture.size
                if picture.format not in {"JPEG", "PNG", "WEBP"}:
                    raise HTTPException(400, "Reference image must be JPEG, PNG or WebP")
                if max(width, height) > 4096:
                    raise HTTPException(400, "Reference image exceeds 4096px")
        except (UnidentifiedImageError, OSError, ValueError):
            raise HTTPException(400, "Invalid reference image") from None

        with tempfile.TemporaryDirectory(prefix="animate-preflight-") as temporary:
            video_path = Path(temporary) / "driving.mp4"
            video_path.write_bytes(video_bytes)
            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-show_entries", "stream=codec_type,width,height", "-of", "json", str(video_path)],
                capture_output=True, text=True, timeout=15, check=False,
            )
        if probe.returncode != 0:
            raise HTTPException(400, "Invalid or unsupported driving video")
        try:
            information = json.loads(probe.stdout)
            duration = float(information.get("format", {}).get("duration", 0))
            streams = information.get("streams", [])
            has_video = any(stream.get("codec_type") == "video" for stream in streams)
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(400, "Could not determine video duration") from None
        if not has_video or not (0.5 <= duration <= 5.0):
            raise HTTPException(400, "Driving video must contain video and be 0.5–5 seconds")
        return {
            "ok": True,
            "stage": "input-validated",
            "image_dimensions": [width, height],
            "driving_video_seconds": round(duration, 2),
            "gpu_generation_enabled": False,
            "note": "No model was loaded and no GPU job was started.",
        }

    @api.post("/v1/motion/jobs")
    def submit_job(authorization: str | None = Header(default=None)):
        authorize(authorization)
        raise HTTPException(
            status_code=503,
            detail="GPU execution is intentionally disabled until official checkpoints, preprocessing and cost limits are verified",
        )

    return api
