#!/usr/bin/env python3
"""Single-job Kaggle GPU dispatcher for the Hono Telegram VoxCPM2 queue.
Requires kaggle CLI credentials on THIS host (OCI); never puts credentials in Kaggle code.
Run via flock or an equivalent single-instance supervisor. No GPU required on OCI.
"""
import argparse
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import requests

API=os.environ.get("VOX_API_BASE","").rstrip("/")
AUTH=os.environ.get("VOX_WORKER_KEY","")
KERNEL=os.environ.get("VOX_KAGGLE_KERNEL","cyawzin/voxcpm2-telegram-worker")
CACHE_DATASET=os.environ.get("VOX_KAGGLE_CACHE_DATASET","cyawzin/voxcpm2-cache")
ROOT=pathlib.Path(__file__).resolve().parent
HEADERS={"X-Vox-Worker-Key":AUTH}
if os.environ.get("CF_ACCESS_CLIENT_ID"):
    HEADERS["CF-Access-Client-Id"]=os.environ["CF_ACCESS_CLIENT_ID"]
if os.environ.get("CF_ACCESS_CLIENT_SECRET"):
    HEADERS["CF-Access-Client-Secret"]=os.environ["CF_ACCESS_CLIENT_SECRET"]

def run_command(args,timeout=180):
    p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,
                     text=True,timeout=timeout,check=False)
    if p.returncode:
        raise RuntimeError(args[0]+" failed (exit "+str(p.returncode)+"): "+p.stdout[-400:])
    return p.stdout

def post(path,**kwargs):
    resp=requests.post(API+path,headers=HEADERS,timeout=110,**kwargs)
    resp.raise_for_status()
    return resp.json()

def update(job,status,error=""):
    try:post("/api/vox/update",json={"job_id":job,"status":status,"error":error[:190]})
    except Exception as exc:print("Status reporting failed:",type(exc).__name__,file=sys.stderr)

def render(job,folder):
    source=(ROOT/"kaggle-vox-batch.py").read_text(encoding="utf-8")
    marker="__VOX_TASK_JSON__"
    if source.count(marker)!=1:raise RuntimeError("Invalid Kaggle worker template")
    task=json.dumps({"text":job["text"]},ensure_ascii=False)
    code=source.replace(marker,repr(task))
    # The Kaggle kernel MUST remain private; keep personally authored text out of public code.
    (folder/"worker.py").write_text(code,encoding="utf-8")
    meta={"id":KERNEL,"title":"VoxCPM2 Telegram Private Batch Worker",
          "code_file":"worker.py","language":"python","kernel_type":"script",
          "is_private":True,"enable_gpu":True,"enable_internet":True,
          "machine_shape":"NvidiaTeslaT4","dataset_sources":[CACHE_DATASET] if CACHE_DATASET else [],
          "competition_sources":[],"kernel_sources":[],"model_sources":[]}
    (folder/"kernel-metadata.json").write_text(json.dumps(meta,ensure_ascii=False,indent=2),encoding="utf-8")

def run_once():
    if not API.startswith("https://") or len(AUTH)<32:
        raise SystemExit("Set VOX_API_BASE (https) and VOX_WORKER_KEY (32+ chars) before running")
    if "/" not in KERNEL:raise SystemExit("Invalid VOX_KAGGLE_KERNEL")
    # Verify local Kaggle login BEFORE claiming a real user job.
    run_command(["kaggle","kernels","list","-m"],timeout=50)
    result=post("/api/vox/claim")
    job=result.get("job")
    if not job:
        print("No queued VoxCPM2 task")
        return
    job_id=int(job["id"])
    print("Claimed VoxCPM2 job",job_id)
    with tempfile.TemporaryDirectory(prefix="vox_kaggle_") as tmp:
        folder=pathlib.Path(tmp)
        render(job,folder)
        try:
            # This creates a NEW VERSION of our private worker, not the existing studio.
            run_command(["kaggle","kernels","push","-p",str(folder),
                         "--accelerator","NvidiaTeslaT4"],timeout=280)
        except Exception as exc:
            update(job_id,"submit-uncertain","Kaggle submission uncertain; inspect job before resubmitting")
            raise RuntimeError("Kaggle submit uncertain; no automatic retry") from exc
        update(job_id,"submitted")
        started=time.monotonic()
        while time.monotonic()-started<5400:
            try:status=run_command(["kaggle","kernels","status",KERNEL],timeout=50).lower()
            except Exception as exc:
                print("Kaggle status temporarily unavailable:",type(exc).__name__)
                time.sleep(30)
                continue
            print("Kaggle:",status.strip()[:180])
            if "error" in status or "failed" in status:
                update(job_id,"failed","Kaggle execution failed; review Kaggle notebook logs")
                return
            if "complete" in status or "success" in status:
                update(job_id,"downloading")
                output=folder/"result"
                output.mkdir()
                run_command(["kaggle","kernels","output",KERNEL,"-p",str(output),
                             "--file-pattern",".*vox_generated\\.wav$"],timeout=180)
                wavs=list(output.rglob("vox_generated.wav"))
                if len(wavs)!=1:raise RuntimeError("No unique VoxCPM2 WAV in Kaggle output")
                path=wavs[0]
                if path.stat().st_size>20*1024*1024:raise RuntimeError("WAV exceeds Telegram delivery size limit")
                with path.open("rb") as fh:
                    delivered=requests.post(API+"/api/vox/complete",headers=HEADERS,
                         data={"job_id":str(job_id)},
                         files={"audio":("vox_generated.wav",fh,"audio/wav")},timeout=120)
                delivered.raise_for_status()
                if not delivered.json().get("delivered"):raise RuntimeError("Telegram delivery not confirmed")
                print("Delivered VoxCPM2 job",job_id)
                return
            update(job_id,"running")
            time.sleep(30)
        update(job_id,"failed","Kaggle job exceeded runner monitoring limit")
        raise RuntimeError("Kaggle job timed out")

if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--check",action="store_true",help="Validate Kaggle and runner configuration without claiming a job")
    args=parser.parse_args()
    if args.check:
        print("Runner API configured:",API.startswith("https://"))
        print("Worker auth configured:",len(AUTH)>=32)
        print("Kaggle CLI:",run_command(["kaggle","--version"],timeout=20).strip())
        print("Kaggle login:",run_command(["kaggle","kernels","list","-m"],timeout=50)[:250])
    else:run_once()
