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
const SCRIPT_URL='https://raw.githubusercontent.com/canibeyours2001-ui/vite-react-template/7c568fd36c788dfa99f753017163ba9f34380c06/qwen-kaggle/generate.py'
const BATCH_PREFIX='__QWEN_IMAGE21_BATCH_V1__:'
const ACTIVE="('submitting','submitted','kaggle-queued','running','delivering','submit-uncertain','needs-review')"
const BLOCKING="('queued','submitting','submitted','kaggle-queued','running','delivering','submit-uncertain','needs-review','delivery-uncertain')"
const HELP='🖼️ Qwen Image 2.1 Uncensored, GGUF Q4_K_M, Viggle Turbo 6-step (research-only).\n'+
  'Text-to-image: /qwenimage A cinematic mountain village at dawn\n'+
  'Optional: /qwenimage --size=768 A realistic red sports car\n'+
  'Batch: /qwenbatch --size=1024 followed by 2–4 prompts, one per line.\n'+
  'Status: /qwenimage_status or /qwenbatch_status. Supported sizes: 512, 768, 1024.\n'+
  'A batch reuses one Kaggle session and loaded models; first run downloads large model files.\n'+
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
export function normalizePrompt(input:string):string{
  return input.replace(/\{argument\s+name=(?:"[^"]+"|'[^']+')\s+default=(?:"([^"]*)"|'([^']*)')\s*\}/gi,
    (_match,doubleQuoted,singleQuoted)=>doubleQuoted??singleQuoted??'')
    .replace(/\s+/g,' ').trim()
}
function batchPrompts(value:string):string[]|null{
  if(!value.startsWith(BATCH_PREFIX))return null
  const parsed=JSON.parse(value.slice(BATCH_PREFIX.length))
  if(!Array.isArray(parsed)||parsed.length<2||parsed.length>4||
     parsed.some(x=>typeof x!=='string'||x.length<3||x.length>1400)){
    throw Error('Stored Qwen batch payload is invalid')
  }
  return parsed
}
function source(task:Job){
  const prompts=batchPrompts(task.prompt)
  const payload=prompts
    ? prompts.map((prompt,index)=>({prompt,width:task.width,height:task.height,
        seed:(task.seed+index*104729)>>>0}))
    : {prompt:task.prompt,width:task.width,height:task.height,seed:task.seed}
  // JSON-encoded string literal is also valid as a Python string. No user input is evaluated.
  const literal=JSON.stringify(JSON.stringify(payload))
  const variable=prompts?'QWEN_TASKS_JSON':'QWEN_TASK_JSON'
  return 'import os, pathlib, urllib.request\n'+
    'os.environ['+JSON.stringify(variable)+'] = '+literal+'\n'+
    'source = '+JSON.stringify(SCRIPT_URL)+'\n'+
    'path = pathlib.Path("/kaggle/working/qwen_generate.py")\n'+
    'urllib.request.urlretrieve(source, path)\n'+
    'exec(compile(path.read_bytes(), str(path), "exec"), {"__name__":"__main__"})\n'
}

function safeOutputUrl(value:unknown):string|null{
  if(typeof value!=='string')return null
  try{
    const u=new URL(value),h=u.hostname.toLowerCase()
    if(u.protocol==='https:'&&(h==='storage.googleapis.com'||h==='api.kaggle.com'||
      h==='www.kaggle.com'||h.endsWith('.kaggleusercontent.com')||
      h.endsWith('.googleapis.com')))return u.toString()
  }catch{/* ignore invalid URL */}
  return null
}
function outputUrl(data:Record<string,unknown>):string|null{
  const files=data.files||data.outputFiles
  if(!Array.isArray(files))return null
  for(const item of files){
    if(!item||typeof item!=='object')continue
    const f=item as Record<string,unknown>
    if(String(f.fileName||f.file_name)==='qwen_image21_result.png'){
      const url=safeOutputUrl(f.url)
      if(url)return url
    }
  }
  return null
}
function outputUrls(data:Record<string,unknown>,names:string[]):(string|null)[]{
  const files=data.files||data.outputFiles
  if(!Array.isArray(files))return names.map(()=>null)
  const byName=new Map<string,string>()
  for(const item of files){
    if(!item||typeof item!=='object')continue
    const f=item as Record<string,unknown>
    const name=String(f.fileName||f.file_name||'')
    const url=safeOutputUrl(f.url)
    if(name&&url)byName.set(name,url)
  }
  return names.map(name=>byName.get(name)||null)
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
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength)
  if(view.getUint32(16)!==job.width||view.getUint32(20)!==job.height){
    throw Error('PNG dimensions do not match the requested output')
  }
  const asPhoto=data.length<=9*1024*1024
  const method=asPhoto?'sendPhoto':'sendDocument'
  const form=new FormData()
  form.set('chat_id',job.chat_id)
  form.set('caption','✅ Qwen Image 2.1 research render #'+job.id+
    ' • '+job.width+'×'+job.height+' • Q4_K_M • Viggle 6 steps • seed '+job.seed)
  form.set(asPhoto?'photo':'document',new Blob([data],{type:'image/png'}),'qwen-image21-'+job.id+'.png')
  const sent=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/'+method,{
    method:'POST',body:form,signal:AbortSignal.timeout(65000)
  })
  const receipt=await sent.json().catch(()=>({})) as {ok?:boolean}
  if(!sent.ok||receipt.ok!==true)throw Error('Telegram PNG delivery unconfirmed')
}

