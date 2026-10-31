/**
 * Kaggle VoxCPM2 batch queue. Cloudflare handles Telegram and D1 only;
 * dedicated OCI dispatcher owns Kaggle credentials, submits runs and reports WAVs.
 * No GPU is executed on Workers.
 */
type Db={prepare(query:string):{bind(...v:(string|number)[]):{run():Promise<{meta:{changes:number}}> ; all<T>():Promise<{results:T[]}>}}}
export type VoxEnv = {
  MEMORY_DB:Db; TELEGRAM_BOT_TOKEN:string; VOX_WORKER_KEY?:string
}
type Job={id:number;chat_id:string;text:string;status:string;created_at:number;updated_at:number;message_id:number;error_message:string|null}
const VALID=/^[1-9][0-9]*$/
const STATUS=new Set(['submitted','running','downloading','failed','submit-uncertain'])
async function init(db:Db){
 await db.prepare('CREATE TABLE IF NOT EXISTS vox_kaggle_jobs ('+
  "id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, message_id INTEGER NOT NULL,"+
  "text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', error_message TEXT,"+
  "created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()),"+
  "UNIQUE(chat_id,message_id))").bind().run()
}
async function telegram(env:VoxEnv,chat_id:string,text:string){
 const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/sendMessage',{
  method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({chat_id,text:text.slice(0,3900)}),signal:AbortSignal.timeout(16000)
 })
 const d=await r.json() as {ok?:boolean}
 if(!r.ok||!d.ok)throw new Error('Telegram send failed')
}
export async function handleVoxTelegram(
 env:VoxEnv,chat:string,messageId:number,text:string,
 send:(msg:string)=>Promise<void>):Promise<boolean>{
 const cmd=text.trim().split(/\s+/,1)[0]?.split('@')[0].toLowerCase()
 if(!['/vox','/vox_status','/vox_help'].includes(cmd))return false
 try{
  await init(env.MEMORY_DB)
  if(cmd==='/vox_help'){
   await send('Kaggle VoxCPM2 Burmese speech: /vox YOUR TEXT\nCheck latest job: /vox_status\nEach job runs on Kaggle GPU when your private dispatcher is configured. Maximum 800 characters.')
   return true
  }
  if(cmd==='/vox_status'){
   const r=await env.MEMORY_DB.prepare('SELECT id,status,error_message FROM vox_kaggle_jobs WHERE chat_id=? ORDER BY id DESC LIMIT 1')
     .bind(chat).all<{id:number;status:string;error_message:string|null}>()
   const j=r.results[0]
   await send(j?'VoxCPM2 job #'+j.id+': '+j.status+(j.error_message?'\n'+j.error_message.slice(0,180):''):
     'No VoxCPM2 jobs found. Use /vox YOUR TEXT.')
   return true
  }
  if(!env.VOX_WORKER_KEY || env.VOX_WORKER_KEY.length<32){\n    await send('Kaggle VoxCPM2 worker is not connected yet. The existing MVSEP audio generation remains available.');return true\n  }\n  const speech=text.replace(/^\/vox(?:@[A-Za-z0-9_]+)?(?:\s+|$)/i,'').trim()
  if(!speech||speech.length>800){
   await send('Use /vox followed by 1–800 characters of speech text. Example: /vox မင်္ဂလာပါ။')
   return true
  }
  const active=await env.MEMORY_DB.prepare("SELECT COUNT(*) AS cnt FROM vox_kaggle_jobs WHERE chat_id=? AND status IN ('queued','claimed','submitted','running','downloading','submit-uncertain')").bind(chat).all<{cnt:number}>()
  if((active.results[0]?.cnt||0)>=2){await send('You have 2 unfinished VoxCPM2 jobs. Check /vox_status before submitting another.');return true}
  await env.MEMORY_DB.prepare("INSERT OR IGNORE INTO vox_kaggle_jobs(chat_id,message_id,text) VALUES(?,?,?)").bind(chat,messageId,speech).run()
  const latest=await env.MEMORY_DB.prepare("SELECT id FROM vox_kaggle_jobs WHERE chat_id=? AND message_id=?").bind(chat,messageId).all<{id:number}>()
  await send('VoxCPM2 job #'+latest.results[0]?.id+' queued.\nKaggle will run it when the private dispatcher is configured. Use /vox_status.')
  return true
 }catch(e){
  console.error('Vox Telegram handler failed',e instanceof Error?e.name:'unknown')
  await send('VoxCPM2 queue temporarily unavailable.').catch(()=>undefined)
  return true
 }
}
function authorized(env:VoxEnv,request:Request){
 const key=request.headers.get('X-Vox-Worker-Key')
 return Boolean(env.VOX_WORKER_KEY&&env.VOX_WORKER_KEY.length>=32&&key===env.VOX_WORKER_KEY)
}
const bad=()=>Response.json({ok:false,error:'Unauthorized'},{status:401})
export async function voxClaim(env:VoxEnv,request:Request):Promise<Response>{
 if(!authorized(env,request))return bad()
 await init(env.MEMORY_DB)
 // Atomically claim just one queue entry; another in-flight job must finish first.
 const claimed=await env.MEMORY_DB.prepare(
 "UPDATE vox_kaggle_jobs SET status='claimed',updated_at=unixepoch() "+
 "WHERE id=(SELECT id FROM vox_kaggle_jobs WHERE status='queued' ORDER BY id LIMIT 1) "+
 "AND NOT EXISTS (SELECT 1 FROM vox_kaggle_jobs WHERE status IN ('claimed','submitted','running','downloading','submit-uncertain'))"
 ).bind().run()
 if(claimed.meta.changes===0)return Response.json({ok:true,job:null})
 const rows=await env.MEMORY_DB.prepare(
  "SELECT id,chat_id,text FROM vox_kaggle_jobs WHERE status='claimed' ORDER BY updated_at DESC LIMIT 1"
 ).bind().all<{id:number;chat_id:string;text:string}>()
 return Response.json({ok:true,job:rows.results[0]||null})
}
export async function voxUpdate(env:VoxEnv,request:Request):Promise<Response>{
 if(!authorized(env,request))return bad()
 let payload:{job_id?:number;status?:string;error?:string}
 try{payload=await request.json() as typeof payload}catch{return Response.json({ok:false,error:'Invalid JSON'},{status:400})}
 if(!Number.isSafeInteger(payload.job_id)||!STATUS.has(payload.status||'')){
  return Response.json({ok:false,error:'Invalid status or job ID'},{status:400})
 }
 await init(env.MEMORY_DB)
 const error=(payload.error||'').slice(0,200)
 const r=await env.MEMORY_DB.prepare(
 "UPDATE vox_kaggle_jobs SET status=?,error_message=?,updated_at=unixepoch() "+
 "WHERE id=? AND status IN ('claimed','submitted','running','downloading')"
 ).bind(payload.status!,error,payload.job_id!).run()
 return Response.json({ok:r.meta.changes===1})
}
export async function voxComplete(env:VoxEnv,request:Request):Promise<Response>{
 if(!authorized(env,request))return bad()
 if(!(request.headers.get('content-type')||'').includes('multipart/form-data'))
  return Response.json({ok:false,error:'Expected multipart'},{status:415})
 const f=await request.formData()
 const id=Number(f.get('job_id'))
 const audio=f.get('audio')
 if(!Number.isSafeInteger(id)||id<1||!(audio instanceof File)||audio.size<44||audio.size>20*1024*1024)
  return Response.json({ok:false,error:'Invalid WAV or job ID'},{status:400})
 const magic=Array.from(new Uint8Array(await audio.slice(0,12).arrayBuffer()))
 if(String.fromCharCode(...magic.slice(0,4))!=='RIFF'||String.fromCharCode(...magic.slice(8,12))!=='WAVE')
  return Response.json({ok:false,error:'WAV required'},{status:400})
 await init(env.MEMORY_DB)
 // Claim delivery first; on unknown network failure do not resend automatically.
 const rows=await env.MEMORY_DB.prepare(
   "SELECT chat_id FROM vox_kaggle_jobs WHERE id=? AND status IN ('downloading','running','submitted','claimed')"
 ).bind(id).all<{chat_id:string}>()
 const chat=rows.results[0]?.chat_id
 if(!chat)return Response.json({ok:false,error:'Job missing or already delivered'},{status:409})
 const claimed=await env.MEMORY_DB.prepare(
 "UPDATE vox_kaggle_jobs SET status='delivering',updated_at=unixepoch() "+
 "WHERE id=? AND status IN ('downloading','running','submitted','claimed')"
 ).bind(id).run()
 if(claimed.meta.changes!==1)return Response.json({ok:false,error:'Already handled'},{status:409})
 const media=new FormData()
 media.set('chat_id',chat)
 media.set('caption','VoxCPM2 Kaggle job #'+id+' completed')
 media.set('audio',audio,'voxcpm2-'+id+'.wav')
 try{
  const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/sendAudio',{
   method:'POST',body:media,signal:AbortSignal.timeout(60000)
  })
  const result=await r.json() as {ok?:boolean}
  if(!r.ok||!result.ok)throw new Error('Telegram sendAudio failed')
  await env.MEMORY_DB.prepare("UPDATE vox_kaggle_jobs SET status='done',updated_at=unixepoch() WHERE id=?").bind(id).run()
  return Response.json({ok:true,delivered:true})
 }catch(e){
  console.error('Vox Telegram delivery uncertain',e instanceof Error?e.name:'unknown')
  await env.MEMORY_DB.prepare("UPDATE vox_kaggle_jobs SET status='delivery-uncertain',updated_at=unixepoch() WHERE id=?").bind(id).run()
  return Response.json({ok:false,error:'Delivery uncertain; manual check required'},{status:502})
 }
}
