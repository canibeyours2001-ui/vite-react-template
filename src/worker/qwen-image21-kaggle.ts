/**
 * Research-only Qwen-Image-2.1 GGUF Q4_K_M + Viggle v0.3 six-step Kaggle backend.
 * Feature gated; no changes to existing image, voice, VSR or webhook routes.
 * Never auto-retries an uncertain Kaggle submit or Telegram delivery.
 */
type Db = {prepare(sql:string):{bind(...args:(string|number)[]):{
  run():Promise<{meta:{changes:number}}>;
  all<T>():Promise<{results:T[]}>
}}}
export type QwenEnv={
  MEMORY_DB:Db; KAGGLE_API_TOKEN?:string; TELEGRAM_BOT_TOKEN:string;
  QWEN_KAGGLE_ENABLED?:string;
}
type Job={
  id:number;chat_id:string;message_id:number;prompt:string;
  width:number;height:number;seed:number;status:string;version_number:number|null;
  created_at:number;error_message:string|null;
}
const OWNER='cyawzin'
const SLUG='qwen-image-2-1-uncensored-gguf-6-step-t4-research'
const KERNEL=OWNER+'/'+SLUG
const API='https://api.kaggle.com/v1/kernels/'
const SCRIPT_URL='https://raw.githubusercontent.com/canibeyours2001-ui/vite-react-template/4e40a3c/qwen-kaggle/generate.py'
const ACTIVE="('submitting','submitted','running','delivering','submit-uncertain','delivery-uncertain','needs-review')"
const HELP='🖼️ Qwen Image 2.1 Uncensored, GGUF Q4_K_M, Viggle Turbo 6-step (research-only).\n'+
  'Text-to-image: /qwenimage A cinematic mountain village at dawn\n'+
  'Optional: /qwenimage --size=768 A realistic red sports car\n'+
  'Status: /qwenimage_status. Supported sizes: 512, 768, 1024.\n'+
  'Kaggle starts a separate GPU job for each image; first run downloads large model files.\n'+
  'Qwen Research License prohibits commercial use without separate permission.'

