/**
 * Private, feature-gated SeedVR2 Kaggle batch processor for CYAW AI Studio.
 * Never changes the existing /upscale (image), /dub, or /vox pipelines.
 * Run one Kaggle VSR job at a time; never automatically resubmit uncertain jobs.
 */
type DB = { prepare(sql: string): { bind(...v: (string | number)[]): {
  run(): Promise<{meta:{changes:number}}>; all<T>(): Promise<{results:T[]}>
}}}
export type VsrEnv = {
  MEMORY_DB: DB; TELEGRAM_BOT_TOKEN: string; TELEGRAM_WEBHOOK_SECRET: string;
  KAGGLE_API_TOKEN?: string;
}
type Media = {file_id:string;file_size?:number;file_name?:string;mime_type?:string}
type Msg = {message_id:number;document?:Media;video?:Media;reply_to_message?:{document?:Media;video?:Media}}
type Job = {
  id:number;chat_id:string;file_id:string;file_size:number;resolution:number;
  status:string;version_number:number|null;created_at:number;error_message:string|null
}
const OWNER = 'cyawzin'
const SLUG = 'seedvr2-telegram-video-upscaler'
const KERNEL = OWNER+'/'+SLUG
const BASE = 'https://api.kaggle.com/v1/kernels/'
const MAX_INPUT = 20*1024*1024
const MAX_OUTPUT = 49*1024*1024
const ACTIVE = "('submitting','submitted','running','delivering','submit-uncertain','delivery-uncertain','needs-review')"
const HELP = '🎬 SeedVR2 3B FP16 on Kaggle GPU\n' +
  'Reply to an MP4 with /vsr (1080p), or attach a video and caption /vsr 1080.\n' +
  'For a lighter test use /vsr 720. Check /vsr_status.\n' +
  'Beta: <=20 MiB input, <=10 seconds, <=720p short edge, <=30 FPS.\n' +
  'GPU jobs use free Kaggle quota when enabled. Results over Telegram 49 MiB ' +
  'remain available from the private Kaggle notebook output instead.\n' +
  'For the first test, use a 1–2 second MP4; larger clips can take much longer.'

