/**
 * Cloudflare-only Kaggle VoxCPM2 batch orchestration.
 * Uses the same HTTP RPCs as Kaggle's official Python SDK (no OCI, no shell).
 * Every submitted private Kaggle kernel gets one version, with serialized jobs.
 */
import {setupVoxVoices,storeVoxReference,voiceForJob,voxVoiceMenu} from './vox-voice-profiles'
type D1 = { prepare(query:string):{bind(...v:(string|number)[]):{
 run():Promise<{meta:{changes:number}}>;all<T>():Promise<{results:T[]}>
}}}
export type VoxEnv = {MEMORY_DB:D1;TELEGRAM_BOT_TOKEN:string;KAGGLE_API_TOKEN?:string}
const MAX_VOX_CHARS=8000
type VoxTelegramDocument={file_id:string;file_size?:number;file_name?:string;mime_type?:string}
export type VoxTelegramMessage={document?:VoxTelegramDocument;reply_to_message?:{document?:VoxTelegramDocument}}
type Job = {id:number;chat_id:string;text:string;status:string;version_number:number|null;error_message:string|null}
const OWNER='cyawzin'
const SLUG='voxcpm2-telegram-worker'
const BASE='https://api.kaggle.com/v1/kernels/'
const KERNEL=OWNER+'/'+SLUG
async function init(db:D1){
 await db.prepare(
 "CREATE TABLE IF NOT EXISTS vox_kaggle_jobs ("+
 "id INTEGER PRIMARY KEY AUTOINCREMENT,chat_id TEXT NOT NULL,message_id INTEGER NOT NULL,"+
 "text TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',"+
 "version_number INTEGER,error_message TEXT,created_at INTEGER NOT NULL DEFAULT (unixepoch()),"+
 "updated_at INTEGER NOT NULL DEFAULT (unixepoch()),UNIQUE(chat_id,message_id))"
 ).bind().run()
 await db.prepare(
 "CREATE TABLE IF NOT EXISTS vox_kaggle_health ("+
 "id INTEGER PRIMARY KEY CHECK(id=1),checked_at INTEGER NOT NULL DEFAULT 0,"+
 "ok INTEGER NOT NULL DEFAULT 0,http_status INTEGER NOT NULL DEFAULT 0)"
 ).bind().run()
}
async function tg(env:VoxEnv,method:string,fields:Record<string,unknown>){
 const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/'+method,{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fields),
  signal:AbortSignal.timeout(18000)
 })
 const d=await r.json() as {ok?:boolean;result?:Record<string,unknown>}
 if(!r.ok||!d.ok)throw Error('Telegram '+method+' failed')
 return d.result||{}
}
async function tell(env:VoxEnv,chat:string,message:string){
 return tg(env,'sendMessage',{chat_id:chat,text:message.slice(0,3900)})
}
async function kaggle(env:VoxEnv,action:string,body:Record<string,unknown>,timeoutMs=25000){
 if(!env.KAGGLE_API_TOKEN)throw Error('Kaggle API token is not configured')
 if(!['list','push','status','output'].includes(action))throw Error('Unknown Kaggle action')
 const query=new URLSearchParams()
 for(const key of ['user','pageSize','userName','kernelSlug','versionLabel']){
  const value=body[key]
  if(typeof value==='string'||typeof value==='number')query.set(key,String(value))
 }
 const isPush=action==='push'
 const url=BASE+action+(isPush?'':'?'+query.toString())
 const response=await fetch(url,{
  method:isPush?'POST':'GET',
  headers:{
   Authorization:'Bearer '+env.KAGGLE_API_TOKEN,
   Accept:'application/json',
   ...(isPush?{'Content-Type':'application/json'}:{})
  },
  ...(isPush?{body:JSON.stringify(body)}:{}),
  signal:AbortSignal.timeout(timeoutMs),
 })
 const data=await response.json().catch(()=>({})) as Record<string,unknown>
 if(!response.ok || (typeof data.code==='number'&&data.code>=400) || (isPush&&Boolean(data.error))){
  throw Error('Kaggle '+action+' HTTP '+response.status)
 }
 return data
}
export async function checkKaggleConnection(env:VoxEnv):Promise<void>{
 if(!env.MEMORY_DB)return
 await init(env.MEMORY_DB)
 await env.MEMORY_DB.prepare(
  'CREATE TABLE IF NOT EXISTS vox_kaggle_probe ('+
  'id INTEGER PRIMARY KEY CHECK(id=1),checked_at INTEGER NOT NULL,'+
  'token_kind TEXT NOT NULL,primary_status INTEGER NOT NULL,secondary_status INTEGER NOT NULL)'
 ).bind().run()
 const row=await env.MEMORY_DB.prepare('SELECT checked_at,ok FROM vox_kaggle_health WHERE id=1')
   .bind().all<{checked_at:number;ok:number}>()
 const last=row.results[0]
 const age=last?.ok===1?21600:60
 if(last?.checked_at && last.checked_at > Math.floor(Date.now()/1000)-age)return
 const token=env.KAGGLE_API_TOKEN||''
 const tokenKind=token.startsWith('KGAT_')?'personal-token':
   token.startsWith('{')?'legacy-json':token.length?'unknown-format':'missing'
 let primary=0,secondary=0,ok=0
 if(token){
  for(const [index,url] of [
   'https://api.kaggle.com/v1/kernels/list',
   'https://www.kaggle.com/api/v1/kernels/list'
  ].entries()){
   try{
    const response=await fetch(url+'?user='+OWNER+'&pageSize=1',{
     method:'GET',
     headers:{Authorization:'Bearer '+token,Accept:'application/json'},
     signal:AbortSignal.timeout(12000),
    })
    const body=await response.json().catch(()=>({})) as Record<string,unknown>
    const status=response.status
    if(index===0)primary=status
    else secondary=status
    if(response.ok && !body.error && !(typeof body.code==='number'&&body.code>=400)){
     ok=1
     break
    }
   }catch(e){
    console.error('Kaggle probe network failure',index,e instanceof Error?e.name:'unknown')
   }
  }
 }
 await env.MEMORY_DB.prepare(
  'INSERT INTO vox_kaggle_health(id,checked_at,ok,http_status) VALUES(1,unixepoch(),?,?) '+
  'ON CONFLICT(id) DO UPDATE SET checked_at=unixepoch(),ok=excluded.ok,http_status=excluded.http_status'
 ).bind(ok,primary||secondary).run()
 await env.MEMORY_DB.prepare(
  'INSERT INTO vox_kaggle_probe(id,checked_at,token_kind,primary_status,secondary_status) VALUES(1,unixepoch(),?,?,?) '+
  'ON CONFLICT(id) DO UPDATE SET checked_at=unixepoch(),token_kind=excluded.token_kind,'+
  'primary_status=excluded.primary_status,secondary_status=excluded.secondary_status'
 ).bind(tokenKind,primary,secondary).run()
}

