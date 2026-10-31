/**
 * pyVideoTrans private Kaggle job dispatcher for Telegram video dubbing.
 * Runs Microsoft Edge TTS or the native VoxCPM2 T4 provider, never on Workers.
 * Does not reuse the existing text-only VoxCPM2 Kaggle notebook/queue.
 *
 * Media is streamed through a signed, short-lived GET on the already-public
 * /telegram/webhook path (different HTTP method from Telegram's POST update).
 * Telegram and Kaggle bearer credentials never enter the Kaggle notebook.
 */
type DB={prepare(sql:string):{bind(...x:(string|number)[]):{
 run():Promise<{meta:{changes:number}}>;all<T>():Promise<{results:T[]}>
}}}
export type VideoEnv={
 MEMORY_DB:DB;KAGGLE_API_TOKEN?:string;TELEGRAM_BOT_TOKEN:string;
 TELEGRAM_WEBHOOK_SECRET:string
}
type Media={file_id:string;file_size?:number;file_name?:string;mime_type?:string}
type Message={message_id:number;video?:Media;document?:Media;
 reply_to_message?:{video?:Media;document?:Media}}
type Job={id:number;chat_id:string;file_id:string;file_ext:string;source_lang:string;target_lang:string;
 engine:string;voice:string;voice_slot:number;status:string;version_number:number|null;created_at:number;error_message:string|null}
const KERNEL='cyawzin/pyvideotrans-telegram-dub'
const OWNER='cyawzin'
const SLUG='pyvideotrans-telegram-dub'
const KAGGLE='https://api.kaggle.com/v1/kernels/'
const MAX_INPUT=20*1024*1024
const MAX_OUTPUT=49*1024*1024
// Disabled by default. Only an explicit private admin DB flag can enable
// costly Kaggle video jobs after Python 3.10 and video pipeline validation.
async function isReady(env:VideoEnv):Promise<boolean>{
 await env.MEMORY_DB.prepare(
  "CREATE TABLE IF NOT EXISTS pyvt_config (id INTEGER PRIMARY KEY CHECK(id=1),"+
  "enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)))"
 ).bind().run()
 const r=await env.MEMORY_DB.prepare(
  'SELECT enabled FROM pyvt_config WHERE id=1'
 ).bind().all<{enabled:number}>()
 return r.results[0]?.enabled===1
}
const HELP='Video translation + dubbing (private Kaggle jobs):\n'+
 '/dub edge en my — dub English video into Burmese using Microsoft Edge TTS (Nilar).\n'+
 '/dub vox en my — dub with VoxCPM2 on Kaggle T4 GPU.\n'+
 '/dub vox en my 1 — reuse your saved VoxCPM2 voice slot 1.\n'+
 '/dub_status — latest dubbing job status.\n'+
 'Attach a video <=20MB with /dub ... as its caption, or reply to a video with the command.\n'+
 'This beta is not enabled until Kaggle runtime testing confirms the video pipeline.'