async function deliverBatch(env:QwenEnv,job:Job,urls:string[],prompts:string[]){
  if(urls.length!==prompts.length||urls.length<2||urls.length>4){
    throw Error('Qwen batch output count does not match the requested batch')
  }
  const images=await Promise.all(urls.map(async(url,index)=>{
    const r=await fetch(url,{redirect:'follow',signal:AbortSignal.timeout(65000)})
    const length=Number(r.headers.get('content-length')||0)
    if(!r.ok||length>15*1024*1024){
      await r.body?.cancel()
      throw Error('Kaggle batch PNG download failed or exceeded 15 MiB')
    }
    const data=new Uint8Array(await r.arrayBuffer())
    const signature=[137,80,78,71,13,10,26,10]
    if(data.length<4096||data.length>15*1024*1024||
       signature.some((byte,i)=>data[i]!==byte)){
      throw Error('Batch item '+(index+1)+' is not a valid PNG')
    }
    const view=new DataView(data.buffer,data.byteOffset,data.byteLength)
    if(view.getUint32(16)!==job.width||view.getUint32(20)!==job.height){
      throw Error('Batch item '+(index+1)+' has unexpected PNG dimensions')
    }
    return {data,name:'qwen-image21-'+job.id+'-'+String(index+1).padStart(2,'0')+'.png',
      caption:'✅ Qwen Image 2.1 batch #'+job.id+' • '+(index+1)+'/'+urls.length+
        ' • '+job.width+'×'+job.height+' • Q4_K_M • Viggle 6 steps • seed '+((job.seed+index*104729)>>>0)}
  }))
  const total=images.reduce((sum,item)=>sum+item.data.length,0)
  if(total>40*1024*1024)throw Error('Qwen batch output exceeds the 40 MiB delivery safety limit')
  if(images.every(item=>item.data.length<=9*1024*1024)){
    const form=new FormData()
    form.set('chat_id',job.chat_id)
    const media=images.map((item,index)=>({
      type:'photo',media:'attach://image'+(index+1),caption:item.caption
    }))
    form.set('media',JSON.stringify(media))
    images.forEach((item,index)=>{
      form.set('image'+(index+1),new Blob([item.data],{type:'image/png'}),item.name)
    })
    const sent=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/sendMediaGroup',{
      method:'POST',body:form,signal:AbortSignal.timeout(65000)
    })
    const receipt=await sent.json().catch(()=>({})) as {ok?:boolean;result?:unknown[]}
    if(!sent.ok||receipt.ok!==true||!Array.isArray(receipt.result)||receipt.result.length!==images.length){
      throw Error('Telegram batch album delivery was not confirmed')
    }
    return
  }
  // Larger PNGs are sent as documents individually to avoid Telegram photo limits.
  for(const item of images){
    const form=new FormData()
    form.set('chat_id',job.chat_id)
    form.set('caption',item.caption)
    form.set('document',new Blob([item.data],{type:'image/png'}),item.name)
    const sent=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/sendDocument',{
      method:'POST',body:form,signal:AbortSignal.timeout(65000)
    })
    const receipt=await sent.json().catch(()=>({})) as {ok?:boolean}
    if(!sent.ok||receipt.ok!==true)throw Error('Telegram batch document delivery was not confirmed')
  }
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
      'SELECT id,status,width,height,prompt,version_number,error_message FROM qwen_image21_jobs '+
      'WHERE chat_id=? ORDER BY id DESC LIMIT 1'
    ).bind(chat).all<{id:number;status:string;width:number;height:number;prompt:string;version_number:number|null;error_message:string|null}>()
    const j=rows.results[0]
    const batch=j?batchPrompts(j.prompt):null
    const shown=j?.status==='queued'?'waiting for submission':
      j?.status==='kaggle-queued'?'waiting for Kaggle GPU':j?.status
    await send(j?'🖼️ Qwen '+(batch?'batch #'+j.id+' ('+batch.length+' images)':'#'+j.id)+': '+shown+' • '+j.width+'×'+j.height+
      (j.version_number?' • Kaggle v'+j.version_number:'')+
      (j.error_message?'\n'+j.error_message.slice(0,150):''):'No Qwen research jobs yet.\n'+HELP)
    return true
  }
  let prompt=normalizePrompt(m[2]||'')
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
    'SELECT id FROM qwen_image21_jobs WHERE chat_id=? AND status IN '+BLOCKING+' LIMIT 1'
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

