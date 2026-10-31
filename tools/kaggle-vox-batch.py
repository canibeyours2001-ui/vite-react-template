"""A separate PRIVATE Kaggle batch kernel for VoxCPM2. Does not edit the working UI notebook.
This is a minimal job adapter using official VoxCPM2 inference options.
"""
import json
import subprocess
subprocess.run(['python','-m','pip','install','-q','voxcpm>=2.0.3','soundfile'],check=True)
from pathlib import Path
import soundfile as sf
from voxcpm import VoxCPM

TASK=json.loads(__VOX_TASK_JSON__)
text=TASK.get("text","").strip()
if not text or len(text)>800:
    raise ValueError("Invalid queued text")
from os import environ
model_dir=environ.get("VOX_MODEL_PATH","openbmb/VoxCPM2")
model=VoxCPM.from_pretrained(model_dir,load_denoiser=False,optimize=True,device="cuda")
wav=model.generate(text=text,cfg_value=2.0,inference_timesteps=10)
dest=Path("/kaggle/working/vox_generated.wav")
sf.write(str(dest),wav,model.tts_model.sample_rate)
print("VOXCPM2_OUTPUT_OK",dest.stat().st_size)