const defaultVoices:Record<string,string>={
 my:'my-MM-NilarNeural',en:'en-US-AriaNeural',zh:'zh-CN-XiaoxiaoNeural',
 th:'th-TH-PremwadeeNeural',ja:'ja-JP-NanamiNeural'
}
async function init(db:DB){
 await db.prepare("CREATE TABLE IF NOT EXISTS pyvt_kaggle_jobs ("+
  "id INTEGER PRIMARY KEY AUTOINCREMENT,chat_id TEXT NOT NULL,message_id INTEGER NOT NULL,"+
  "file_id TEXT NOT NULL,file_ext TEXT NOT NULL,file_size INTEGER NOT NULL,"+
  "source_lang TEXT NOT NULL,target_lang TEXT NOT NULL,engine TEXT NOT NULL,voice TEXT NOT NULL,"+
  "status TEXT NOT NULL DEFAULT 'queued',version_number INTEGER,error_message TEXT,voice_slot INTEGER NOT NULL DEFAULT 0,"+
  "created_at INTEGER NOT NULL DEFAULT (unixepoch()),updated_at INTEGER NOT NULL DEFAULT (unixepoch()),"+
  "UNIQUE(chat_id,message_id))"
 ).bind().run()
}
async function reply(env:VideoEnv,chat:string,text:string){
 const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/sendMessage',{
  method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({chat_id:chat,text:text.slice(0,3900)}),signal:AbortSignal.timeout(15000)
 })
 if(!r.ok)throw Error('Telegram message failed')
}
function selectMedia(msg:Message):Media|null{
 return msg.video||msg.document||msg.reply_to_message?.video||msg.reply_to_message?.document||null
}
export async function pyvtCommand(env:VideoEnv,msg:Message,chat:string,text:string,
 send:(text:string)=>Promise<void>):Promise<boolean>{
 const command=text.trim().split(/\s+/,1)[0]?.split('@')[0].toLowerCase()
 if(!['/dub','/dub_help','/dub_status'].includes(command))return false
 try{
  await init(env.MEMORY_DB)
  if(command==='/dub_help'){await send(HELP);return true}
  if(command==='/dub_status'){
   const r=await env.MEMORY_DB.prepare(
    'SELECT id,status,error_message FROM pyvt_kaggle_jobs WHERE chat_id=? ORDER BY id DESC LIMIT 1'
   ).bind(chat).all<{id:number;status:string;error_message:string|null}>()
   const j=r.results[0]
   await send(j?'Video dub job #'+j.id+': '+j.status+(j.error_message?'\n'+j.error_message:''):
    'No dubbing job yet. Use /dub_help for the supported commands.')
   return true
  }
  if(!await isReady(env)){
   await send('Video dubbing on Kaggle is in compatibility testing. No GPU job submitted. '+HELP)
   return true
  }
  const parsed=text.trim().match(/^\/dub(?:@[a-zA-Z0-9_]+)?\s+(edge|vox)\s+([a-z]{2,3})\s+([a-z]{2,3})(?:\s+([a-zA-Z-]{4,80}))?$/i)
  if(!parsed){await send(HELP);return true}
  const engine=parsed[1].toLowerCase(),sourceLang=parsed[2].toLowerCase(),targetLang=parsed[3].toLowerCase()
  const rawVoice=parsed[4]
  const slot=engine==='vox'&&rawVoice&&/^[1-5]$/.test(rawVoice)?Number(rawVoice):0
  if(engine==='vox'&&rawVoice&&!slot){await send('For VoxCPM2 use a saved slot 1–5, e.g. /dub vox en my 1. Omit it for default voice.');return true}
  if(slot){
   const found=await env.MEMORY_DB.prepare('SELECT slot FROM vox_saved_voices WHERE chat_id=? AND slot=? LIMIT 1')
    .bind(chat,slot).all<{slot:number}>()
   if(!found.results.length){await send('VoxCPM2 voice slot '+slot+' is empty. Use /voxvoices.');return true}
  }
  const voice=engine==='vox'?'Narrator':rawVoice||defaultVoices[targetLang]
  if(engine==='edge'&&!voice){await send('Choose an Edge voice for this language, e.g. /dub edge en my my-MM-NilarNeural');return true}
  if(sourceLang===targetLang){await send('Source and target language are identical. Choose distinct codes or use /vox for speech only.');return true}
  const media=selectMedia(msg)
  if(!media){await send('Attach a short video and add /dub '+engine+' '+sourceLang+' '+targetLang+' as its caption, or reply to a video with the command.');return true}
  const extension=(media.file_name||'').toLowerCase().split('.').pop()||'mp4'
  const ext=['mp4','mkv','mov','webm'].includes(extension)?extension:'mp4'
  if(!media.file_id||!media.file_size||media.file_size>MAX_INPUT){
   await send('The standard Telegram Bot API can download video files up to 20 MB. Compress the video and try again.');return true
  }
  const existing=await env.MEMORY_DB.prepare(
   "SELECT COUNT(*) AS total FROM pyvt_kaggle_jobs WHERE chat_id=? AND status IN ('queued','submitting','submitted','running','delivering','submit-uncertain')"
  ).bind(chat).all<{total:number}>()
  if((existing.results[0]?.total||0)>=1){await send('One video dubbing job is already active for your account. Check /dub_status.');return true}
  await env.MEMORY_DB.prepare(
   'INSERT OR IGNORE INTO pyvt_kaggle_jobs(chat_id,message_id,file_id,file_ext,file_size,source_lang,target_lang,engine,voice,voice_slot) VALUES(?,?,?,?,?,?,?,?,?,?)'
  ).bind(chat,msg.message_id,media.file_id,ext,media.file_size,sourceLang,targetLang,engine,voice,slot).run()
  const result=await env.MEMORY_DB.prepare(
   'SELECT id FROM pyvt_kaggle_jobs WHERE chat_id=? AND message_id=?'
  ).bind(chat,msg.message_id).all<{id:number}>()
  await send('Video job #'+result.results[0]?.id+' queued: '+engine.toUpperCase()+
   ' TTS, '+sourceLang+' → '+targetLang+'. Kaggle will process when GPU is available. /dub_status')
 }catch(e){
  console.error('pyVideoTrans Telegram request failed',e instanceof Error?e.name:'unknown')
  await send('The video dubbing queue is unavailable. No new Kaggle GPU job was confirmed.').catch(()=>undefined)
 }
 return true
}
function hex(bytes:ArrayBuffer):string{
 return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('')
}
async function signature(secret:string,id:number,expires:number){
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),
   {name:'HMAC',hash:'SHA-256'},false,['sign'])
 return hex(await crypto.subtle.sign('HMAC',key,
   new TextEncoder().encode('pyvt-file:'+id+':'+expires)))
}
function safeEqual(a:string,b:string){
 if(a.length!==b.length)return false
 let diff=0
 for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i)
 return diff===0
}
function fileURL(id:number,expiration:number,sig:string){
 return 'https://vite-react-template.canibeyours2001.workers.dev/telegram/webhook?pvfile='+
   id+'&expire='+expiration+'&sig='+sig
}
export async function pyvtSignedFile(env:VideoEnv,request:Request):Promise<Response>{
 const url=new URL(request.url)
 const id=Number(url.searchParams.get('pvfile')),expiry=Number(url.searchParams.get('expire'))
 const supplied=url.searchParams.get('sig')||''
 if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(expiry)||
    expiry<Math.floor(Date.now()/1000)||expiry>Math.floor(Date.now()/1000)+43200||
    !/^[0-9a-f]{64}$/.test(supplied)||!env.TELEGRAM_WEBHOOK_SECRET)
   return new Response('Not found',{status:404})
 const valid=await signature(env.TELEGRAM_WEBHOOK_SECRET,id,expiry)
 if(!safeEqual(valid,supplied))return new Response('Not found',{status:404})
 await init(env.MEMORY_DB)
 const entries=await env.MEMORY_DB.prepare(
  "SELECT file_id,file_ext,file_size FROM pyvt_kaggle_jobs WHERE id=? AND status IN ('submitting','submitted','running')"
 ).bind(id).all<{file_id:string;file_ext:string;file_size:number}>()
 const file=entries.results[0]
 if(!file||file.file_size>MAX_INPUT)return new Response('Not found',{status:404})
 const response=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+
   '/getFile?file_id='+encodeURIComponent(file.file_id),{signal:AbortSignal.timeout(14000)})
 const result=await response.json() as {ok?:boolean;result?:{file_path?:string;file_size?:number}}
 const path=result.result?.file_path
 if(!response.ok||!result.ok||!path||path.startsWith('/')||path.includes('..')||
    (result.result?.file_size||0)>MAX_INPUT)
   return new Response('File not available',{status:502})
 const media=await fetch('https://api.telegram.org/file/bot'+env.TELEGRAM_BOT_TOKEN+'/'+
   path.split('/').map(encodeURIComponent).join('/'),{signal:AbortSignal.timeout(60000)})
 if(!media.ok||Number(media.headers.get('content-length')||0)>MAX_INPUT){
  await media.body?.cancel()
  return new Response('Media unavailable',{status:502})
 }
 return new Response(media.body,{
  headers:{'content-type':file.file_ext==='mkv'?'video/x-matroska':'video/mp4',
   'cache-control':'private, no-store','x-content-type-options':'nosniff'}
 })
}
function renderKernel(job:Job,inputUrl:string,voiceB64:string):string{
 const task={url:inputUrl,source:job.source_lang,target:job.target_lang,
  provider:job.engine,voice:job.voice,ext:job.file_ext,voice_ref_b64:voiceB64}
 // Generated script embeds an expiring URL only, never a Telegram token or Kaggle credential.
 return [
 'import json, os, sys, subprocess, pathlib, shutil, base64',
 "TASK=json.loads("+JSON.stringify(JSON.stringify(task))+")",
 "ROOT=pathlib.Path('/kaggle/temp/pyvideotrans-job')",
 "ROOT.mkdir(parents=True,exist_ok=True)",
 "subprocess.run([sys.executable,'-m','pip','install','-q','requests','uv'],check=True)",
 "import requests",
 "video=ROOT/('source.'+TASK['ext'])",
 "with requests.get(TASK['url'],stream=True,timeout=100) as r:",
 "    r.raise_for_status()",
 "    with video.open('wb') as dst:",
 "        total=0",
 "        for chunk in r.iter_content(1024*1024):",
 "            total+=len(chunk)",
 "            if total>20*1024*1024: raise ValueError('Video >20MB')",
 "            dst.write(chunk)",
 "if video.stat().st_size<4096: raise ValueError('Video empty')",
 "repo=ROOT/'pyvideotrans'",
 "subprocess.run(['git','clone','--quiet','--depth','1','--branch','main','https://github.com/canibeyours2001-ui/pyvideotrans.git',str(repo)],check=True,timeout=120)",
 "subprocess.run(['uv','python','install','3.10'],check=True,timeout=240)",
 "subprocess.run(['uv','sync','--python','3.10','--no-dev','--project',str(repo)],check=True,timeout=2100)",
 "python=repo/'.venv/bin/python'",
 "command=[str(python),str(repo/'tools/kaggle_video_dub_job.py'),'--task','vtv','--input',str(video),"+
  "'--tts',TASK['provider'],'--voice-role',TASK['voice'],'--source-language-code',TASK['source'],"+
  "'--target-language-code',TASK['target'],'--translate-type','0','--whisper-model','small',"+
  "'--recogn-type','0','--temp-output',str(ROOT/'results'),'--final-output','/kaggle/working/pyvideotrans_result.mp4','--voice-autorate']",
 "if TASK['provider']=='voxcpm2': command.append('--cuda')",
 "if TASK.get('voice_ref_b64'):",
 "    blob=base64.b64decode(TASK['voice_ref_b64'],validate=True)",
 "    if len(blob)<1500 or len(blob)>180000: raise ValueError('Bad saved voice reference')",
 "    refmp3=ROOT/'voice-reference.mp3'",
 "    refwav=ROOT/'voice-reference.wav'",
 "    refmp3.write_bytes(blob)",
 "    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(refmp3),'-ac','1','-ar','48000',str(refwav)],check=True,timeout=40)",
 "    command.extend(['--reference-wav',str(refwav)])",
 "subprocess.run(command,check=True,cwd=str(repo),timeout=3200)",
 "assert pathlib.Path('/kaggle/working/pyvideotrans_result.mp4').stat().st_size>4096",
 "print('PYVIDEOTRANS_VIDEO_READY')"
 ].join('\n')
}
async function kaggle(env:VideoEnv,method:'push'|'status'|'output',body:Record<string,unknown>){
 const isPush=method==='push',u=new URL(KAGGLE+method)
 if(!isPush)for(const k of ['userName','kernelSlug','versionLabel']){
  const v=body[k]
  if(typeof v==='string')u.searchParams.set(k,v)
 }
 const response=await fetch(u,{
  method:isPush?'POST':'GET',
  headers:{Authorization:'Bearer '+env.KAGGLE_API_TOKEN,Accept:'application/json',
    ...(isPush?{'content-type':'application/json'}:{})},
  ...(isPush?{body:JSON.stringify(body)}:{}),
  signal:AbortSignal.timeout(isPush?55000:25000)
 })
 const data=await response.json().catch(()=>({})) as Record<string,unknown>
 if(!response.ok||data.error)throw Error('Kaggle '+method+' HTTP '+response.status)
 return data
}
function resultUrl(files:Record<string,unknown>):string|null{
 const list=files.files||files.outputFiles
 if(!Array.isArray(list))return null
 for(const raw of list){
  if(!raw||typeof raw!=='object')continue
  const f=raw as Record<string,unknown>
  const name=String(f.fileName||f.file_name||''),url=f.url
  if(name!=='pyvideotrans_result.mp4'||typeof url!=='string')continue
  try{
   const parsed=new URL(url)
   if(parsed.protocol==='https:'&&(
     parsed.hostname==='storage.googleapis.com'||
     parsed.hostname==='api.kaggle.com'||
     parsed.hostname==='www.kaggle.com'||
     parsed.hostname.endsWith('.kaggleusercontent.com')||
     parsed.hostname.endsWith('.googleapis.com')
   ))return parsed.href
  }catch{}
 }
 return null
}
async function sendVideo(env:VideoEnv,job:Job,url:string):Promise<void>{
 const r=await fetch(url,{signal:AbortSignal.timeout(60000)})
 if(!r.ok||Number(r.headers.get('content-length')||0)>MAX_OUTPUT)throw Error('Kaggle video download unavailable')
 const video=await r.blob()
 if(video.size<4096||video.size>MAX_OUTPUT)throw Error('Video too large or missing')
 const form=new FormData()
 form.set('chat_id',job.chat_id)
 form.set('caption','pyVideoTrans Kaggle job #'+job.id+' completed ('+job.engine+' TTS)')
 form.set('video',video,'pyvideotrans-'+job.id+'.mp4')
 const sent=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/sendVideo',{
  method:'POST',body:form,signal:AbortSignal.timeout(65000)
 })
 const resp=await sent.json() as {ok?:boolean}
 if(!sent.ok||!resp.ok)throw Error('Telegram sendVideo failed')
}

