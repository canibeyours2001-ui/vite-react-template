/** Aspect-safe karaoke captions; prefer pyVideoTrans's aligned target SRT to a second ASR pass. */
export const karaokePython = String.raw`
try:
    import re, pathlib, subprocess, sys, json, shutil, unicodedata
    result=pathlib.Path('/kaggle/working/pyvideotrans_result.mp4')
    if not result.exists() or result.stat().st_size<4096:
        raise RuntimeError('Missing dubbed MP4')
    meta=json.loads(subprocess.run(['ffprobe','-v','error','-select_streams','v:0',
        '-show_entries','stream=width,height','-of','json',str(result)],
        stdout=subprocess.PIPE,text=True,check=True,timeout=40).stdout)['streams'][0]
    width,height=int(meta['width']),int(meta['height'])
    if not(64<=width<=7680 and 64<=height<=7680):
        raise ValueError('Invalid output dimensions')
    # ASS coordinates match the ORIGINAL output's aspect ratio, including portrait video.
    fontsize=max(24,min(52,int(width*0.052)))
    margin_x=max(16,int(width*0.075))
    margin_y=max(25,int(height*0.085))
    def at(t):
        cent=int(max(0,t)*100)
        return str(cent//360000)+':'+str(cent//6000%60).zfill(2)+':'+str(cent//100%60).zfill(2)+'.'+str(cent%100).zfill(2)
    def clean(t):
        return re.sub(r'[{}\\]','',str(t)).replace('\n',' ').replace('\r',' ').strip()
    def units(t):
        return sum(0 if unicodedata.category(c).startswith('M') else (0.5 if c.isascii() else 1.0)
                   for c in t)
    max_units=max(12,(width-2*margin_x)/(fontsize*0.72))
    def parts(token):
        # Split unusually long unspaced Myanmar phrases without cutting combining marks.
        try:
            import regex
            chars=regex.findall(r'\X',token)
        except ImportError:
            chars=list(token)
        out=[];buf=''
        for ch in chars:
            if buf and units(buf+ch)>max_units*0.65:
                out.append(buf);buf=''
            buf+=ch
        if buf:out.append(buf)
        return out
    def srt_time(t):
        try:
            h,m,s=t.replace(',','.').split(':')
            return float(h)*3600+float(m)*60+float(s)
        except ValueError:
            return 0.0
    words=[]
    root=pathlib.Path('/kaggle/temp/pyvideotrans-job/results')
    paths=list(root.rglob('*.srt')) if root.exists() else []
    def score(path):
        try:
            content=path.read_text(encoding='utf-8-sig',errors='replace')
            n=(sum('\u1000'<=c<='\u109f' for c in content) if TASK['target']=='my'
               else sum(c.isascii() and c.isalpha() for c in content))
            return n+(100 if 'target' in path.name.lower() else 0)
        except OSError:
            return -1
    # Reuse already-produced translated SRT instead of transcribing the same audio again.
    for path in sorted(paths,key=score,reverse=True):
        maybe=[]
        try:
            srt=path.read_text(encoding='utf-8-sig',errors='replace')
            for block in re.split(r'\n\s*\n',srt.replace('\r\n','\n')):
                match=re.search(r'(\d\d:\d\d:\d\d[,.]\d+)\s*-->\s*(\d\d:\d\d:\d\d[,.]\d+)',block)
                if not match:continue
                a,b=srt_time(match.group(1)),srt_time(match.group(2))
                line=re.sub(r'<[^>]*>|\{\\[^}]*\}',' ',block[match.end():]).strip()
                tokens=[]
                for token in line.split():
                    tokens.extend(parts(clean(token)))
                if b<=a or not tokens:continue
                weights=[max(0.2,units(token)) for token in tokens]
                t=a;total=sum(weights)
                for token,weight in zip(tokens,weights):
                    nxt=min(b,t+(b-a)*weight/total)
                    maybe.append((t,max(t+0.06,nxt),token));t=nxt
            if maybe and (TASK['target']!='my' or score(path)>2):
                words=maybe
                print('PYVT_KARAOKE_REUSED_TARGET_SRT',len(words),flush=True)
                break
        except Exception as exc:
            print('PYVT_KARAOKE_SRT_READ_FAILED',type(exc).__name__,flush=True)
    if not words:
        print('PYVT_KARAOKE_SRT_MISSING_TRANSCRIBE_FALLBACK',flush=True)
        subprocess.run([sys.executable,'-m','pip','install','-q','faster-whisper'],check=True,timeout=360)
        from faster_whisper import WhisperModel
        import numpy as np
        blob=subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-i',str(result),
            '-vn','-ac','1','-ar','16000','-f','f32le','pipe:1'],
            check=True,stdout=subprocess.PIPE,timeout=180).stdout
        audio=np.frombuffer(blob,dtype=np.float32)
        if audio.size<16000:raise RuntimeError('Dubbed audio too short')
        model=WhisperModel('base',device='cpu',compute_type='int8')
        segments,_=model.transcribe(audio,language=TASK['target'],
            word_timestamps=True,vad_filter=True,beam_size=2)
        for seg in segments:
            for word in seg.words or []:
                if word.word.strip() and word.start is not None and word.end is not None and word.end>word.start:
                    for sub in parts(clean(word.word)):
                        words.append((float(word.start),float(word.end),sub))
        print('PYVT_KARAOKE_TRANSCRIBED_WORDS',len(words),flush=True)
    if not words:
        print('PYVT_KARAOKE_SKIPPED_NO_WORDS; DUBBED_MP4_KEPT',flush=True)
    else:
        # Pre-group captions by actual rendered width: never one unbounded 5-word line.
        groups=[];group=[];weight=0.0;start=0.0
        for item in words:
            w=units(item[2])+(0.5 if group else 0)
            if group and (weight+w>max_units or len(group)>=4 or item[1]-start>3.2):
                groups.append(group);group=[];weight=0.0
            if not group:start=item[0]
            group.append(item);weight+=w
        if group:groups.append(group)
        fontdir=pathlib.Path('/kaggle/temp/pyvt_karaoke_fonts')
        fontdir.mkdir(parents=True,exist_ok=True)
        fontname='Noto Sans'
        fontfile=fontdir/'NotoSansMyanmar.ttf'
        if TASK['target']=='my':
            if not fontfile.exists():
                try:
                    import urllib.request
                    url='https://raw.githubusercontent.com/google/fonts/main/ofl/notosansmyanmar/NotoSansMyanmar%5Bwdth%2Cwght%5D.ttf'
                    with urllib.request.urlopen(url,timeout=12) as resp:
                        blob=resp.read(1200000)
                    if len(blob)<100000 or blob[:4] not in (b'\x00\x01\x00\x00',b'OTTO'):
                        raise ValueError('Invalid font')
                    fontfile.write_bytes(blob)
                except Exception:
                    print('PYVT_MYANMAR_FONT_FALLBACK',flush=True)
            if fontfile.exists():fontname='Noto Sans Myanmar'
        header=f'''[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Karaoke,{fontname},{fontsize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,{margin_x},{margin_x},{margin_y},1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
'''
        lines=[header]
        for group in groups:
            for index,(a,b,_) in enumerate(group):
                fragments=[]
                for j,(_,__,token) in enumerate(group):
                    token=clean(token)
                    if j==index:
                        fragments.append(r'{\c&H0000D7FF&}'+token+r'{\c&H00FFFFFF&}')
                    else:fragments.append(token)
                caption=' '.join(fragments)
                lines.append('Dialogue: 0,'+at(a)+','+at(max(b,a+0.12))+',Karaoke,,0,0,0,,'+caption+'\n')
        ass=pathlib.Path('/kaggle/working/pyvt_karaoke.ass')
        ass.write_text(''.join(lines),encoding='utf-8')
        # Keep an output checkpoint before final re-encode when disk space allows.
        try:
            if result.stat().st_size<=350*1024*1024 and shutil.disk_usage(result.parent).free>result.stat().st_size*2+100*1024*1024:
                shutil.copy2(result,'/kaggle/working/pyvt_dubbed_before_captions.mp4')
        except OSError:
            pass
        rendered=pathlib.Path('/kaggle/working/pyvt_karaoke_render.mp4')
        vf='ass='+str(ass)+(':fontsdir='+str(fontdir) if fontfile.exists() else '')
        subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(result),
            '-vf',vf,'-map','0:v:0','-map','0:a?','-sn','-dn','-c:v','libx264',
            '-preset','veryfast','-crf','21','-pix_fmt','yuv420p',
            '-c:a','copy','-movflags','+faststart',str(rendered)],
            check=True,timeout=1800)
        if rendered.stat().st_size<4096:raise RuntimeError('Karaoke video render empty')
        rendered.replace(result)
        print('PYVT_KARAOKE_SAFEFRAME_WORDS',len(words),'GROUPS',len(groups),'SIZE',width,height,flush=True)
    pathlib.Path('/kaggle/working/pyvt_stage.json').write_text(json.dumps({
        'dubbed':True,'captions_burned':bool(words),'original_subtitles_removed':bool(TASK.get('remove_subtitles',True)),
        'output':'pyvideotrans_result.mp4'},indent=2))
    print('PYVIDEOTRANS_VIDEO_READY',flush=True)
except Exception as exc:
    print('PYVT_KARAOKE_SKIPPED_KEEPING_DUB',type(exc).__name__,str(exc)[:180],flush=True)
    assert pathlib.Path('/kaggle/working/pyvideotrans_result.mp4').stat().st_size>4096
    print('PYVIDEOTRANS_VIDEO_READY',flush=True)

`;
