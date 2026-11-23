"""Kaggle T4 batch inference for Qwen-Image-2.1 Uncensored Q4_K_M + Viggle v0.3 6-step LoRA.

Research/evaluation only: Qwen Research License is non-commercial.
Never opens a public inference endpoint, stores credentials, or accepts arbitrary shell commands.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import random
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

OUT = Path("/kaggle/working" if Path("/kaggle/working").exists() else "/tmp/qwen-kaggle")
OUT.mkdir(parents=True, exist_ok=True)
COMFY = Path("/tmp/qwen-comfy")
RESULT = OUT / "qwen_image21_result.png"
REPORT = OUT / "qwen_image21_result.json"
GGUF = "qwen-image-2.1-UC-Q4_K_M.gguf"
LORA = "Qwen-Image-2.1-viggle-turbo-v0.3-6step-lora-r256.safetensors"
CHECKSUM = "e79c8a009f2ecbdb6c70fd663d9aea9ee304a0d91f347e4169a756b8ad141b41"
SIGMAS = "1.0, 0.9375, 0.875, 0.75, 0.5, 0.25"


def sh(*args, timeout=900, cwd=None):
    print("EXEC", " ".join(str(a) for a in args[:3]), flush=True)
    subprocess.run(list(map(str, args)), check=True, cwd=cwd, timeout=timeout)


def get_task():
    raw = os.environ.get("QWEN_TASK_JSON", "")
    if not raw:
        return {"prompt": "A detailed photograph of a red ceramic teacup beside a rainy window, soft studio lighting",
                "width": 1024, "height": 1024, "seed": 42}
    task = json.loads(raw)
    if not isinstance(task, dict):
        raise ValueError("Task must be JSON object")
    prompt = task.get("prompt")
    if not isinstance(prompt, str) or not 3 <= len(prompt) <= 1400:
        raise ValueError("Prompt must contain 3 to 1400 characters")
    width, height = int(task.get("width", 1024)), int(task.get("height", 1024))
    if width not in (512, 768, 1024) or height not in (512, 768, 1024):
        raise ValueError("Allowed dimensions: 512/768/1024")
    if width * height > 1024 * 1024:
        raise ValueError("Maximum 1 megapixel on Kaggle T4")
    seed = int(task.get("seed", 42))
    if seed < 0 or seed >= 2**32:
        raise ValueError("Invalid random seed")
    return {"prompt": prompt, "width": width, "height": height, "seed": seed}


def setup():
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError("Kaggle GPU not enabled")
    print("CUDA", torch.cuda.get_device_name(0), "VRAM", torch.cuda.get_device_properties(0).total_memory, flush=True)
    if not COMFY.is_dir():
        sh("git", "clone", "--quiet", "--depth", "1", "https://github.com/Comfy-Org/ComfyUI.git", COMFY, timeout=240)
    sh(sys.executable, "-m", "pip", "install", "-q", "-r", COMFY / "requirements.txt", timeout=1200)
    sh(sys.executable, "-m", "pip", "install", "-q", "huggingface_hub>=0.34,<2", "gguf==0.19.0", "requests", timeout=600)
    node = COMFY / "custom_nodes" / "ComfyUI-GGUF"
    if not node.exists():
        sh("git", "clone", "--quiet", "--depth", "1", "https://github.com/city96/ComfyUI-GGUF.git", node, timeout=180)
    sh(sys.executable, "-m", "pip", "install", "-q", "-r", node / "requirements.txt", timeout=600)
    # Upstream ComfyUI already implements QwenImage21; ComfyUI-GGUF's
    # whitelist currently omits its GGUF architecture identifier. Permit it
    # without renaming metadata so ComfyUI detects the native QwenImage21 model.
    loader = node / "loader.py"
    source = loader.read_text()
    old = '"qwen_image"}'
    new = '"qwen_image", "qwen_image21"}'
    if "qwen_image21" not in source:
        if old not in source:
            raise RuntimeError("ComfyUI-GGUF architecture whitelist changed; refusing unsafe patch")
        loader.write_text(source.replace(old, new, 1))
        print("GGUF_ARCH_QWEN_IMAGE21_ENABLED", flush=True)
    else:
        print("GGUF_ARCH_QWEN_IMAGE21_ALREADY_ENABLED", flush=True)
    urllib.request.urlretrieve(
        "https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo/resolve/main/comfyui/viggle_turbo.py",
        COMFY / "custom_nodes" / "viggle_turbo.py")
    from huggingface_hub import hf_hub_download
    dl = [
      ("KasugaiSakura/Qwen-Image-2.1-Uncensored-Abenzerps-GGUF", GGUF, "diffusion_models"),
      ("Comfy-Org/Qwen-Image-2.1", "text_encoders/qwen3vl_8b_int8_convrot.safetensors", ""),
      ("Comfy-Org/Qwen-Image-2.1", "vae/qwen_image_2.1_vae_bf16.safetensors", ""),
      ("Viggle/Qwen-Image-2.1-viggle-turbo", LORA, "loras"),
    ]
    for repo, name, sub in dl:
        local = COMFY / "models" / sub
        expected = local / name
        if expected.is_file() and expected.stat().st_size > 10_000_000:
            print("MODEL_CACHED", name, expected.stat().st_size, flush=True)
            continue
        print("MODEL_DOWNLOAD", repo, name, flush=True)
        hf_hub_download(repo_id=repo, filename=name, local_dir=str(local))
        if not expected.is_file():
            raise RuntimeError("Model download missing: " + name)
    fp = COMFY / "models" / "diffusion_models" / GGUF
    digest = hashlib.sha256()
    with fp.open("rb") as f:
        for part in iter(lambda: f.read(8 * 1024 * 1024), b""):
            digest.update(part)
    if digest.hexdigest() != CHECKSUM:
        raise RuntimeError("Q4_K_M checksum mismatch")
    print("GGUF_SHA256_VERIFIED", flush=True)


def graph(task):
    # Matches Viggle v0.3 ComfyUI T2I's native unmerged LoRA path.
    return {
      "1": {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": GGUF}},
      "2": {"class_type": "ViggleTurboLora", "inputs": {"model": ["1",0], "lora_name": LORA, "strength": 1.0}},
      "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_8b_int8_convrot.safetensors", "type": "qwen_image", "device": "default"}},
      "4": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_2.1_vae_bf16.safetensors"}},
      "5": {"class_type": "TextEncodeQwenImage21", "inputs": {"clip": ["3",0], "vae": ["4",0], "prompt": task["prompt"], "negative_prompt": "", "resolution": 1024}},
      "6": {"class_type": "EmptyLatentImage", "inputs": {"width": task["width"], "height": task["height"], "batch_size": 1}},
      "7": {"class_type": "BasicGuider", "inputs": {"model": ["2",0], "conditioning": ["5",0]}},
      "8": {"class_type": "RandomNoise", "inputs": {"noise_seed": task["seed"]}},
      "9": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
      "10": {"class_type": "ViggleTurboSigmas", "inputs": {"latent": ["6",0], "nodes": SIGMAS}},
      "11": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["8",0], "guider": ["7",0], "sampler": ["9",0], "sigmas": ["10",0], "latent_image": ["6",0]}},
      "12": {"class_type": "VAEDecode", "inputs": {"samples": ["11",0], "vae": ["4",0]}},
      "13": {"class_type": "SaveImage", "inputs": {"images": ["12",0], "filename_prefix": "qwen_image21/result"}},
    }


def api_request(method, path, payload=None, timeout=30):
    url = "http://127.0.0.1:8188" + path
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=body, method=method,
                                 headers={"Content-Type": "application/json"} if body else {})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read())


def main():
    task = get_task()
    print("CONFIG", {k: v for k,v in task.items() if k != "prompt"}, "steps=6",
          "model=uncensored-Q4_K_M", "lora=viggle-v0.3", flush=True)
    setup()
    server_log = (OUT / "qwen_comfy.log").open("w")
    cmd = [sys.executable, str(COMFY / "main.py"), "--listen", "127.0.0.1", "--port", "8188",
           "--lowvram", "--cpu-vae"]
    proc = subprocess.Popen(cmd, cwd=str(COMFY), stdout=server_log, stderr=subprocess.STDOUT)
    try:
        started = time.monotonic()
        while time.monotonic() - started < 180:
            if proc.poll() is not None:
                raise RuntimeError("ComfyUI exited; see qwen_comfy.log")
            try:
                info = api_request("GET", "/object_info", timeout=5)
                for name in ["UnetLoaderGGUF", "ViggleTurboLora", "ViggleTurboSigmas", "TextEncodeQwenImage21"]:
                    if name not in info:
                        raise RuntimeError("Required ComfyUI node unavailable: " + name)
                break
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                time.sleep(2)
        else:
            raise TimeoutError("ComfyUI start timeout")
        response = api_request("POST", "/prompt", {"prompt": graph(task), "client_id": "kaggle-qwen21"})
        if response.get("node_errors"):
            raise RuntimeError("Invalid ComfyUI graph: " + str(response["node_errors"])[:1000])
        pid = response.get("prompt_id")
        if not pid:
            raise RuntimeError("ComfyUI did not accept prompt: " + str(response)[:1000])
        deadline = time.monotonic() + 4800
        while time.monotonic() < deadline:
            history = api_request("GET", "/history/" + pid, timeout=20).get(pid)
            if history:
                status = history.get("status", {})
                if status.get("status_str") == "error" or not status.get("completed"):
                    raise RuntimeError("ComfyUI inference failed: " + str(status.get("messages",[]))[-1200:])
                images = history.get("outputs",{}).get("13",{}).get("images",[])
                if not images:
                    raise RuntimeError("No image produced")
                image = images[0]
                from urllib.parse import urlencode
                url = "http://127.0.0.1:8188/view?" + urlencode({
                    "filename": image["filename"],
                    "subfolder": image.get("subfolder",""),
                    "type": image.get("type","output")})
                urllib.request.urlretrieve(url, RESULT)
                from PIL import Image
                with Image.open(RESULT) as im:
                    im.verify()
                with Image.open(RESULT) as im:
                    size = im.size
                REPORT.write_text(json.dumps({"status":"ok","width":size[0],"height":size[1],
                                              "bytes":RESULT.stat().st_size,"seed":task["seed"],
                                              "steps":6,"format":"PNG","model":"Uncensored Q4_K_M",
                                              "lora":"Viggle Turbo v0.3 r128"}, indent=2))
                print("QWEN_COMPLETE", RESULT, size, RESULT.stat().st_size, flush=True)
                return
            time.sleep(8)
        raise TimeoutError("Image generation timed out")
    finally:
        proc.terminate()
        try: proc.wait(timeout=10)
        except subprocess.TimeoutExpired: proc.kill()
        server_log.close()
        log = OUT / "qwen_comfy.log"
        if log.exists():
            print("COMFY_LAST_LOG_LINES", "\n".join(log.read_text(errors="replace").splitlines()[-35:]), flush=True)


if __name__ == "__main__":
    main()