/** One-off, CPU-only Kaggle compatibility test for pyVideoTrans Python 3.10.
 *  Never runs unless requested explicitly via private D1 control table.
 *  No video, speech content, Kaggle GPU, or Telegram messages are used.
 */
export async function pyvtPreflight(env:VideoEnv):Promise<void>{
 if(!env.KAGGLE_API_TOKEN||!env.MEMORY_DB)return
 const db=env.MEMORY_DB
 await db.prepare('CREATE TABLE IF NOT EXISTS pyvt_preflight ('+
   "id INTEGER PRIMARY KEY CHECK(id=1),status TEXT NOT NULL,version INTEGER,"+
   "detail TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL DEFAULT (unixepoch()))"
 ).bind().run()
 const result=await db.prepare('SELECT status,version FROM pyvt_preflight WHERE id=1')
  .bind().all<{status:string;version:number|null}>()
 const job=result.results[0]
 if(!job)return
 if(job.status==='requested'){
  const claim=await db.prepare("UPDATE pyvt_preflight SET status='submitting',updated_at=unixepoch() WHERE id=1 AND status='requested'").bind().run()
  if(!claim.meta.changes)return
  const python=[
    'import subprocess,sys,pathlib',
    "subprocess.run([sys.executable,'-m','pip','install','-q','uv'],check=True,timeout=250)",
    "root=pathlib.Path('/kaggle/temp/pyvt-check')",
    "subprocess.run(['git','clone','--quiet','--depth','1','--branch','main','https://github.com/canibeyours2001-ui/pyvideotrans.git',str(root)],check=True,timeout=150)",
    "subprocess.run(['uv','python','install','3.10'],check=True,timeout=300)",
    "subprocess.run(['uv','sync','--python','3.10','--no-dev','--project',str(root)],check=True,timeout=2100)",
    "p=subprocess.run([str(root/'.venv/bin/python'),str(root/'cli.py'),'--list','providers'],cwd=str(root),capture_output=True,text=True,timeout=120)",
    "print('PYVT_PREFLIGHT_EXIT',p.returncode,'STDERR',p.stderr[-350:].replace('\\n',' '),flush=True)",
    "assert p.returncode==0, 'pyVideoTrans CLI startup failed'",
    "assert 'VoxCPM2' in p.stdout, 'VoxCPM2 provider missing'",
    "assert 'Edge-TTS' in p.stdout, 'Edge provider missing'",
    "print('PYVT_PREFLIGHT_OK',flush=True)"
  ].join('\n')
  try{
   const pushed=await kaggle(env,'push',{
    slug:'cyawzin/pyvideotrans-compatibility-check',
    newTitle:'Private pyVideoTrans Python 3.10 environment check',
    text:python,language:'python',kernelType:'script',isPrivate:true,
    enableGpu:false,enableInternet:true,sessionTimeoutSeconds:3600,
    datasetDataSources:[],competitionDataSources:[],kernelDataSources:[],modelDataSources:[]
   })
   const v=Number(pushed.versionNumber||pushed.version_number||0)
   if(!Number.isSafeInteger(v)||v<1)throw Error('Kaggle returned no version')
   await db.prepare("UPDATE pyvt_preflight SET status='submitted',version=?,updated_at=unixepoch() WHERE id=1")
    .bind(v).run()
  }catch(e){
   console.error('pyVideoTrans compatibility test submit uncertain',e instanceof Error?e.name:'unknown')
   await db.prepare("UPDATE pyvt_preflight SET status='submit-uncertain',detail='Kaggle submission not confirmed',updated_at=unixepoch() WHERE id=1").bind().run()
  }
  return
 }
 if((job.status==='submitted'||job.status==='running')&&job.version){
  try{
   const response=await kaggle(env,'status',{
    userName:OWNER,kernelSlug:'private-pyvideotrans-python-3-10-environment-check',versionLabel:'v'+job.version
   })
   const state=String(response.status||response.state||'').toUpperCase()
   let status='running',detail=''
   if(state.includes('COMPLETE')||state.includes('SUCCESS')){
    const output=await kaggle(env,'output',{
     userName:OWNER,kernelSlug:'private-pyvideotrans-python-3-10-environment-check',
     versionLabel:'v'+job.version
    })
    const log=String(output.log||'')
    if(log.includes('PYVT_PREFLIGHT_OK')){
     status='done';detail='Python 3.10, pyVideoTrans CLI and both TTS providers verified'
    }else{
     status='failed'
     detail='Kaggle completed but expected PYVT_PREFLIGHT_OK not found; inspect private notebook logs'
    }
   }
   else if(state.includes('ERROR')||state.includes('FAIL')||state.includes('CANCEL')){status='failed';detail=String(response.failureMessage||state).slice(0,240)}
   await db.prepare("UPDATE pyvt_preflight SET status=?,detail=?,updated_at=unixepoch() WHERE id=1 AND status IN ('submitted','running')")
     .bind(status,detail).run()
  }catch(e){
    const reason=e instanceof Error?e.message.slice(0,160):'unknown'
    console.error('pyVideoTrans preflight poll failed',e instanceof Error?e.name:'unknown')
    let evidence=''
    if(reason.includes('HTTP 403')){
     try{
      const headers={Authorization:'Bearer '+env.KAGGLE_API_TOKEN,Accept:'application/json'}
      const requests=[
       'https://api.kaggle.com/v1/kernels/list?user='+OWNER+'&pageSize=80',
       'https://api.kaggle.com/v1/kernels/status?userName='+OWNER+'&kernelSlug=pyvideotrans-compatibility-check'
      ]
      const checked=await Promise.all(requests.map(async (url)=>{
       const r=await fetch(url,{headers,signal:AbortSignal.timeout(12000)})
       const body=await r.json().catch(()=>null) as unknown
       if(Array.isArray(body)){
        const matching=body.filter(item=>typeof item==='object'&&item!==null&&
         JSON.stringify(item).toLowerCase().includes('pyvideotrans')).slice(0,3)
        const safe=matching.map(item=>{
         const x=item as Record<string,unknown>
         return String(x.ref||x.slug||x.title||x.kernelRef||'unknown').slice(0,100)
        })
        return 'list '+r.status+' count='+body.length+' matching='+safe.join('|')
       }
       const data=body&&typeof body==='object'?body as Record<string,unknown>:{}
       const reasonText=String(data.message||data.error||'').replace(/[\\r\\n]/g,' ').slice(0,90)
       return (url.includes('/status?')?'status ':'list ')+r.status+' '+reasonText
      }))
      evidence=checked.join('; ')
     }catch {evidence='metadata probe unavailable'}
    }
    await db.prepare(
      "UPDATE pyvt_preflight SET detail=?,updated_at=unixepoch() WHERE id=1 AND status IN ('submitted','running')"
    ).bind(('Status API: '+reason+'; '+evidence).slice(0,460)).run()
   }
 }
}

