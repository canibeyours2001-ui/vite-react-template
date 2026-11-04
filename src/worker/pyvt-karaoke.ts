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
if not words:
    print('PYVT_KARAOKE_RETRY_NO_VAD',flush=True)
    try:
        segments,_=model.transcribe(audio,language=TASK['target'],
             word_timestamps=True,vad_filter=False,beam_size=2,
             condition_on_previous_text=False)
        for seg in segments:
            for w in (seg.words or []):
                token=w.word.strip()
                if token and w.start is not None and w.end is not None and w.end>w.start:
                    words.append((float(w.start),float(w.end),token))
    except Exception as exc:
        print('PYVT_KARAOKE_RETRY_ERROR',type(exc).__name__,flush=True)
if not words:
    # Fall back to the translated subtitles produced by pyVideoTrans,
    # approximating individual word timings within each SRT caption.
    srt_files=list((pathlib.Path('/kaggle/temp/pyvideotrans-job/results')).rglob('*.srt'))
    def srt_score(path):
        try:
            body=path.read_text(encoding='utf-8-sig',errors='replace')
        except Exception:
            return -1
        letters=(sum('\u1000'<=ch<='\u109f' for ch in body) if TASK['target']=='my'
                 else sum(ch.isascii() and ch.isalpha() for ch in body))
        return letters + (len(body)//500 if 'target' in path.name.lower() else 0)
    def srt_time(s):
        pieces=s.strip().replace(',', '.').split(':')
        try:
            return float(pieces[-1])+60*int(pieces[-2])+3600*int(pieces[-3])
        except (IndexError,ValueError):
            return 0.0
    for path in sorted(srt_files,key=srt_score,reverse=True):
        try:
            text=path.read_text(encoding='utf-8-sig',errors='replace')
            for block in re.split(r'\n\s*\n',text.replace('\r\n','\n')):
                match=re.search(r'(\d\d:\d\d:\d\d[,.]\d+)\s*-->\s*(\d\d:\d\d:\d\d[,.]\d+)',block)
                if not match:continue
                start,end=srt_time(match.group(1)),srt_time(match.group(2))
                caption=block[match.end():]
                caption=re.sub(r'<[^>]*>|\{\\[^}]*\}',' ',caption)
                tokens=[w for w in re.split(r'\s+',caption.strip()) if w and w!='-']
                if end<=start or not tokens:continue
                weights=[max(1,len(w)) for w in tokens];total=sum(weights)
                t=start
                for token,weight in zip(tokens,weights):
                    next_t=min(end,t+(end-start)*weight/total)
                    words.append((t,max(t+0.09,next_t),token));t=next_t
            if words:
                print('PYVT_KARAOKE_APPROX_WORDS_FROM_SRT',len(words),flush=True)
                break
        except Exception as exc:
            print('PYVT_KARAOKE_SRT_ERROR',type(exc).__name__,flush=True)
if not words:
    print('PYVT_KARAOKE_SKIPPED_NO_WORDS_OR_SUBTITLES; DUBBED_MP4_KEPT',flush=True)
if words:
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
    # Use an OFL-licensed Myanmar font for correct script shaping.
    # A download problem is non-fatal; FFmpeg can fall back to installed fonts.
    fontdir=pathlib.Path('/kaggle/temp/pyvt_karaoke_fonts')
    fontdir.mkdir(parents=True,exist_ok=True)
    fontfile=fontdir/'NotoSansMyanmar.ttf'
    if TASK['target']=='my':
        try:
            import urllib.request
            fonturl='https://raw.githubusercontent.com/google/fonts/main/ofl/notosansmyanmar/NotoSansMyanmar%5Bwdth%2Cwght%5D.ttf'
            with urllib.request.urlopen(fonturl,timeout=20) as src:
                blob=src.read(1200000)
            if len(blob)<100000 or blob[:4] not in (b'\x00\x01\x00\x00',b'OTTO'):
                raise ValueError('Font download invalid')
            fontfile.write_bytes(blob)
        except Exception:
            print('PYVT_MYANMAR_FONT_FALLBACK',flush=True)
    if TASK['target']=='my' and fontfile.exists():
        lines[0]=header.replace('Style: Karaoke,Noto Sans,','Style: Karaoke,Noto Sans Myanmar,')
    ass=pathlib.Path('/kaggle/working/pyvt_karaoke.ass')
    ass.write_text(''.join(lines),encoding='utf-8')
    rendered=pathlib.Path('/kaggle/working/pyvt_karaoke_render.mp4')
    try:
        subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(result),
                    '-vf','ass='+str(ass)+(':fontsdir='+str(fontdir) if fontfile.exists() else ''),'-map','0:v:0','-map','0:a?','-c:v','libx264',
                    '-preset','veryfast','-crf','21','-c:a','copy','-movflags','+faststart',str(rendered)],
                       check=True,timeout=1800)
        if rendered.stat().st_size<4096:raise RuntimeError('Karaoke video render empty')
        rendered.replace(result)
        print('PYVT_KARAOKE_WORDS',len(words),flush=True)
    except Exception as exc:
        print('PYVT_KARAOKE_RENDER_FAILED_KEEPING_DUB',type(exc).__name__,flush=True)
print('PYVIDEOTRANS_VIDEO_READY',flush=True)
`;
