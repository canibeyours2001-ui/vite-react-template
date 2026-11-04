/** Python appended to the private Kaggle job to burn timed, word-by-word captions.
 * Transcribes the final DUBBED audio (not the source) so timing matches speech.
 * It uses CPU-based faster-whisper and FFmpeg; API keys never appear here. */
export const karaokePython = String.raw`
import re, subprocess, pathlib, sys
# Strictly run on the output audio so words match the actual generated dubbing.
subprocess.run([sys.executable,'-m','pip','install','-q','faster-whisper'],check=True,timeout=360)
from faster_whisper import WhisperModel
result=pathlib.Path('/kaggle/working/pyvideotrans_result.mp4')
model=WhisperModel('small',device='cpu',compute_type='int8')
# Feed an ndarray, not an MP4 path. Kaggle's PyAV build lacks the
# metadata_errors argument used by faster-whisper's path decoder.
import numpy as np
wav_bytes=subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-i',str(result),
    '-vn','-ac','1','-ar','16000','-f','f32le','pipe:1'],check=True,
    stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=180).stdout
audio=np.frombuffer(wav_bytes,dtype=np.float32)
if audio.size<16000: raise RuntimeError('Dubbed audio could not be decoded for karaoke')
segments,_=model.transcribe(audio,language=TASK['target'],word_timestamps=True,vad_filter=True,beam_size=2)
words=[]
for seg in segments:
    for w in (seg.words or []):
        value=w.word.strip()
        if value and w.start is not None and w.end is not None and w.end>w.start:
            words.append((float(w.start),float(w.end),value))
if not words: raise RuntimeError('No speech words detected in dubbed audio for karaoke subtitles')
def at(t):
    cent=int(max(0,t)*100)
    return str(cent//360000)+':'+str(cent//6000%60).zfill(2)+':'+str(cent//100%60).zfill(2)+'.'+str(cent%100).zfill(2)
def safe(t):
    return re.sub(r'[{}\\\\]','',t).replace('\\\\N',' ').replace('\\n',' ').strip()
header='''[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 2
ScaledBorderAndShadow: yes
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Karaoke,Noto Sans,52,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,28,28,68,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
'''
lines=[header]
for i,(start,end,token) in enumerate(words):
    first=(i//5)*5
    section=words[first:min(first+5,len(words))]
    parts=[]
    for j,(_,__,word) in enumerate(section):
        current=first+j==i
        txt=safe(word)
        if current: parts.append(r'{\c&H0000D7FF&\fscx108\fscy108}'+txt+r'{\c&H00FFFFFF&\fscx100\fscy100}')
        else: parts.append(txt)
    caption=' '.join(parts)
    lines.append('Dialogue: 0,'+at(start)+','+at(max(end,start+0.13))+',Karaoke,,0,0,0,,'+caption+'\n')
ass=pathlib.Path('/kaggle/working/pyvt_karaoke.ass')
ass.write_text(''.join(lines),encoding='utf-8')
rendered=pathlib.Path('/kaggle/working/pyvt_karaoke_render.mp4')
subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(result),
                '-vf','ass='+str(ass),'-map','0:v:0','-map','0:a?','-c:v','libx264',
                '-preset','veryfast','-crf','21','-c:a','copy','-movflags','+faststart',str(rendered)],
               check=True,timeout=1800)
if rendered.stat().st_size<4096:raise RuntimeError('Karaoke video render empty')
rendered.replace(result)
print('PYVT_KARAOKE_WORDS',len(words),flush=True)
print('PYVIDEOTRANS_VIDEO_READY',flush=True)
`;