async function schema(db:DB){
  await db.prepare('CREATE TABLE IF NOT EXISTS seedvr2_config ('+
    'id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)))').bind().run()
  await db.prepare('CREATE TABLE IF NOT EXISTS seedvr2_jobs ('+
    'id INTEGER PRIMARY KEY AUTOINCREMENT,chat_id TEXT NOT NULL,message_id INTEGER NOT NULL,'+
    'file_id TEXT NOT NULL,file_size INTEGER NOT NULL,resolution INTEGER NOT NULL,'+
    "status TEXT NOT NULL DEFAULT 'queued',version_number INTEGER,error_message TEXT,"+
    'created_at INTEGER NOT NULL DEFAULT (unixepoch()),updated_at INTEGER NOT NULL DEFAULT (unixepoch()),'+
    'UNIQUE(chat_id,message_id))').bind().run()
}
async function enabled(env:VsrEnv){
  await schema(env.MEMORY_DB)
  const rows=await env.MEMORY_DB.prepare('SELECT enabled FROM seedvr2_config WHERE id=1')
    .bind().all<{enabled:number}>()
  return rows.results[0]?.enabled===1
}
async function tell(env:VsrEnv,chat:string,message:string){
  const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/sendMessage',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({chat_id:chat,text:message.slice(0,3900)}),
    signal:AbortSignal.timeout(15000)
  })
  if(!r.ok)throw Error('Telegram sendMessage HTTP '+r.status)
}
async function kaggle(env:VsrEnv,method:'push'|'status'|'output',data:Record<string,unknown>){
  if(!env.KAGGLE_API_TOKEN)throw Error('Kaggle token missing')
  const url=new URL(BASE+method)
  if(method!=='push')for(const key of ['userName','kernelSlug','versionLabel']){
    if(typeof data[key]==='string')url.searchParams.set(key,data[key] as string)
  }
  const r=await fetch(url,{
    method:method==='push'?'POST':'GET',
    headers:{Authorization:'Bearer '+env.KAGGLE_API_TOKEN,Accept:'application/json',
      ...(method==='push'?{'content-type':'application/json'}:{})},
    ...(method==='push'?{body:JSON.stringify(data)}:{}),
    signal:AbortSignal.timeout(method==='push'?55000:20000)
  })
  const out=await r.json().catch(()=>({})) as Record<string,unknown>
  if(!r.ok||out.error)throw Error('Kaggle '+method+' HTTP '+r.status)
  return out
}
function equal(a:string,b:string){
  if(a.length!==b.length)return false
  let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i)
  return d===0
}
async function signature(secret:string,id:number,expire:number){
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),
    {name:'HMAC',hash:'SHA-256'},false,['sign'])
  const bytes=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('seedvr2-file:'+id+':'+expire))
  return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('')
}
function signedUrl(id:number,expire:number,sig:string){
  return 'https://vite-react-template.canibeyours2001.workers.dev/telegram/webhook?vsrfile='+
    id+'&expire='+expire+'&sig='+sig
}
export async function vsrSignedFile(env:VsrEnv,request:Request):Promise<Response>{
  const u=new URL(request.url)
  const id=Number(u.searchParams.get('vsrfile')),expire=Number(u.searchParams.get('expire'))
  const sig=u.searchParams.get('sig')||'',now=Math.floor(Date.now()/1000)
  if(!Number.isSafeInteger(id)||id<=0||!Number.isSafeInteger(expire)||
     expire<now||expire>now+43200||!/^[0-9a-f]{64}$/.test(sig)||
     !env.TELEGRAM_WEBHOOK_SECRET||!equal(sig,await signature(env.TELEGRAM_WEBHOOK_SECRET,id,expire)))
    return new Response('Not found',{status:404})
  await schema(env.MEMORY_DB)
  const rows=await env.MEMORY_DB.prepare(
    "SELECT file_id,file_size FROM seedvr2_jobs WHERE id=? AND status IN ('submitting','submitted','running')"
  ).bind(id).all<{file_id:string;file_size:number}>()
  const job=rows.results[0]
  if(!job||job.file_size>MAX_INPUT)return new Response('Not found',{status:404})
  const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+
    '/getFile?file_id='+encodeURIComponent(job.file_id),{signal:AbortSignal.timeout(16000)})
  const file=await r.json().catch(()=>({})) as {ok?:boolean;result?:{file_path?:string;file_size?:number}}
  const path=file.result?.file_path||''
  if(!r.ok||!file.ok||!path||path.includes('..')||path.startsWith('/')||
     (file.result?.file_size||0)>MAX_INPUT)
    return new Response('File unavailable',{status:404})
  const video=await fetch('https://api.telegram.org/file/bot'+env.TELEGRAM_BOT_TOKEN+'/'+
    path.split('/').map(encodeURIComponent).join('/'),{signal:AbortSignal.timeout(60000)})
  if(!video.ok||Number(video.headers.get('content-length')||0)>MAX_INPUT){
    await video.body?.cancel()
    return new Response('Media unavailable',{status:502})
  }
  return new Response(video.body,{headers:{
    'content-type':'video/mp4','cache-control':'private, no-store',
    'x-content-type-options':'nosniff'
  }})
}
export async function vsrCommand(env:VsrEnv,msg:Msg,chat:string,text:string,
  send:(message:string)=>Promise<unknown>):Promise<boolean>{
  const m=text.match(/^\/(vsr|vsr_status|vsr_help)(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?\s*$/i)
  if(!m)return false
  const command=m[1].toLowerCase()
  if(command==='vsr_help'){await send(HELP+'\nGPU submission: '+(await enabled(env)?'ENABLED ✅':'DISABLED pending validation'));return true}
  await schema(env.MEMORY_DB)
  if(command==='vsr_status'){
    const rows=await env.MEMORY_DB.prepare(
      'SELECT id,status,resolution,version_number,error_message FROM seedvr2_jobs WHERE chat_id=? ORDER BY id DESC LIMIT 1'
    ).bind(chat).all<{id:number;status:string;resolution:number;version_number:number|null;error_message:string|null}>()
    const j=rows.results[0]
    await send(j?'🎬 SeedVR2 #'+j.id+': '+j.status+' | '+j.resolution+'p'+
      (j.version_number?' | Kaggle v'+j.version_number:'')+
      (j.error_message?'\n'+j.error_message.slice(0,180):''):'No SeedVR2 jobs yet. '+HELP)
    return true
  }
  const resolution=m[2]?Number(m[2]):1080
  if(![720,1080].includes(resolution)){await send('Choose /vsr 720 or /vsr 1080.');return true}
  const media=msg.video||msg.document||msg.reply_to_message?.video||msg.reply_to_message?.document
  if(!media){await send(HELP+'\nGPU submission: '+(await enabled(env)?'ENABLED ✅':'DISABLED pending validation'));return true}
  if(!await enabled(env)){
    await send('SeedVR2 is staged but GPU submissions are disabled until the Kaggle end-to-end test passes. /vsr_help')
    return true
  }
  if(!env.KAGGLE_API_TOKEN){await send('Kaggle integration is not configured.');return true}
  const name=String(media.file_name||'video.mp4').toLowerCase()
  const type=String(media.mime_type||'')
  if((media===msg.document||media===msg.reply_to_message?.document)&&!/\.(mp4|mov|webm)$/i.test(name)&&
     !['video/mp4','video/quicktime','video/webm'].includes(type)){
    await send('Send MP4, MOV or WebM video.');return true
  }
  const bytes=Number(media.file_size||0)
  if(!Number.isSafeInteger(bytes)||bytes<4096||bytes>MAX_INPUT){
    await send('Send a short video between 4 KiB and 20 MiB.');return true
  }
  const busy=await env.MEMORY_DB.prepare(
    "SELECT id FROM seedvr2_jobs WHERE chat_id=? AND status IN "+ACTIVE+" LIMIT 1"
  ).bind(chat).all<{id:number}>()
  if(busy.results.length){await send('You already have an active VSR job. /vsr_status');return true}
  await env.MEMORY_DB.prepare(
    'INSERT OR IGNORE INTO seedvr2_jobs(chat_id,message_id,file_id,file_size,resolution) VALUES(?,?,?,?,?)'
  ).bind(chat,msg.message_id,media.file_id,bytes,resolution).run()
  const rows=await env.MEMORY_DB.prepare(
    'SELECT id FROM seedvr2_jobs WHERE chat_id=? AND message_id=?'
  ).bind(chat,msg.message_id).all<{id:number}>()
  await send('✅ SeedVR2 #'+(rows.results[0]?.id||'?')+' queued for Kaggle T4 (target '+resolution+'p). /vsr_status')
  return true
}
function renderKernel(mediaUrl:string,target:number){
  // Both values are fixed server-side, not editable instructions from Telegram.
  return KERNEL_SCRIPT.replace('__TASK_JSON__',JSON.stringify({url:mediaUrl,resolution:target})
    .replace(/\\/g,'\\\\').replace(/'/g,"\\'"))
}
function outputUrl(data:Record<string,unknown>):string|null{
  const files=data.files||data.outputFiles
  if(!Array.isArray(files))return null
  for(const item of files){
    if(!item||typeof item!=='object')continue
    const f=item as Record<string,unknown>
    if(String(f.fileName||f.file_name)!=='seedvr2_result.mp4'||typeof f.url!=='string')continue
    try{
      const u=new URL(f.url)
      if(u.protocol!=='https:')continue
      if(u.hostname==='storage.googleapis.com'||u.hostname==='api.kaggle.com'||
         u.hostname==='www.kaggle.com'||u.hostname.endsWith('.kaggleusercontent.com')||
         u.hostname.endsWith('.googleapis.com'))return u.toString()
    }catch{/* malformed URL */}
  }
  return null
}
async function deliver(env:VsrEnv,job:Job,url:string){
  const r=await fetch(url,{signal:AbortSignal.timeout(65000)})
  if(!r.ok||Number(r.headers.get('content-length')||0)>MAX_OUTPUT){
    await r.body?.cancel();throw Error('Kaggle output inaccessible or over Telegram limit')
  }
  const blob=await r.blob()
  if(blob.size<4096||blob.size>MAX_OUTPUT)throw Error('Output missing or exceeds 49 MiB')
  const form=new FormData()
  form.set('chat_id',job.chat_id)
  form.set('caption','✅ SeedVR2 video #'+job.id+' (Kaggle T4, '+job.resolution+'p)')
  form.set('video',blob,'seedvr2-'+job.id+'.mp4')
  const sent=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/sendVideo',{
    method:'POST',body:form,signal:AbortSignal.timeout(65000)
  })
  const data=await sent.json().catch(()=>({})) as {ok?:boolean}
  if(!sent.ok||!data.ok)throw Error('Telegram video delivery not confirmed')
}
export async function pollSeedVsr(env:VsrEnv):Promise<void>{
  if(!env.MEMORY_DB||!env.KAGGLE_API_TOKEN||!env.TELEGRAM_WEBHOOK_SECRET||
     !await enabled(env))return
  const db=env.MEMORY_DB
  const rows=await db.prepare(
    "SELECT id,chat_id,file_id,file_size,resolution,status,version_number,created_at,error_message FROM seedvr2_jobs "+
    "WHERE status IN "+ACTIVE+" ORDER BY id ASC LIMIT 1"
  ).bind().all<Job>()
  const job=rows.results[0]
  if(job){
    if(job.status!=='submitted'&&job.status!=='running')return // no ambiguous retry
    if(!job.version_number)return
    try{
      const status=await kaggle(env,'status',{
        userName:OWNER,kernelSlug:SLUG,versionLabel:'v'+job.version_number
      })
      const state=String(status.status||status.state||'').toUpperCase()
      if(/FAIL|ERROR|CANCEL/.test(state)){
        await db.prepare("UPDATE seedvr2_jobs SET status='failed',error_message=?,updated_at=unixepoch() WHERE id=?")
          .bind('Kaggle v'+job.version_number+' failed: '+state,job.id).run()
        await tell(env,job.chat_id,'❌ SeedVR2 #'+job.id+' failed. Check '+KERNEL+' Kaggle notebook logs.').catch(()=>{})
        return
      }
      if(/COMPLETE|SUCCESS/.test(state)){
        const output=await kaggle(env,'output',{
          userName:OWNER,kernelSlug:SLUG,versionLabel:'v'+job.version_number
        })
        const url=outputUrl(output)
        if(!url)return
        const claim=await db.prepare(
          "UPDATE seedvr2_jobs SET status='delivering',updated_at=unixepoch() WHERE id=? AND status IN ('submitted','running')"
        ).bind(job.id).run()
        if(claim.meta.changes!==1)return
        try{
          await deliver(env,job,url)
          await db.prepare("UPDATE seedvr2_jobs SET status='done',updated_at=unixepoch() WHERE id=?")
            .bind(job.id).run()
        }catch(e){
          await db.prepare("UPDATE seedvr2_jobs SET status='delivery-uncertain',error_message=?,updated_at=unixepoch() WHERE id=?")
            .bind(String(e instanceof Error?e.message:e).slice(0,180),job.id).run()
          await tell(env,job.chat_id,'⚠️ SeedVR2 #'+job.id+' completed, but Telegram delivery is unconfirmed. Retrieve output from '+KERNEL+' on Kaggle.').catch(()=>{})
        }
        return
      }
      await db.prepare("UPDATE seedvr2_jobs SET status='running',updated_at=unixepoch() WHERE id=? AND status='submitted'")
        .bind(job.id).run()
    }catch(e){
      console.error('SeedVR2 poll failed',e instanceof Error?e.name:'unknown')
      if(Math.floor(Date.now()/1000)-job.created_at>7200){
        await db.prepare("UPDATE seedvr2_jobs SET status='needs-review',error_message='Kaggle status unavailable after 2 hours; no automatic retry' WHERE id=? AND status IN ('submitted','running')")
          .bind(job.id).run()
      }
    }
    return
  }
  // Avoid simultaneous free GPU consumption with other bot Kaggle video/voice jobs.
  for(const sql of [
    "SELECT id FROM pyvt_kaggle_jobs WHERE status IN ('submitting','submitted','running','delivering') LIMIT 1",
    "SELECT id FROM vox_kaggle_jobs WHERE status IN ('submitting','submitted','running','delivering') LIMIT 1"
  ]){
    const other=await db.prepare(sql).bind().all<{id:number}>().catch(()=>({results:[]}))
    if(other.results.length)return
  }
  const claim=await db.prepare(
    "UPDATE seedvr2_jobs SET status='submitting',updated_at=unixepoch() WHERE id=("+
    "SELECT id FROM seedvr2_jobs WHERE status='queued' ORDER BY id LIMIT 1) "+
    "AND NOT EXISTS (SELECT 1 FROM seedvr2_jobs WHERE status IN "+ACTIVE+")"
  ).bind().run()
  if(claim.meta.changes!==1)return
  const next=(await db.prepare(
    "SELECT id,chat_id,file_id,file_size,resolution,status,version_number,created_at,error_message "+
    "FROM seedvr2_jobs WHERE status='submitting' ORDER BY id LIMIT 1"
  ).bind().all<Job>()).results[0]
  if(!next)return
  const expire=Math.floor(Date.now()/1000)+43200
  try{
    const url=signedUrl(next.id,expire,await signature(env.TELEGRAM_WEBHOOK_SECRET,next.id,expire))
    const response=await kaggle(env,'push',{
      slug:KERNEL,newTitle:'SeedVR2 Telegram Video Upscaler',
      text:renderKernel(url,next.resolution),
      language:'python',kernelType:'script',isPrivate:true,enableGpu:true,
      enableInternet:true,machineShape:'NvidiaTeslaT4',sessionTimeoutSeconds:3600,
      datasetDataSources:[],competitionDataSources:[],kernelDataSources:[],modelDataSources:[]
    })
    const version=Number(response.versionNumber||response.version_number||0)
    if(!Number.isSafeInteger(version)||version<1)
      throw Error('Kaggle submission response has no version; do not retry automatically')
    await db.prepare("UPDATE seedvr2_jobs SET status='submitted',version_number=?,updated_at=unixepoch() WHERE id=? AND status='submitting'")
      .bind(version,next.id).run()
    await tell(env,next.chat_id,'🚀 SeedVR2 #'+next.id+' submitted to Kaggle v'+version+'. /vsr_status').catch(()=>{})
  }catch(e){
    const reason=String(e instanceof Error?e.message:e).slice(0,200)
    await db.prepare("UPDATE seedvr2_jobs SET status='submit-uncertain',error_message=?,updated_at=unixepoch() WHERE id=? AND status='submitting'")
      .bind(reason,next.id).run()
    await tell(env,next.chat_id,'⚠️ SeedVR2 #'+next.id+' submission unconfirmed. No automatic retry. '+reason).catch(()=>{})
  }
}

const KERNEL_SCRIPT = "import json, os, pathlib, subprocess, sys, time\nimport requests\n\nTASK = json.loads('__TASK_JSON__')\nROOT = pathlib.Path('/kaggle/working')\nROOT.mkdir(parents=True, exist_ok=True)\nINPUT = ROOT / 'vsr_input.mp4'\nOUTPUT = ROOT / 'seedvr2_result.mp4'\ndef run(args, timeout=1200, **kwargs):\n    print('VSR_RUN', args[0], flush=True)\n    return subprocess.run(args, check=True, timeout=timeout, **kwargs)\n\ndef probe(path):\n    data = json.loads(subprocess.check_output([\n        'ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)\n    ], timeout=30))\n    video = next((s for s in data.get('streams', []) if s.get('codec_type') == 'video'), None)\n    if video is None:\n        raise ValueError('No video stream')\n    width, height = int(video.get('width', 0)), int(video.get('height', 0))\n    num, _, den = str(video.get('avg_frame_rate', '0/1')).partition('/')\n    fps = float(num) / max(1, float(den or 1))\n    duration = float(data.get('format', {}).get('duration', 0))\n    return width, height, fps, duration\n\ndef main():\n    if not subprocess.run(['nvidia-smi'], capture_output=True, timeout=15).returncode == 0:\n        raise RuntimeError('Kaggle GPU not available')\n    address = TASK['url']\n    if not address.startswith('https://vite-react-template.canibeyours2001.workers.dev/telegram/webhook?vsrfile='):\n        raise ValueError('Unexpected media URL')\n    response = requests.get(address, stream=True, timeout=(15, 60), allow_redirects=False)\n    response.raise_for_status()\n    if response.is_redirect:\n        raise ValueError('Unexpected redirect')\n    count = 0\n    with INPUT.open('wb') as out:\n        for part in response.iter_content(1024 * 256):\n            count += len(part)\n            if count > 20 * 1024 * 1024:\n                raise ValueError('Input exceeds 20 MiB')\n            out.write(part)\n    if count < 4096:\n        raise ValueError('Input too small')\n    w, h, fps, seconds = probe(INPUT)\n    print('VSR_INPUT', w, h, fps, seconds, count, flush=True)\n    if min(w, h) < 100 or min(w, h) > 720 or max(w, h) > 1920 or not 0.2 < seconds <= 10 or not 1 <= fps <= 30.5:\n        raise ValueError('Use a 0.2-10s video, max 720p short edge, <=30 FPS')\n    target = int(TASK['resolution'])\n    if target not in (720, 1080):\n        raise ValueError('Invalid target resolution')\n    repo = ROOT / 'seedvr2-cli'\n    run(['git', 'clone', '--quiet', '--depth', '1', 'https://github.com/delvilo/SeedVR2-CLI.git', str(repo)], timeout=240)\n    pin = 'c7086f2de4144789b568ec94605c27b59c5f28e1'\n    run(['git', '-C', str(repo), 'fetch', '--quiet', '--depth', '1', 'origin', pin], timeout=240)\n    run(['git', '-C', str(repo), 'checkout', '--quiet', '--detach', pin], timeout=80)\n    run([sys.executable, '-m', 'pip', 'install', '-q', '-r', str(repo / 'requirements.txt')], timeout=1000)\n    import torch\n    if not torch.cuda.is_available():\n        raise RuntimeError('PyTorch cannot access Kaggle GPU')\n    print('VSR_CUDA', torch.cuda.get_device_name(0), flush=True)\n    models = pathlib.Path('/kaggle/temp/seedvr2_models')\n    # An optional pre-mounted private dataset can avoid re-downloading models.\n    cached = pathlib.Path('/kaggle/input/seedvr2-model-cache')\n    if cached.exists():\n        models = cached\n    command = [\n      sys.executable, str(repo / 'inference_cli.py'), str(INPUT),\n      '--dit_model', 'seedvr2_ema_3b_fp16.safetensors',\n      '--resolution', str(target),\n      '--batch_size', '5',\n      '--chunk_size', '33',\n      '--temporal_overlap', '3',\n      '--attention_mode', 'sdpa',\n      '--memory_policy', 'staged',\n      '--video_backend', 'ffmpeg',\n      '--model_dir', str(models),\n      '--output', str(OUTPUT),\n    ]\n    run(command, timeout=2900, cwd=str(repo))\n    if not OUTPUT.is_file() or OUTPUT.stat().st_size < 4096:\n        raise RuntimeError('SeedVR2 did not produce a valid MP4')\n    width, height, outfps, outseconds = probe(OUTPUT)\n    if min(width,height) < target * 0.95 or abs(outseconds - seconds) > 1.2:\n        raise RuntimeError('Upscaled output did not pass resolution/duration checks')\n    print('VSR_COMPLETE', OUTPUT.stat().st_size, width, height, outfps, flush=True)\n\nif __name__ == '__main__':\n    main()\n";