export async function qwenBatchCommand(env:QwenEnv,chat:string,messageId:number,text:string,
 send:(message:string)=>Promise<unknown>):Promise<boolean>{
  const m=text.match(/^\/(qwenbatch|qwenbatch_status|qwenbatch_help)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i)
  if(!m)return false
  await schema(env.MEMORY_DB)
  const command=m[1].toLowerCase()
  if(command==='qwenbatch_help'){
    await send('🖼️ Qwen batch research generation.\n'+
      'Use /qwenbatch --size=1024, then put one prompt on each line (2–4 prompts).\n'+
      'Example:\n/qwenbatch\nA cinematic mountain village at dawn\nA red sports car in the rain\n'+
      'The model loads once and generates images sequentially in one Kaggle T4 session.\n'+
      'Check: /qwenbatch_status. Research-only; Qwen Research License prohibits commercial use without separate permission.')
    return true
  }
  if(command==='qwenbatch_status'){
    const rows=await env.MEMORY_DB.prepare(
      'SELECT id,status,width,height,prompt,version_number,error_message FROM qwen_image21_jobs '+
      'WHERE chat_id=? AND substr(prompt,1,?)=? ORDER BY id DESC LIMIT 1'
    ).bind(chat,BATCH_PREFIX.length,BATCH_PREFIX).all<{
      id:number;status:string;width:number;height:number;prompt:string;
      version_number:number|null;error_message:string|null
    }>()
    const j=rows.results[0]
    if(!j){await send('No Qwen batches yet. Use /qwenbatch_help for instructions.');return true}
    const prompts=batchPrompts(j.prompt)||[]
    const shown=j.status==='queued'?'waiting for submission':
      j.status==='kaggle-queued'?'waiting for Kaggle GPU':j.status
    await send('🖼️ Qwen batch #'+j.id+': '+shown+' • '+prompts.length+
      ' images • '+j.width+'×'+j.height+
      (j.version_number?' • Kaggle v'+j.version_number:'')+
      (j.error_message?'\n'+j.error_message.slice(0,150):''))
    return true
  }
  const lines=(m[2]||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean)
  let dim=1024
  const opt=lines[0]?.match(/^--size=(512|768|1024)$/)
  if(opt){dim=Number(opt[1]);lines.shift()}
  const prompts=lines.map(line=>normalizePrompt(line.replace(/^(?:[-*•]|\d+[.)])\s*/,'')))
    .filter(Boolean)
  if(prompts.length<2||prompts.length>4||prompts.some(x=>x.length<3||x.length>1400)){
    await send('Provide 2–4 prompts, one per line. Each prompt must contain 3–1400 characters.\n'+
      'Example:\n/qwenbatch --size=1024\nA cinematic mountain village at dawn\nA red sports car in the rain\n'+
      'Help: /qwenbatch_help')
    return true
  }
  if(env.QWEN_KAGGLE_ENABLED!=='1'){
    await send('🧪 Qwen Kaggle backend is locked until the GPU test succeeds.')
    return true
  }
  if(!env.KAGGLE_API_TOKEN){
    await send('Kaggle API credential is not configured in the Worker.')
    return true
  }
  const busy=await env.MEMORY_DB.prepare(
    'SELECT id FROM qwen_image21_jobs WHERE chat_id=? AND status IN '+BLOCKING+' LIMIT 1'
  ).bind(chat).all<{id:number}>()
  if(busy.results.length){
    await send('You already have an active Qwen image or batch job. Use /qwenimage_status or /qwenbatch_status.')
    return true
  }
  const seed=crypto.getRandomValues(new Uint32Array(1))[0]
  await env.MEMORY_DB.prepare(
    'INSERT OR IGNORE INTO qwen_image21_jobs(chat_id,message_id,prompt,width,height,seed) VALUES(?,?,?,?,?,?)'
  ).bind(chat,messageId,BATCH_PREFIX+JSON.stringify(prompts),dim,dim,seed).run()
  const row=await env.MEMORY_DB.prepare(
    'SELECT id FROM qwen_image21_jobs WHERE chat_id=? AND message_id=?'
  ).bind(chat,messageId).all<{id:number}>()
  await send('✅ Qwen batch #'+(row.results[0]?.id||'?')+' queued: '+prompts.length+
    ' images at '+dim+'×'+dim+'. They will run sequentially in one Kaggle session. /qwenbatch_status')
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
    if(!['submitted','kaggle-queued','running'].includes(job.status)||!job.version_number)return
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
        const prompts=batchPrompts(job.prompt)
        const batchNames=prompts?prompts.map((_p,index)=>'qwen_image21_'+String(index+1).padStart(2,'0')+'.png'):[]
        const urls=prompts?outputUrls(files,batchNames):[]
        const url=prompts?null:outputUrl(files)
        if(prompts?urls.some(x=>!x):!url)return
        const claim=await db.prepare("UPDATE qwen_image21_jobs SET status='delivering',"+
          'updated_at=unixepoch() WHERE id=? AND status IN (\'submitted\',\'kaggle-queued\',\'running\')'
        ).bind(job.id).run()
        if(claim.meta.changes!==1)return
        try{
          if(prompts)await deliverBatch(env,job,urls as string[],prompts)
          else await deliver(env,job,url as string)
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
      }else if(status.includes('QUEUED')||status.includes('INITIALIZING')||status.includes('PENDING')){
        await db.prepare("UPDATE qwen_image21_jobs SET status='kaggle-queued',updated_at=unixepoch() WHERE id=?")
          .bind(job.id).run()
      }else if(status.includes('RUNNING')){
        await db.prepare("UPDATE qwen_image21_jobs SET status='running',updated_at=unixepoch() WHERE id=?")
          .bind(job.id).run()
      }else{
        console.warn('Qwen Kaggle returned unrecognized status',status)
      }
    }catch(e){
      console.error('Qwen Kaggle poll error',e instanceof Error?e.name:'unknown')
    }
    return
  }
  // Respect other Kaggle jobs already in this bot.
  for(const sql of [
    "SELECT id FROM pyvt_kaggle_jobs WHERE status IN ('submitting','submitted','running','delivering','submit-uncertain','needs-review') LIMIT 1",
    "SELECT id FROM vox_kaggle_jobs WHERE status IN ('submitting','submitted','running','delivering','submit-uncertain','needs-review') LIMIT 1",
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
