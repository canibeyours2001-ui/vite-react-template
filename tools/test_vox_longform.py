#!/usr/bin/env python3
"""Offline check of the exact Python kernel embedded in the Cloudflare Worker.
No GPU, dependencies, Kaggle quota, or network calls.
"""
import ast
import json
import re
from pathlib import Path

ts = Path("src/worker/vox-kaggle-direct.ts").read_text(encoding="utf-8")
match = re.search(r"^const VOX_KERNEL_PYTHON=(.+);$", ts, flags=re.MULTILINE)
assert match, "Embedded Kaggle Python source not found"
script = json.loads(match.group(1))
assert script.count("__VOX_TASK_LITERAL__") == 1
payload = json.dumps(json.dumps({"text": "မင်္ဂလာပါ။"}, ensure_ascii=False), ensure_ascii=False)
parsed = ast.parse(script.replace("__VOX_TASK_LITERAL__", payload))
function = next(node for node in parsed.body if isinstance(node, ast.FunctionDef) and node.name == "split_script")
ns = {"re": re}
exec(compile(ast.Module(body=[function], type_ignores=[]), "<split_script>", "exec"), ns)
split = ns["split_script"]

cases = [
    "မင်္ဂလာပါ။ " * 600,
    ("This is a test sentence with a long story to be spoken naturally. " * 110),
    "မြန်မာစာ" * 1000,
    "Hello world. " * 580,
]
for sample in cases:
    chunks = split(sample)
    assert chunks and len(chunks) <= 64, (len(sample), len(chunks))
    assert all(0 < len(part) <= 240 for part in chunks), (len(sample), max(map(len, chunks)))
    assert sum(len(part) for part in chunks) > 0
assert "/kaggle/temp/VoxCPM2" in script
assert "/kaggle/working/vox_generated.mp3" in script
assert "ffmpeg" in script
print("PASS: embedded Kaggle Python syntax, long-form chunking, 240-char chunks, MP3 output")