/** Read-only compatibility probe against the user's existing public notebook. */
export async function probeKaggleReadMethods(env:VoxEnv):Promise<void>{
 if(!env.KAGGLE_API_TOKEN||!env.MEMORY_DB)return
 await env.MEMORY_DB.prepare(
 'CREATE TABLE IF NOT EXISTS vox_kaggle_rpc_probe ('+
 'id INTEGER PRIMARY KEY CHECK(id=1),checked_at INTEGER NOT NULL,'+
 'get_status INTEGER NOT NULL,post_status INTEGER NOT NULL,'+
 'get_output INTEGER NOT NULL,post_output INTEGER NOT NULL,'+
 'status_shape TEXT NOT NULL,output_shape TEXT NOT NULL)'
 ).bind().run()
 const existing=await env.MEMORY_DB.prepare(
 'SELECT checked_at FROM vox_kaggle_rpc_probe WHERE id=1'
 ).bind().all<{checked_at:number}>()
 if(existing.results[0])return
 const args={userName:OWNER,kernelSlug:'voxcpm2-full-working'}
 const shape=(body:Record<string,unknown>)=>Object.keys(body||{}).filter(x=>
  ['status','failureMessage','files','nextPageToken','log','url','code','message','error'].includes(x)
 ).join(',')
 const probe=async(action:'status'|'output',method:'GET'|'POST')=>{
  const base='https://api.kaggle.com/v1/kernels/'+action
  const query='?userName='+OWNER+'&kernelSlug=voxcpm2-full-working'
  try{
   const r=await fetch(base+(method==='GET'?query:''),{
    method,headers:{
     Authorization:'Bearer '+env.KAGGLE_API_TOKEN,
     Accept:'application/json',
     ...(method==='POST'?{'Content-Type':'application/json'}:{})
    },
    ...(method==='POST'?{body:JSON.stringify(args)}:{}),
    redirect:'manual',signal:AbortSignal.timeout(12000)
   })
   let data:Record<string,unknown>={}
   if((r.headers.get('content-type')||'').includes('json'))
    data=await r.json().catch(()=>({})) as Record<string,unknown>
   else await r.body?.cancel()
   return {status:r.status,shape:shape(data)}
  }catch{return {status:0,shape:'network-failure'}}
 }
 const [a,b,c,d]=await Promise.all([
  probe('status','GET'),probe('status','POST'),probe('output','GET'),probe('output','POST')
 ])
 await env.MEMORY_DB.prepare(
 'INSERT INTO vox_kaggle_rpc_probe(id,checked_at,get_status,post_status,get_output,post_output,status_shape,output_shape) VALUES(1,unixepoch(),?,?,?,?,?,?)'
 ).bind(a.status,b.status,c.status,d.status,a.shape||b.shape,c.shape||d.shape).run()
}