async function schema(db:Db){
  await db.prepare('CREATE TABLE IF NOT EXISTS qwen_image21_jobs ('+
   'id INTEGER PRIMARY KEY AUTOINCREMENT,chat_id TEXT NOT NULL,message_id INTEGER NOT NULL,'+
   'prompt TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,seed INTEGER NOT NULL,'+
   "status TEXT NOT NULL DEFAULT 'queued',version_number INTEGER,error_message TEXT,"+
   'created_at INTEGER NOT NULL DEFAULT (unixepoch()),updated_at INTEGER NOT NULL DEFAULT (unixepoch()),'+
   'UNIQUE(chat_id,message_id))').bind().run()
}
async function tell(env:QwenEnv,chat:string,message:string){
  const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/sendMessage',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({chat_id:chat,text:message.slice(0,3900)}),
    signal:AbortSignal.timeout(15000)
  })
  if(!r.ok)throw Error('Telegram text HTTP '+r.status)
}
async function kaggle(env:QwenEnv,method:'push'|'status'|'output',data:Record<string,unknown>){
  if(!env.KAGGLE_API_TOKEN)throw Error('Kaggle API token is not configured')
  const u=new URL(API+method)
  if(method!=='push'){
    for(const key of ['userName','kernelSlug','versionLabel']){
      if(typeof data[key]==='string')u.searchParams.set(key,data[key] as string)
    }
  }
  const r=await fetch(u,{
    method:method==='push'?'POST':'GET',
    headers:{Authorization:'Bearer '+env.KAGGLE_API_TOKEN,Accept:'application/json',
      ...(method==='push'?{'Content-Type':'application/json'}:{})},
    ...(method==='push'?{body:JSON.stringify(data)}:{}),
    signal:AbortSignal.timeout(method==='push'?55000:20000)
  })
  const v=await r.json().catch(()=>({})) as Record<string,unknown>
  if(!r.ok||v.error)throw Error('Kaggle '+method+' HTTP '+r.status)
  return v
}
function source(task:Job){
  const payload={prompt:task.prompt,width:task.width,height:task.height,seed:task.seed}
  // JSON-encoded string literal is also valid as a Python string. No user input is evaluated.
  const literal=JSON.stringify(JSON.stringify(payload))
  return 'import os, pathlib, urllib.request\n'+
    'os.environ["QWEN_TASK_JSON"] = '+literal+'\n'+
    'source = '+JSON.stringify(SCRIPT_URL)+'\n'+
    'path = pathlib.Path("/kaggle/working/qwen_generate.py")\n'+
    'urllib.request.urlretrieve(source, path)\n'+
    'exec(compile(path.read_bytes(), str(path), "exec"), {"__name__":"__main__"})\n'
}
function outputUrl(data:Record<string,unknown>):string|null{
  const files=data.files||data.outputFiles
  if(!Array.isArray(files))return null
  for(const item of files){
    if(!item||typeof item!=='object')continue
    const f=item as Record<string,unknown>
    if(String(f.fileName||f.file_name)!=='qwen_image21_result.png'||typeof f.url!=='string')continue
    try{
      const u=new URL(f.url)
      const h=u.hostname.toLowerCase()
      if(u.protocol==='https:'&&(h==='storage.googleapis.com'||h==='api.kaggle.com'||
        h==='www.kaggle.com'||h.endsWith('.kaggleusercontent.com')||
        h.endsWith('.googleapis.com')))return u.toString()
    }catch{/* ignore invalid URL */}
  }
  return null
}
async function deliver(env:QwenEnv,job:Job,url:string){
  const r=await fetch(url,{redirect:'follow',signal:AbortSignal.timeout(65000)})
  if(!r.ok||Number(r.headers.get('content-length')||0)>25*1024*1024){
    await r.body?.cancel()
    throw Error('Kaggle PNG download failed or exceeded 25 MiB')
  }
  const data=new Uint8Array(await r.arrayBuffer())
  const png=[137,80,78,71,13,10,26,10]
  if(data.length<4096||data.length>25*1024*1024||png.some((byte,i)=>data[i]!==byte)){
    throw Error('Output is not a valid PNG')
  }
  const form=new FormData()
  form.set('chat_id',job.chat_id)
  form.set('caption','✅ Qwen Image 2.1 research render #'+job.id+
    ' • '+job.width+'×'+job.height+' • Q4_K_M • Viggle 6 steps • seed '+job.seed)
  form.set('document',new Blob([data],{type:'image/png'}),'qwen-image21-'+job.id+'.png')
  const sent=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/sendDocument',{
    method:'POST',body:form,signal:AbortSignal.timeout(65000)
  })
  const receipt=await sent.json().catch(()=>({})) as {ok?:boolean}
  if(!sent.ok||receipt.ok!==true)throw Error('Telegram PNG delivery unconfirmed')
}
export async function qwenImageCommand(env:QwenEnv,chat:string,messageId:number,text:string,
 send:(message:string)=>Promise<unknown>):Promise<boolean>{
  const m=text.match(/^\/(qwenimage|qwenimage_status|qwenimage_help)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i)
  if(!m)return false
  await schema(env.MEMORY_DB)
  const command=m[1].toLowerCase()
  if(command==='qwenimage_help'){
    await send(HELP+'\nGPU submission: '+(env.QWEN_KAGGLE_ENABLED==='1'?'ENABLED':'DISABLED until testing passes'))
    return true
  }
  if(command==='qwenimage_status'){
    const rows=await env.MEMORY_DB.prepare(
      'SELECT id,status,width,height,version_number,error_message FROM qwen_image21_jobs '+
      'WHERE chat_id=? ORDER BY id DESC LIMIT 1'
    ).bind(chat).all<{id:number;status:string;width:number;height:number;version_number:number|null;error_message:string|null}>()
    const j=rows.results[0]
    await send(j?'🖼️ Qwen #'+j.id+': '+j.status+' • '+j.width+'×'+j.height+
      (j.version_number?' • Kaggle v'+j.version_number:'')+
      (j.error_message?'\n'+j.error_message.slice(0,150):''):'No Qwen research jobs yet.\n'+HELP)
    return true
  }
  let prompt=(m[2]||'').trim()
  let dim=1024
  const opt=prompt.match(/^--size=(512|768|1024)\s+/)
  if(opt){dim=Number(opt[1]);prompt=prompt.slice(opt[0].length).trim()}
  if(prompt.length<3||prompt.length>1400){
    await send('Provide an image prompt between 3 and 1400 characters.\n'+HELP)
    return true
  }
  if(env.QWEN_KAGGLE_ENABLED!=='1'){
    await send('🧪 Qwen Kaggle backend is staged but GPU submissions are locked until a real T4 test succeeds. /qwenimage_help')
    return true
  }
  if(!env.KAGGLE_API_TOKEN){
    await send('Kaggle API credential is missing from the Worker.')
    return true
  }
  const busy=await env.MEMORY_DB.prepare(
    'SELECT id FROM qwen_image21_jobs WHERE chat_id=? AND status IN '+ACTIVE+' LIMIT 1'
  ).bind(chat).all<{id:number}>()
  if(busy.results.length){
    await send('You already have an active Qwen job. Use /qwenimage_status.')
    return true
  }
  const seed=crypto.getRandomValues(new Uint32Array(1))[0]
  await env.MEMORY_DB.prepare(
    'INSERT OR IGNORE INTO qwen_image21_jobs(chat_id,message_id,prompt,width,height,seed) VALUES(?,?,?,?,?,?)'
  ).bind(chat,messageId,prompt,dim,dim,seed).run()
  const row=await env.MEMORY_DB.prepare(
    'SELECT id FROM qwen_image21_jobs WHERE chat_id=? AND message_id=?'
  ).bind(chat,messageId).all<{id:number}>()
  await send('✅ Research image #'+(row.results[0]?.id||'?')+' queued on Kaggle. /qwenimage_status')
  return true
}
export async function pollQwenImage21(env:QwenEnv):Promise<void>{
  if(env.QWEN_KAGGLE_ENABLED!=='1'||!env.KAGGLE_API_TOKEN||!env.MEMORY_DB)return
  await schema(env.MEMORY_DB)
  const db=env.MEMORY_DB
  const rows=await db.prepare('SELECT id,chat_id,message_id,prompt,width,height,seed,status,'+
    'version_number,created_at,error_message FROM qwen_image21_jobs WHERE status IN '+
    ACTIVE+' ORDER BY id ASC LIMIT 1').bind().all<Job>()
  const job=rows.results[0]
  if(job){
    if(!['submitted','running'].includes(job.status)||!job.version_number)return
    try{
      const result=await kaggle(env,'status',{
        userName:OWNER,kernelSlug:SLUG,versionLabel:'v'+job.version_number
      })
      const status=String(result.status||result.state||'').toUpperCase()
      if(/ERROR|FAIL|CANCEL/.test(status)){
        await db.prepare("UPDATE qwen_image21_jobs SET status='failed',error_message=?,"+
          'updated_at=unixepoch() WHERE id=?').bind('Kaggle job failed: '+status,job.id).run()
        await tell(env,job.chat_id,'❌ Qwen image #'+job.id+' failed. Check private Kaggle notebook logs.').catch(()=>{})
        return
      }
      if(/COMPLETE|SUCCESS/.test(status)){
        const files=await kaggle(env,'output',{
          userName:OWNER,kernelSlug:SLUG,versionLabel:'v'+job.version_number
        })
        const url=outputUrl(files)
        if(!url)return
        const claim=await db.prepare("UPDATE qwen_image21_jobs SET status='delivering',"+
          'updated_at=unixepoch() WHERE id=? AND status IN (\'submitted\',\'running\')'
        ).bind(job.id).run()
        if(claim.meta.changes!==1)return
        try{
          await deliver(env,job,url)
          await db.prepare("UPDATE qwen_image21_jobs SET status='done',updated_at=unixepoch() WHERE id=?").bind(job.id).run()
        }catch(e){
          const reason=String(e instanceof Error?e.message:e).slice(0,150)
          await db.prepare("UPDATE qwen_image21_jobs SET status='delivery-uncertain',error_message=?,updated_at=unixepoch() WHERE id=?")
            .bind(reason,job.id).run()
          await tell(env,job.chat_id,'⚠️ Qwen image generated but Telegram delivery was not confirmed. /qwenimage_status').catch(()=>{})
        }
        return
      }
      if(Math.floor(Date.now()/1000)-job.created_at>14400){
        await db.prepare("UPDATE qwen_image21_jobs SET status='needs-review',error_message='Kaggle still running after 4 hours; manual review required',updated_at=unixepoch() WHERE id=?")
          .bind(job.id).run()
      }else{
        await db.prepare("UPDATE qwen_image21_jobs SET status='running',updated_at=unixepoch() WHERE id=? AND status='submitted'")
          .bind(job.id).run()
      }
    }catch(e){
      console.error('Qwen Kaggle poll error',e instanceof Error?e.name:'unknown')
    }
    return
  }
  // Respect other Kaggle jobs already in this bot.
  for(const sql of [
    "SELECT id FROM pyvt_kaggle_jobs WHERE status IN ('submitting','submitted','running','delivering') LIMIT 1",
    "SELECT id FROM vox_kaggle_jobs WHERE status IN ('submitting','submitted','running','delivering') LIMIT 1",
    "SELECT id FROM seedvr2_jobs WHERE status IN ('submitting','submitted','running','delivering') LIMIT 1"
  ]){
    const other=await db.prepare(sql).bind().all<{id:number}>().catch(()=>({results:[]}))
    if(other.results.length)return
  }
  const claimed=await db.prepare("UPDATE qwen_image21_jobs SET status='submitting',updated_at=unixepoch() WHERE id=("+
    "SELECT id FROM qwen_image21_jobs WHERE status='queued' ORDER BY id LIMIT 1)"+
    " AND NOT EXISTS (SELECT 1 FROM qwen_image21_jobs WHERE status IN "+ACTIVE+")").bind().run()
  if(claimed.meta.changes!==1)return
  const next=(await db.prepare('SELECT id,chat_id,message_id,prompt,width,height,seed,status,version_number,created_at,error_message '+
    "FROM qwen_image21_jobs WHERE status='submitting' ORDER BY id ASC LIMIT 1").bind().all<Job>()).results[0]
  if(!next)return
  try{
    const result=await kaggle(env,'push',{
      slug:KERNEL,newTitle:'Qwen Image 2.1 Uncensored GGUF 6-Step T4 Research',
      text:source(next),language:'python',kernelType:'script',isPrivate:true,
      enableGpu:true,enableInternet:true,machineShape:'NvidiaTeslaT4',
      sessionTimeoutSeconds:14400,datasetDataSources:[],competitionDataSources:[],
      kernelDataSources:[],modelDataSources:[]
    })
    const version=Number(result.versionNumber||result.version_number||0)
    if(!Number.isSafeInteger(version)||version<1)throw Error('Kaggle push response had no valid version')
    await db.prepare("UPDATE qwen_image21_jobs SET status='submitted',version_number=?,updated_at=unixepoch() WHERE id=? AND status='submitting'")
      .bind(version,next.id).run()
    await tell(env,next.chat_id,'🚀 Qwen image #'+next.id+' submitted to Kaggle v'+version+'. /qwenimage_status').catch(()=>{})
  }catch(e){
    const message=String(e instanceof Error?e.message:e).slice(0,160)
    await db.prepare("UPDATE qwen_image21_jobs SET status='submit-uncertain',error_message=?,updated_at=unixepoch() WHERE id=? AND status='submitting'")
      .bind(message,next.id).run()
    await tell(env,next.chat_id,'⚠️ Kaggle submission not confirmed for Qwen #'+next.id+'. No automatic retry.').catch(()=>{})
  }
}
