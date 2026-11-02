import {duration,providerReceipt} from './usage-receipts'
/** Automatic WAN result delivery; complements the original /video_status and /motion_status fallback commands.
 * Updates one Telegram progress message per job on the existing minute cron.
 * Never auto-resubmits a paid GPU job. */
type Db = {prepare:(sql:string)=>{bind:(...args:(string|number)[])=>{run:()=>Promise<{meta:{changes:number}}>;all:<T>()=>Promise<{results:T[]}>}}}
type Env = {MEMORY_DB:Db;TELEGRAM_BOT_TOKEN:string;MODAL_WAN_API_BASE?:string;MODAL_WAN_API_KEY?:string;MODAL_MOTION_API_BASE?:string;MODAL_MOTION_API_KEY?:string}
type Job={chat_id:string;telegram_message_id:number;job_id:string;status:string;created_at:number}
async function api(env:Env,method:string,data:FormData|Record<string,unknown>){
 const isForm=data instanceof FormData
 const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/'+method,{
  method:'POST',headers:isForm?{}:{'content-type':'application/json'},body:isForm?data:JSON.stringify(data),
  signal:AbortSignal.timeout(25000)
 })
 const body=await r.json() as {ok?:boolean;result?:{message_id?:number}}
 if(!r.ok||!body.ok)throw new Error('Telegram '+method+' failed HTTP '+r.status)
 return body.result||{}
}
async function ensure(db:Db){
 await db.prepare('CREATE TABLE IF NOT EXISTS wan_job_progress (chat_id TEXT NOT NULL, telegram_message_id INTEGER NOT NULL, progress_id INTEGER, last_label TEXT NOT NULL DEFAULT \'\', PRIMARY KEY(chat_id,telegram_message_id))').bind().run()
}
async function setProgress(env:Env,j:Job,label:string){
 const db=env.MEMORY_DB
 const existing=await db.prepare('SELECT progress_id,last_label FROM wan_job_progress WHERE chat_id=? AND telegram_message_id=?')
  .bind(j.chat_id,j.telegram_message_id).all<{progress_id:number;last_label:string}>()
 const previous=existing.results[0]
 if(previous?.last_label===label)return
 if(!previous?.progress_id){
  const out=await api(env,'sendMessage',{chat_id:j.chat_id,text:label,reply_parameters:{message_id:j.telegram_message_id}})
  await db.prepare('INSERT OR REPLACE INTO wan_job_progress(chat_id,telegram_message_id,progress_id,last_label) VALUES(?,?,?,?)')
   .bind(j.chat_id,j.telegram_message_id,out.message_id||0,label).run()
 }else{
  await api(env,'editMessageText',{chat_id:j.chat_id,message_id:previous.progress_id,text:label})
  await db.prepare('UPDATE wan_job_progress SET last_label=? WHERE chat_id=? AND telegram_message_id=?')
   .bind(label,j.chat_id,j.telegram_message_id).run()
 }
}
async function deliver(env:Env,j:Job,base:string,path:string,headers:Record<string,string>){
 const r=await fetch(base+path,{headers,signal:AbortSignal.timeout(125000)})
 if(!r.ok)throw Error('WAN delivery HTTP '+r.status)
 if(Number(r.headers.get('content-length')||0)>45*1024*1024)throw Error('Video exceeds Telegram upload cap')
 const b=await r.blob()
 if(b.size===0||b.size>45*1024*1024)throw Error('Video output too large or empty')
 const form=new FormData();form.set('chat_id',j.chat_id)
 form.set('caption','✅ WAN render completed. Your video is ready.')
 form.set('video',new File([b],'result.mp4',{type:'video/mp4'}))
 await api(env,'sendVideo',form)
}
async function one(env:Env,j:Job){
 const motion=j.status.startsWith('motion-')
 const baseStr=motion?env.MODAL_MOTION_API_BASE:env.MODAL_WAN_API_BASE
 if(!baseStr)return
 const u=new URL(baseStr)
 if(u.protocol!=='https:'||!u.hostname.endsWith('.modal.run'))return
 const base=u.origin
 const k=motion?env.MODAL_MOTION_API_KEY:env.MODAL_WAN_API_KEY
 const headers:Record<string,string>=k?{Authorization:'Bearer '+k}:{}
 if(motion && !/^fc-[a-zA-Z0-9_-]{8,96}$/.test(j.job_id))return
 if(!motion&&!/^[0-9a-f]{32}$/i.test(j.job_id))return
 const statusPath=motion?'/v1/motion/jobs/'+encodeURIComponent(j.job_id):'/v1/generations/'+encodeURIComponent(j.job_id)
 const rr=await fetch(base+statusPath,{headers,signal:AbortSignal.timeout(14000)})
 if(!rr.ok)throw Error('Status HTTP '+rr.status)
 const data=await rr.json() as {status?:string;error?:unknown}
 const status=data.status||'processing'
 const ready=status==='succeeded'
 const failure=['failed','cancelled','canceled','error'].includes(status)
 if(failure){
  await env.MEMORY_DB.prepare('UPDATE wan_video_jobs SET status=?,updated_at=unixepoch() WHERE chat_id=? AND telegram_message_id=?')
   .bind(motion?'motion-failed':'failed',j.chat_id,j.telegram_message_id).run()
  await setProgress(env,j,'❌ '+(motion?'Motion':'Video')+' render failed. You may retry with a corrected prompt.')
  return
 }
 if(!ready){
  await setProgress(env,j,'⏳ '+(motion?'Motion':'WAN video')+' · '+status+'\nChecking automatically every minute.')
  return
 }
 // Status transitions claim delivery exactly once to prevent overlapping cron sends.
 const claimed=await env.MEMORY_DB.prepare('UPDATE wan_video_jobs SET status=?,updated_at=unixepoch() WHERE chat_id=? AND telegram_message_id=? AND status=?')
  .bind(motion?'motion-delivering':'delivering',j.chat_id,j.telegram_message_id,j.status).run()
 if(claimed.meta.changes!==1)return
 try{
  await setProgress(env,j,'📤 Render complete · sending your MP4 to Telegram…')
  await deliver(env,j,base,motion?statusPath+'/video':statusPath+'/video',headers)
  await env.MEMORY_DB.prepare('UPDATE wan_video_jobs SET status=?,updated_at=unixepoch() WHERE chat_id=? AND telegram_message_id=?')
   .bind(motion?'motion-succeeded':'succeeded',j.chat_id,j.telegram_message_id).run()
  await setProgress(env,j,'✅ MP4 delivered · '+duration(Math.floor(Date.now()/1000)-j.created_at)+' wall time\n'+await providerReceipt(env as never,'modal'))
 }catch(error){
  // A successful upload can be followed by a DB failure. Avoid repeated billed jobs;
  // leave 'delivery failed' as an explicit fallback for the manual status command.
  await env.MEMORY_DB.prepare('UPDATE wan_video_jobs SET status=?,updated_at=unixepoch() WHERE chat_id=? AND telegram_message_id=?')
   .bind(motion?'motion-delivery-failed':'delivery-failed',j.chat_id,j.telegram_message_id).run()
  await setProgress(env,j,'⚠️ Render is ready, but Telegram delivery failed. Use '+
   (motion?'/motion_status':'/video_status')+' to retrieve it.')
 }
}
export async function pollWanAuto(env:Env){
 if(!env.MEMORY_DB||!env.TELEGRAM_BOT_TOKEN)return
 const db=env.MEMORY_DB
 await ensure(db)
 const rows=await db.prepare(
  "SELECT chat_id,telegram_message_id,job_id,status,created_at FROM wan_video_jobs "+
  "WHERE created_at>unixepoch()-86400 AND job_id!='' "+
  "AND status NOT IN ('succeeded','failed','delivering','delivery-failed','motion-delivering','motion-delivery-failed','motion-succeeded','motion-failed','motion-uncertain','motion-submitting','motion-queued') "+
  "AND status!='motion-ready' ORDER BY updated_at ASC LIMIT 4"
 ).bind().all<Job>()
 for(const job of rows.results){try{await one(env,job)}catch(e){console.error('WAN auto job poll failed',e instanceof Error?e.name:'unknown')}}
}