async function verified(env:VoxEnv):Promise<boolean>{
 if(!env.KAGGLE_API_TOKEN)return false
 await init(env.MEMORY_DB)
 const r=await env.MEMORY_DB.prepare('SELECT ok FROM vox_kaggle_health WHERE id=1').bind().all<{ok:number}>()
 return r.results[0]?.ok===1
}
async function readTextDocument(env:VoxEnv,file:VoxTelegramDocument):Promise<string>{
 const name=file.file_name||''
 if(!name.toLowerCase().endsWith('.txt'))throw Error('Only UTF-8 .txt files are supported')
 if(!file.file_id || (file.file_size||0)>65536)throw Error('Text file exceeds 64 KB')
 const token=env.TELEGRAM_BOT_TOKEN
 const meta=await fetch('https://api.telegram.org/bot'+token+'/getFile?file_id='+encodeURIComponent(file.file_id),{
  signal:AbortSignal.timeout(12000)
 })
 const info=await meta.json() as {ok?:boolean;result?:{file_path?:string;file_size?:number}}
 const path=info.result?.file_path||''
 if(!meta.ok||!info.ok||!path||path.startsWith('/')||path.includes('..')||(info.result?.file_size||0)>65536)
  throw Error('Telegram text file unavailable')
 const url='https://api.telegram.org/file/bot'+token+'/'+path.split('/').map(encodeURIComponent).join('/')
 const res=await fetch(url,{signal:AbortSignal.timeout(20000)})
 if(!res.ok || Number(res.headers.get('content-length')||0)>65536)throw Error('Text download failed')
 const buf=await res.arrayBuffer()
 if(buf.byteLength>65536)throw Error('Text file too large')
 const txt=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(buf).replace(/^\uFEFF/,'').trim()
 if(txt.includes('\0'))throw Error('Invalid text document')
 return txt
}

