/**
 * Cloudflare-only Kaggle VoxCPM2 batch orchestration.
 * Uses the same HTTP RPCs as Kaggle's official Python SDK (no OCI, no shell).
 * Every submitted private Kaggle kernel gets one version, with serialized jobs.
 */
type D1 = { prepare(query:string):{bind(...v:(string|number)[]):{
 run():Promise<{meta:{changes:number}}>;all<T>():Promise<{results:T[]}>
}}}
export type VoxEnv = {MEMORY_DB:D1;TELEGRAM_BOT_TOKEN:string;KAGGLE_API_TOKEN?:string}
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
 const r=await fetch(BASE+action,{
  method:'POST',headers:{
   'Authorization':'Bearer '+env.KAGGLE_API_TOKEN,
   'Content-Type':'application/json',
   'Accept':'application/json',
  },
  body:JSON.stringify(body),
  signal:AbortSignal.timeout(timeoutMs)
 })
 const data=await r.json().catch(()=>({})) as Record<string,unknown>
 if(!r.ok || (typeof data.code==='number'&&data.code>=400)){
  throw Error('Kaggle '+action+' HTTP '+r.status)
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
export async function handleVoxTelegram(env:VoxEnv,chat:string,messageId:number,text:string,
 send:(s:string)=>Promise<void>):Promise<boolean>{
 const cmd=text.trim().split(/\s+/,1)[0]?.split('@')[0].toLowerCase()
 if(!['/vox','/vox_status','/vox_help'].includes(cmd))return false
 try{
  await init(env.MEMORY_DB)
  if(cmd==='/vox_help'){
   await send('Kaggle VoxCPM2 TTS: /vox YOUR TEXT\nCheck status: /vox_status\nEach job runs in a private Kaggle notebook version (T4 GPU). Maximum 450 characters.')
   return true
  }
  if(cmd==='/vox_status'){
   const r=await env.MEMORY_DB.prepare('SELECT id,status,error_message FROM vox_kaggle_jobs WHERE chat_id=? ORDER BY id DESC LIMIT 1').bind(chat).all<{id:number;status:string;error_message:string|null}>()
   const job=r.results[0]
   await send(job?'VoxCPM2 job #'+job.id+': '+job.status+(job.error_message?'\n'+job.error_message:''):
     'No VoxCPM2 job yet. Use /vox YOUR TEXT.')
   return true
  }
  const phrase=text.replace(/^\/vox(?:@[A-Za-z0-9_]+)?(?:\s+|$)/i,'').trim()
  if(!phrase || phrase.length>450){
   await send('Usage: /vox YOUR TEXT (1–450 characters)\nExample: /vox မင်္ဂလာပါ။')
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
  await send('Kaggle VoxCPM2 job #'+r.results[0]?.id+' queued. GPU starts automatically when available. Use /vox_status.')
  return true
 }catch(e){
  console.error('Vox command failed',e instanceof Error?e.name:'unknown')
  await send('VoxCPM2 request failed. No GPU inference was started.').catch(()=>undefined)
  return true
 }
}
/** Separate kernel from the user's original seven-cell, dual-T4 Gradio studio. */
function pythonFor(text:string):string{
 const safe=JSON.stringify(JSON.stringify({text}))
 return [
 'import subprocess, json, os',
 "subprocess.run(['python','-m','pip','install','-q','voxcpm>=2.0.3','soundfile','huggingface_hub'],check=True)",
 'from pathlib import Path',
 'import soundfile as sf',
 'from huggingface_hub import snapshot_download',
 'from voxcpm import VoxCPM',
 'TASK=json.loads('+safe+')',
 "MODEL_DIR='/kaggle/working/VoxCPM2'",
 "if not Path(MODEL_DIR,'model.safetensors').exists():",
 "    snapshot_download(repo_id='openbmb/VoxCPM2',local_dir=MODEL_DIR)",
 "model=VoxCPM.from_pretrained(MODEL_DIR,load_denoiser=False,optimize=False,device='cuda')",
 "wav=model.generate(text=TASK['text'],cfg_value=2.0,inference_timesteps=10,normalize=False)",
 "sf.write('/kaggle/working/vox_generated.wav',wav,model.tts_model.sample_rate,subtype='PCM_16')",
 "print('VOX_GENERATED_SUCCESS')",
 ].join('\n')
}
function matchOutput(data:Record<string,unknown>):string|null{
 const files=(data.files||data.outputFiles||[]) as unknown
 if(!Array.isArray(files))return null
 for(const v of files){
  if(!v||typeof v!=='object')continue
  const f=v as Record<string,unknown>
  const name=String(f.fileName||f.file_name||'')
  const link=f.url
  if(!name.endsWith('vox_generated.wav')||typeof link!=='string')continue
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
async function deliver(env:VoxEnv,job:Job,url:string){
 const r=await fetch(url,{signal:AbortSignal.timeout(60000)})
 if(!r.ok||Number(r.headers.get('content-length')||0)>20*1024*1024)
  throw Error('Kaggle result download not available')
 const wav=await r.blob()
 if(wav.size<44||wav.size>20*1024*1024)throw Error('Kaggle audio too large or missing')
 const header=String.fromCharCode(...new Uint8Array(await wav.slice(0,12).arrayBuffer()))
 if(!header.startsWith('RIFF')||header.slice(8,12)!=='WAVE')throw Error('Kaggle result not WAV')
 const data=new FormData()
 data.set('chat_id',job.chat_id)
 data.set('caption','Kaggle VoxCPM2 job #'+job.id)
 data.set('audio',wav,'vox-'+job.id+'.wav')
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
    if(!url)throw Error('Completed Kaggle run has no WAV download URL')
    const claim=await env.MEMORY_DB.prepare(
     "UPDATE vox_kaggle_jobs SET status='delivering',updated_at=unixepoch() WHERE id=? AND status IN ('submitted','running')"
    ).bind(job.id).run()
    if(claim.meta.changes!==1)return
    try{
     await deliver(env,job,url)
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
  const result=await kaggle(env,'push',{
   slug:KERNEL,newTitle:'VoxCPM2 Telegram Worker',text:pythonFor(next.text),
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
