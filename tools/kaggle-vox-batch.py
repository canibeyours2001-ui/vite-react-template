"""A separate PRIVATE Kaggle batch kernel for VoxCPM2. Does not edit the working UI notebook.
This is a minimal job adapter using official VoxCPM2 inference options.
"""
import json
import subprocess
subprocess.run(['python','-m','pip','install','-q','voxcpm>=2.0.3','soundfile'],check=True)
from pathlib import Path
import soundfile as sf
from huggingface_hub import snapshot_download
from voxcpm import VoxCPM

TASK=json.loads(__VOX_TASK_JSON__)
text=TASK.get("text","").strip()
if not text or len(text)>800:
    raise ValueError("Invalid queued text")
# Match the original 'voxcpm2-full-working' model initialization and WAV format.
MODEL_DIR="/kaggle/working/VoxCPM2"
if not Path(MODEL_DIR,"model.safetensors").exists():
    snapshot_download(repo_id="openbmb/VoxCPM2",local_dir=MODEL_DIR)
model=VoxCPM.from_pretrained(MODEL_DIR,load_denoiser=False,optimize=False,device="cuda")
kwargs={"text":text,"cfg_value":2.0,"inference_timesteps":10}
wav=model.generate(**kwargs)
dest=Path("/kaggle/working/vox_generated.wav")
sf.write(str(dest),wav,model.tts_model.sample_rate,subtype="PCM_16")
print("VOXCPM2_OUTPUT_OK",dest.stat().st_size)