export async function handleVoxTelegram(env:VoxEnv,chat:string,messageId:number,text:string,
 send:(s:string)=>Promise<void>,message?:VoxTelegramMessage):Promise<boolean>{
 const cmd=text.trim().split(/\s+/,1)[0]?.split('@')[0].toLowerCase()
 if(!['/vox','/voxvoice','/voxvoices','/voxrename','/vox_status','/vox_help'].includes(cmd))return false
 try{
  await init(env.MEMORY_DB)
  if(cmd==='/vox_help'){
   await send('VoxCPM2: /vox TEXT creates a new voice. /voxvoice 1 TEXT uses a saved voice. /voxvoices lists 5 slots. /voxrename 1 Narrator names a slot. Tap Save this voice after generation. For long scripts, use .txt with caption /vox or reply with /voxvoice 1. Max 8,000 characters.')
   return true
  }
  if(cmd==='/voxvoices'){
   await voxVoiceMenu(env,chat,send)
   return true
  }
  if(cmd==='/voxrename'){
   const p=text.trim().match(/^\/voxrename(?:@[A-Za-z0-9_]+)?\s+([1-5])\s+([^\n]{1,50})$/i)
   if(!p){await send('Usage: /voxrename 1 Narrator');return true}
   await setupVoxVoices(env.MEMORY_DB)
   const r=await env.MEMORY_DB.prepare(
    "UPDATE vox_saved_voices SET name=?,updated_at=unixepoch() WHERE chat_id=? AND slot=?"
   ).bind(p[2].trim(),chat,Number(p[1])).run()
   await send(r.meta.changes?'Voice '+p[1]+' renamed to '+p[2].trim():'That voice slot is empty.')
   return true
  }
  if(cmd==='/vox_status'){
   const r=await env.MEMORY_DB.prepare('SELECT id,status,error_message FROM vox_kaggle_jobs WHERE chat_id=? ORDER BY id DESC LIMIT 1').bind(chat).all<{id:number;status:string;error_message:string|null}>()
   const job=r.results[0]
   await send(job?'VoxCPM2 job #'+job.id+': '+job.status+(job.error_message?'\n'+job.error_message:''):
     'No VoxCPM2 job yet. Use /vox YOUR TEXT.')
   return true
  }
  let phrase='',slot=0
  if(cmd==='/voxvoice'){
   const m=text.trim().match(/^\/voxvoice(?:@[A-Za-z0-9_]+)?\s+([1-5])(?:\s+([\s\S]*))?$/i)
   if(!m){await send('Use /voxvoice 1 YOUR TEXT, or reply to a .txt file with /voxvoice 1.');return true}
   slot=Number(m[1]);phrase=(m[2]||'').trim()
   await setupVoxVoices(env.MEMORY_DB)
   const found=await env.MEMORY_DB.prepare(
    'SELECT slot FROM vox_saved_voices WHERE chat_id=? AND slot=?'
   ).bind(chat,slot).all<{slot:number}>()
   if(!found.results.length){await send('Voice slot '+slot+' is empty. See /voxvoices.');return true}
  }else{
   phrase=text.replace(/^\/vox(?:@[A-Za-z0-9_]+)?(?:\s+|$)/i,'').trim()
  }
  const doc=message?.document || message?.reply_to_message?.document
  if(!phrase && doc){
   try{phrase=await readTextDocument(env,doc)}
   catch(e){
    console.error('Vox text document invalid',e instanceof Error?e.name:'unknown')
    await send('Please attach a UTF-8 .txt file (max 8,000 characters / 64 KB) with caption /vox, or reply to it using /vox.')
    return true
   }
  }
  if(!phrase || phrase.length>MAX_VOX_CHARS){
   await send('Usage: /vox YOUR TEXT (1–8,000 characters). For long scripts, send a UTF-8 .txt file with caption /vox or reply to that file with /vox. Your script exceeds the limit or is empty.')
   return true
  }
  if(!await verified(env)){
   await send('Kaggle API is not verified yet. No GPU job started. Check /vox_status later.')
   return true
  }
  const active=await env.MEMORY_DB.prepare(
   "SELECT COUNT(*) AS cnt FROM vox_kaggle_jobs WHERE chat_id=? AND status IN ('queued','submitting','submitted','running','delivering','submit-uncertain')"
  ).bind(chat).all<{cnt:number}>()
  if((active.results[0]?.cnt||0)>1){
   await send('You already have two unfinished VoxCPM2 jobs. Check /vox_status.')
   return true
  }
  await env.MEMORY_DB.prepare(
   'INSERT OR IGNORE INTO vox_kaggle_jobs(chat_id,message_id,text) VALUES(?,?,?)'
  ).bind(chat,messageId,phrase).run()
  const r=await env.MEMORY_DB.prepare('SELECT id FROM vox_kaggle_jobs WHERE chat_id=? AND message_id=?').bind(chat,messageId).all<{id:number}>()
  const jobId=r.results[0]?.id
  if(slot&&jobId)await env.MEMORY_DB.prepare(
   'INSERT OR IGNORE INTO vox_job_voice_slot(job_id,chat_id,slot) VALUES(?,?,?)'
  ).bind(jobId,chat,slot).run()
  await send('Kaggle VoxCPM2 job #'+jobId+' queued'+(slot?' with saved voice '+slot:' with new voice')+'. Use /vox_status.')
  return true
 }catch(e){
  console.error('Vox command failed',e instanceof Error?e.name:'unknown')
  await send('VoxCPM2 request failed. No GPU inference was started.').catch(()=>undefined)
  return true
 }
}
/** Separate kernel from the user's original seven-cell, dual-T4 Gradio studio. */
const VOX_KERNEL_PYTHON="import subprocess, json, time, re, base64\nfrom pathlib import Path\nstart=time.monotonic()\nsubprocess.run(['python','-m','pip','install','-q','voxcpm>=2.0.3','soundfile','huggingface_hub'],check=True)\nprint('VOX_STAGE pip_seconds',round(time.monotonic()-start,1),flush=True)\nimport numpy as np\nimport soundfile as sf\nfrom huggingface_hub import snapshot_download\nfrom voxcpm import VoxCPM\nTASK=json.loads(__VOX_TASK_LITERAL__)\ntext=TASK['text'].strip()\n\ndef split_script(src,limit=240):\n    items=re.split(r'(?<=[။.!?！？。])\\s*|\\n+',src)\n    out=[]\n    buf=''\n    def emit():\n        nonlocal buf\n        if buf.strip():\n            out.append(buf.strip())\n        buf=''\n    for item in items:\n        piece=item.strip()\n        if not piece:\n            continue\n        if len(piece)>limit:\n            emit()\n            while len(piece)>limit:\n                idx=max(piece.rfind(' ',0,limit+1),piece.rfind('၊',0,limit+1),piece.rfind(',',0,limit+1))\n                if idx<limit//2:\n                    idx=limit\n                elif piece[idx:idx+1] in ('၊',','):\n                    idx+=1\n                out.append(piece[:idx].strip())\n                piece=piece[idx:].strip()\n            if piece:\n                buf=piece\n            continue\n        trial=(buf+' '+piece).strip() if buf else piece\n        if len(trial)>limit:\n            emit()\n            buf=piece\n        else:\n            buf=trial\n    emit()\n    return out\n\nchunks=split_script(text)\nif not chunks or len(chunks)>64 or any(len(x)>240 for x in chunks):\n    raise ValueError('Unsupported text length or chunk count')\nprint('VOX_STAGE chunk_count',len(chunks),flush=True)\nMODEL_DIR='/kaggle/temp/VoxCPM2'\nPath(MODEL_DIR).mkdir(parents=True,exist_ok=True)\nif not Path(MODEL_DIR,'model.safetensors').exists():\n    snapshot_download(repo_id='openbmb/VoxCPM2',local_dir=MODEL_DIR)\nprint('VOX_STAGE model_download_seconds',round(time.monotonic()-start,1),flush=True)\nref_path=None\nif TASK.get('voice_ref_b64'):\n    compressed=base64.b64decode(TASK['voice_ref_b64'],validate=True)\n    if len(compressed)<1500 or len(compressed)>180000:\n        raise ValueError('Invalid saved voice sample')\n    raw_ref=Path('/kaggle/temp/vox_reference.mp3')\n    raw_ref.write_bytes(compressed)\n    ref_path='/kaggle/temp/vox_reference.wav'\n    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(raw_ref),'-ac','1','-ar','48000',ref_path],check=True,timeout=35)\nmodel=VoxCPM.from_pretrained(MODEL_DIR,load_denoiser=False,optimize=False,device='cuda')\nprint('VOX_STAGE model_loaded_seconds',round(time.monotonic()-start,1),flush=True)\nsample_rate=int(model.tts_model.sample_rate)\npieces=[]\nfor index,part in enumerate(chunks):\n    wav=model.generate(text=part,cfg_value=2.0,inference_timesteps=10,normalize=False,**({'reference_wav_path':ref_path} if ref_path else {}))\n    audio=np.asarray(wav,dtype=np.float32).reshape(-1)\n    if audio.size<100:\n        raise RuntimeError('Empty audio chunk '+str(index+1))\n    pieces.append(audio)\n    if index<len(chunks)-1:\n        pieces.append(np.zeros(int(sample_rate*0.18),dtype=np.float32))\n    print('VOX_CHUNK',index+1,'/',len(chunks),'elapsed_s',round(time.monotonic()-start,1),flush=True)\nmerged=np.concatenate(pieces)\ntmp=Path('/kaggle/temp/vox_merged.wav')\nsf.write(str(tmp),merged,sample_rate,subtype='PCM_16')\nout=Path('/kaggle/working/vox_generated.mp3')\nsubprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(tmp),'-codec:a','libmp3lame','-b:a','112k',str(out)],check=True,timeout=180)\npreview=Path('/kaggle/working/vox_voice_sample.mp3')\nsubprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(tmp),'-t','8','-codec:a','libmp3lame','-b:a','96k',str(preview)],check=True,timeout=60)\nif not preview.is_file() or preview.stat().st_size>180000:\n    raise RuntimeError('Voice preview missing or too large')\nif not out.is_file() or out.stat().st_size<1024 or out.stat().st_size>20*1024*1024:\n    raise RuntimeError('MP3 output missing or too large for Telegram')\nprint('VOX_GENERATED_SUCCESS',round(time.monotonic()-start,1),'file_bytes',out.stat().st_size,flush=True)\n";
function pythonFor(text:string,voiceRefB64:string|null):string{
 const safe=JSON.stringify(JSON.stringify({text,voice_ref_b64:voiceRefB64||''}))
 return VOX_KERNEL_PYTHON.replace('__VOX_TASK_LITERAL__',safe)
}
function matchOutput(data:Record<string,unknown>,target='vox_generated.mp3'):string|null{
 const files=(data.files||data.outputFiles||[]) as unknown
 if(!Array.isArray(files))return null
 for(const v of files){
  if(!v||typeof v!=='object')continue
  const f=v as Record<string,unknown>
  const name=String(f.fileName||f.file_name||'')
  const link=f.url
  if(!name.endsWith(target)||typeof link!=='string')continue
  try{
   const u=new URL(link)
   // Signed Kaggle/GCS download; do not fetch arbitrary addresses.
   if(u.protocol==='https:' && (
    u.hostname==='storage.googleapis.com' || u.hostname.endsWith('.googleapis.com')||
    u.hostname.endsWith('.kaggleusercontent.com')||u.hostname==='www.kaggle.com'||
    u.hostname==='api.kaggle.com'
   ))return u.href
  }catch{}
 }
 return null
}
async function deliver(env:VoxEnv,job:Job,url:string,previewUrl:string|null){
 const r=await fetch(url,{signal:AbortSignal.timeout(60000)})
 if(!r.ok||Number(r.headers.get('content-length')||0)>20*1024*1024)
  throw Error('Kaggle result download not available')
 const audio=await r.blob()
 if(audio.size<1024||audio.size>20*1024*1024)throw Error('Kaggle audio too large or missing')
 const header=new Uint8Array(await audio.slice(0,12).arrayBuffer())
 const marker=String.fromCharCode(...header.slice(0,3))
 if(marker!=='ID3' && !(header[0]===255 && (header[1]&224)===224))throw Error('Kaggle result not MP3')
 const hasPreview=previewUrl ? await storeVoxReference(env,job.id,job.chat_id,previewUrl) : false
 const data=new FormData()
 data.set('chat_id',job.chat_id)
 data.set('caption','Kaggle VoxCPM2 job #'+job.id)
 data.set('audio',audio,'vox-'+job.id+'.mp3')
 if(hasPreview)data.set('reply_markup',JSON.stringify({inline_keyboard:[[{text:'⭐ Save this voice',callback_data:'vx:save:'+job.id}]]}))
 const out=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/sendAudio',{
  method:'POST',body:data,signal:AbortSignal.timeout(60000)
 })
 const j=await out.json() as {ok?:boolean}
 if(!out.ok||!j.ok)throw Error('Telegram audio delivery failed')
}
export async function pollVoxKaggle(env:VoxEnv):Promise<void>{
 if(!env.MEMORY_DB||!env.KAGGLE_API_TOKEN)return
 await init(env.MEMORY_DB)
 const enabled=await verified(env)
 if(!enabled)return
 const executing=await env.MEMORY_DB.prepare(
 "SELECT id,chat_id,text,status,version_number,error_message FROM vox_kaggle_jobs "+
 "WHERE status IN ('submitting','submitted','running','delivering','submit-uncertain') ORDER BY id LIMIT 1"
 ).bind().all<Job>()
 const job=executing.results[0]
 if(job){
  if(['submitting','submit-uncertain','delivering'].includes(job.status))return
  if(!job.version_number)return
  try{
   const version='v'+job.version_number
   const state=await kaggle(env,'status',{userName:OWNER,kernelSlug:SLUG,versionLabel:version})
   const raw=String(state.status||state.state||'').toUpperCase()
   if(raw.includes('ERROR')||raw.includes('FAIL')||raw.includes('CANCEL')){
    await env.MEMORY_DB.prepare(
     "UPDATE vox_kaggle_jobs SET status='failed',error_message='Kaggle execution failed',updated_at=unixepoch() WHERE id=?"
    ).bind(job.id).run()
    await tell(env,job.chat_id,'Kaggle VoxCPM2 job #'+job.id+' failed. See Kaggle notebook logs.').catch(()=>undefined)
    return
   }
   if(raw.includes('COMPLETE')||raw.includes('SUCCESS')){
    const outputs=await kaggle(env,'output',{userName:OWNER,kernelSlug:SLUG,versionLabel:version})
    const url=matchOutput(outputs)
    const previewUrl=matchOutput(outputs,'vox_voice_sample.mp3')
    if(!url)throw Error('Completed Kaggle run has no WAV download URL')
    const claim=await env.MEMORY_DB.prepare(
     "UPDATE vox_kaggle_jobs SET status='delivering',updated_at=unixepoch() WHERE id=? AND status IN ('submitted','running')"
    ).bind(job.id).run()
    if(claim.meta.changes!==1)return
    try{
     await deliver(env,job,url,previewUrl)
     await env.MEMORY_DB.prepare("UPDATE vox_kaggle_jobs SET status='done',updated_at=unixepoch() WHERE id=?").bind(job.id).run()
    }catch(e){
     console.error('Vox delivery uncertain',e instanceof Error?e.message.slice(0,120):'unknown')
     await env.MEMORY_DB.prepare("UPDATE vox_kaggle_jobs SET status='delivery-uncertain',updated_at=unixepoch() WHERE id=?").bind(job.id).run()
     await tell(env,job.chat_id,'VoxCPM2 audio is generated but delivery needs review. Kaggle: https://www.kaggle.com/code/'+KERNEL).catch(()=>undefined)
    }
    return
   }
   await env.MEMORY_DB.prepare("UPDATE vox_kaggle_jobs SET status='running',updated_at=unixepoch() WHERE id=? AND status='submitted'").bind(job.id).run()
  }catch(e){
   console.error('Vox status check failed',e instanceof Error?e.message.slice(0,120):'unknown')
   // Do not claim that failure is terminal on a temporary Kaggle rate limit.
  }
  return
 }
 const claimed=await env.MEMORY_DB.prepare(
 "UPDATE vox_kaggle_jobs SET status='submitting',updated_at=unixepoch() WHERE id=("+
 "SELECT id FROM vox_kaggle_jobs WHERE status='queued' ORDER BY id LIMIT 1)"+
 "AND NOT EXISTS (SELECT 1 FROM vox_kaggle_jobs WHERE status IN ('submitting','submitted','running','delivering','submit-uncertain'))"
 ).bind().run()
 if(!claimed.meta.changes)return
 const candidate=await env.MEMORY_DB.prepare(
 "SELECT id,chat_id,text,status,version_number,error_message FROM vox_kaggle_jobs WHERE status='submitting' ORDER BY updated_at DESC,id DESC LIMIT 1"
 ).bind().all<Job>()
 const next=candidate.results[0]
 if(!next)return
 try{
  const sampleB64=await voiceForJob(env.MEMORY_DB,next.id,next.chat_id)
  const result=await kaggle(env,'push',{
   slug:KERNEL,newTitle:'VoxCPM2 Telegram Worker',text:pythonFor(next.text,sampleB64),
   language:'python',kernelType:'script',isPrivate:true,enableGpu:true,enableInternet:true,
   machineShape:'NvidiaTeslaT4',sessionTimeoutSeconds:3600,
   datasetDataSources:[],competitionDataSources:[],kernelDataSources:[],modelDataSources:[]
  },45000)
  const version=Number(result.versionNumber||result.version_number||0)
  if(!Number.isSafeInteger(version)||version<1||result.error)throw Error('Kaggle push did not return a version')
  await env.MEMORY_DB.prepare(
    "UPDATE vox_kaggle_jobs SET status='submitted',version_number=?,updated_at=unixepoch() WHERE id=?"
  ).bind(version,next.id).run()
  await tell(env,next.chat_id,'VoxCPM2 job #'+next.id+' submitted to Kaggle GPU (version '+version+'). Checking status every minute.').catch(()=>undefined)
 }catch(e){
  console.error('Kaggle Vox submission uncertain',e instanceof Error?e.message.slice(0,120):'unknown')
  await env.MEMORY_DB.prepare(
   "UPDATE vox_kaggle_jobs SET status='submit-uncertain',error_message='Submission could not be confirmed; do not retry automatically',updated_at=unixepoch() WHERE id=?"
  ).bind(next.id).run()
  await tell(env,next.chat_id,'VoxCPM2 job #'+next.id+' submission could not be confirmed. Check Kaggle notebook history; no automatic retry to avoid GPU duplication.').catch(()=>undefined)
 }
}