export async function pollPyvt(env:VideoEnv):Promise<void>{
 if(!env.KAGGLE_API_TOKEN||!env.MEMORY_DB||!await isReady(env))return
 await init(env.MEMORY_DB)
 const active=await env.MEMORY_DB.prepare(
  "SELECT id,chat_id,file_id,file_ext,source_lang,target_lang,engine,voice,voice_slot,status,version_number,created_at,error_message "+
  "FROM pyvt_kaggle_jobs WHERE status IN ('submitting','submitted','running','delivering','submit-uncertain') ORDER BY id LIMIT 1"
 ).bind().all<Job>()
 const job=active.results[0]
 if(job){
  if(['submitting','delivering','submit-uncertain'].includes(job.status)||!job.version_number)return
  try{
   const result=await kaggle(env,'status',{userName:OWNER,kernelSlug:SLUG,versionLabel:'v'+job.version_number})
   const state=String(result.status||result.state||'').toUpperCase()
   if(state.includes('FAIL')||state.includes('ERROR')||state.includes('CANCEL')){
    await env.MEMORY_DB.prepare(
     "UPDATE pyvt_kaggle_jobs SET status='failed',error_message='Kaggle job failed',updated_at=unixepoch() WHERE id=?"
    ).bind(job.id).run()
    await reply(env,job.chat_id,'Video dub #'+job.id+' failed on Kaggle. Review notebook logs.').catch(()=>undefined)
    return
   }
   if(state.includes('COMPLETE')||state.includes('SUCCESS')){
    const files=await kaggle(env,'output',{userName:OWNER,kernelSlug:SLUG,versionLabel:'v'+job.version_number})
    const url=resultUrl(files)
    if(!url)return
    const claim=await env.MEMORY_DB.prepare(
     "UPDATE pyvt_kaggle_jobs SET status='delivering',updated_at=unixepoch() "+
     "WHERE id=? AND status IN ('submitted','running')"
    ).bind(job.id).run()
    if(claim.meta.changes!==1)return
    try{
     await sendVideo(env,job,url)
     await env.MEMORY_DB.prepare("UPDATE pyvt_kaggle_jobs SET status='done',updated_at=unixepoch() WHERE id=?").bind(job.id).run()
    }catch(e){
     console.error('pyVideoTrans delivery uncertain',e instanceof Error?e.name:'unknown')
     await env.MEMORY_DB.prepare(
      "UPDATE pyvt_kaggle_jobs SET status='delivery-uncertain',error_message='Video may be ready on Kaggle',updated_at=unixepoch() WHERE id=?"
     ).bind(job.id).run()
     await reply(env,job.chat_id,'Video dub #'+job.id+' finished, but Telegram delivery is uncertain. Check Kaggle '+KERNEL).catch(()=>undefined)
    }
    return
   }
   await env.MEMORY_DB.prepare(
    "UPDATE pyvt_kaggle_jobs SET status='running',updated_at=unixepoch() WHERE id=? AND status='submitted'"
   ).bind(job.id).run()
  }catch(e){console.error('pyVideoTrans status failure',e instanceof Error?e.name:'unknown')}
  return
 }
 const locked=await env.MEMORY_DB.prepare(
  "UPDATE pyvt_kaggle_jobs SET status='submitting',updated_at=unixepoch() WHERE id=("+
  "SELECT id FROM pyvt_kaggle_jobs WHERE status='queued' ORDER BY id LIMIT 1) "+
  "AND NOT EXISTS (SELECT 1 FROM pyvt_kaggle_jobs WHERE status IN "+
  "('submitting','submitted','running','delivering','submit-uncertain'))"
 ).bind().run()
 if(!locked.meta.changes)return
 const first=await env.MEMORY_DB.prepare(
  "SELECT id,chat_id,file_id,file_ext,source_lang,target_lang,engine,voice,voice_slot,status,version_number,created_at,error_message "+
  "FROM pyvt_kaggle_jobs WHERE status='submitting' ORDER BY id LIMIT 1"
 ).bind().all<Job>()
 const next=first.results[0]
 if(!next)return
 const expires=Math.floor(Date.now()/1000)+43200
 try{
  let voiceB64=''
  if(next.voice_slot){
   const sample=await env.MEMORY_DB.prepare('SELECT audio_b64 FROM vox_saved_voices WHERE chat_id=? AND slot=?')
    .bind(next.chat_id,next.voice_slot).all<{audio_b64:string}>()
   voiceB64=sample.results[0]?.audio_b64||''
   if(!voiceB64)throw Error('Saved voice slot unavailable')
  }
  const sign=await signature(env.TELEGRAM_WEBHOOK_SECRET,next.id,expires)
  const response=await kaggle(env,'push',{
   slug:KERNEL,newTitle:'pyvideotrans-telegram-dub',
   text:renderKernel(next,fileURL(next.id,expires,sign),voiceB64),
   language:'python',kernelType:'script',isPrivate:true,enableGpu:next.engine==='vox',
   enableInternet:true,machineShape:'NvidiaTeslaT4',sessionTimeoutSeconds:3600,
   datasetDataSources:[],competitionDataSources:[],kernelDataSources:[],modelDataSources:[]
  })
  const version=Number(response.versionNumber||response.version_number||0)
  if(!Number.isSafeInteger(version)||version<1)throw Error('Kaggle submission not confirmed')
  await env.MEMORY_DB.prepare(
   "UPDATE pyvt_kaggle_jobs SET status='submitted',version_number=?,updated_at=unixepoch() WHERE id=?"
  ).bind(version,next.id).run()
  await reply(env,next.chat_id,'Video dub #'+next.id+' submitted to Kaggle version '+version+' ('+next.engine+' TTS).').catch(()=>undefined)
 }catch(e){
  console.error('pyVideoTrans submission uncertain',e instanceof Error?e.name:'unknown')
  await env.MEMORY_DB.prepare(
    "UPDATE pyvt_kaggle_jobs SET status='submit-uncertain',error_message='Kaggle submission uncertain: no automatic retry',updated_at=unixepoch() WHERE id=?"
  ).bind(next.id).run()
  await reply(env,next.chat_id,'Video dubbing job submission was uncertain. No automatic retry; inspect private Kaggle run history.').catch(()=>undefined)
 }
}
