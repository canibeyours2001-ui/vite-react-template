/** Private Kaggle-local Kokoro TTS service. */
export const kokoroServerPython = String.raw`"""Local Kokoro TTS OpenAI-compatible endpoint for pyVideoTrans.
Runs only inside the private Kaggle notebook. Never exposes a public port.
"""
import io, json, subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer
import numpy as np
import soundfile as sf
from kokoro import KPipeline
VOICES={'af_heart','af_bella','af_nicole','af_sarah','am_michael','am_adam',
        'bf_emma','bf_isabella','bm_george','bm_lewis'}
PIPELINES={}
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print('KOKORO_API',fmt%args,flush=True)
    def do_GET(self):
        if self.path!='/health':return self.reply(404,b'Not found')
        return self.reply(200,b'OK')
    def reply(self,status,data,content='text/plain'):
        self.send_response(status)
        self.send_header('Content-Type',content)
        self.send_header('Content-Length',str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_POST(self):
        if self.path!='/v1/audio/speech':return self.reply(404,b'Not found')
        try:
            n=int(self.headers.get('Content-Length','0'))
            if n<=0 or n>20000:raise ValueError('Request too long')
            data=json.loads(self.rfile.read(n))
            voice=str(data.get('voice','af_heart'))
            text=str(data.get('input',''))
            speed=float(data.get('speed',1))
            if voice not in VOICES or not (0.5<=speed<=1.5) or not (1<=len(text)<=1800):
                raise ValueError('Invalid Kokoro voice, speed or text')
            lang=voice[0]
            if lang not in PIPELINES:
                PIPELINES[lang]=KPipeline(lang_code=lang)
            audio=[]
            for _,__,chunk in PIPELINES[lang](text,voice=voice,speed=speed):
                if chunk is not None:
                    audio.append(chunk.detach().cpu().numpy() if hasattr(chunk,'detach') else np.asarray(chunk))
            if not audio:raise ValueError('No speech generated')
            wav=io.BytesIO()
            sf.write(wav,np.concatenate(audio).astype('float32'),24000,format='WAV',subtype='PCM_16')
            ff=subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-i','pipe:0','-f','mp3','pipe:1'],
                              input=wav.getvalue(),capture_output=True,timeout=120,check=True)
            if len(ff.stdout)<1000:raise ValueError('Empty audio')
            self.reply(200,ff.stdout,'audio/mpeg')
        except Exception as e:
            print('KOKORO_ERROR',type(e).__name__,str(e)[:170],flush=True)
            self.reply(422,b'Kokoro synthesis failed')
HTTPServer(('127.0.0.1',8765),Handler).serve_forever()
`;
