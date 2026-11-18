"""Regression test for MP4 audio-padding duration handling."""
import ast, json, pathlib, subprocess
from unittest.mock import patch
ts = pathlib.Path(__file__).resolve().parents[1] / 'src/worker/seedvr2-kaggle.ts'
raw = ts.read_text()
assert "const KERNEL_SCRIPT = " in raw
py, _ = json.JSONDecoder().raw_decode(raw.split("const KERNEL_SCRIPT = ", 1)[1])
module = ast.parse(py)
probe = next(x for x in module.body if isinstance(x, ast.FunctionDef) and x.name == "probe")
ns = {"json":json, "subprocess":subprocess}
exec(compile(ast.Module(body=[probe],type_ignores=[]),'<seedvr2-probe>', 'exec'),ns)
def simulated_probe(video_sec,fmt_sec,frames='240'):
    metadata={"streams":[{"codec_type":"video","width":360,"height":640,"avg_frame_rate":"24/1",
                          "duration":video_sec,"nb_frames":frames},
                         {"codec_type":"audio","duration":fmt_sec}],
              "format":{"duration":fmt_sec}}
    with patch.object(subprocess,'check_output',return_value=json.dumps(metadata).encode()):
        return ns["probe"]('/dev/null')
assert abs(simulated_probe('10.000000','10.026667')[3]-10.0)<1e-5
assert abs(simulated_probe(None,'10.026667')[3]-10.0)<1e-5
assert abs(simulated_probe(None,'10.026667',frames='N/A')[3]-10.026667)<1e-5
assert simulated_probe('11.000000','11.026667')[3] > 10.25
assert abs(simulated_probe('N/A','10.026667')[3]-10.0)<1e-5
print('PASS: stream duration, frame-count fallback, format-duration tolerance and 11s rejection')

assert 0.2 < simulated_probe(None,'10.026667',frames='N/A')[3] <= 10.25
assert 'run(command, timeout=39600, cwd=str(repo))' in py
assert 'sessionTimeoutSeconds:43200' in raw
print('PASS: extended T4 processing and Kaggle session timeout validated')
assert 43200 == 12*60*60
assert 39600 == 11*60*60
print("PASS: Kaggle session capped at 12h with 1h setup/finishing headroom")
