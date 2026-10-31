/**
 * Independent VoxCPM2 speaker library. Five private voice slots per Telegram user.
 * Store only <=180kB generated eight-second reference MP3s (base64) in D1.
 * The user's original Kaggle studio and MVSEP voice profiles are untouched.
 */
type DB={prepare(sql:string):{bind(...params:(string|number)[]):{
 run():Promise<{meta:{changes:number}}>;all<T>():Promise<{results:T[]}>
}}}
export type VoiceEnv={MEMORY_DB:DB;TELEGRAM_BOT_TOKEN:string}
export type VoxCallback={id:string;data?:string;from:{id:number};message?:{chat:{id:number};message_id:number}}
export async function setupVoxVoices(db:DB):Promise<void>{
 await db.prepare("CREATE TABLE IF NOT EXISTS vox_voice_samples ("+
  "job_id INTEGER PRIMARY KEY,chat_id TEXT NOT NULL,audio_b64 TEXT NOT NULL,"+
  "created_at INTEGER NOT NULL DEFAULT (unixepoch()))").bind().run()
 await db.prepare("CREATE TABLE IF NOT EXISTS vox_saved_voices ("+
  "chat_id TEXT NOT NULL,slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 5),"+
  "name TEXT NOT NULL,audio_b64 TEXT NOT NULL,source_job INTEGER NOT NULL,"+
  "updated_at INTEGER NOT NULL DEFAULT (unixepoch()),PRIMARY KEY(chat_id,slot))").bind().run()
 await db.prepare("CREATE TABLE IF NOT EXISTS vox_job_voice_slot ("+
  "job_id INTEGER PRIMARY KEY,chat_id TEXT NOT NULL,slot INTEGER NOT NULL)").bind().run()
}
function toB64(bytes:Uint8Array):string{
 let str=''
 for(let i=0;i<bytes.length;i+=8192)str+=String.fromCharCode(...bytes.subarray(i,i+8192))
 return btoa(str)
}
export async function storeVoxReference(env:VoiceEnv,jobId:number,chat:string,url:string):Promise<boolean>{
 try{
  const res=await fetch(url,{signal:AbortSignal.timeout(25000)})
  if(!res.ok||Number(res.headers.get('content-length')||0)>180000)return false
  const bytes=new Uint8Array(await res.arrayBuffer())
  if(bytes.length<1500||bytes.length>180000)return false
  if(!((bytes[0]===73&&bytes[1]===68&&bytes[2]===51)||
    (bytes[0]===255&&(bytes[1]&224)===224)))return false
  await setupVoxVoices(env.MEMORY_DB)
  await env.MEMORY_DB.prepare(
   "INSERT OR REPLACE INTO vox_voice_samples(job_id,chat_id,audio_b64) VALUES(?,?,?)"
  ).bind(jobId,chat,toB64(bytes)).run()
  return true
 }catch(e){
  console.error('Vox preview store failed',e instanceof Error?e.name:'unknown')
  return false
 }
}
export async function voiceForJob(db:DB,jobId:number,chat:string):Promise<string|null>{
 await setupVoxVoices(db)
 const found=await db.prepare(
  "SELECT v.audio_b64 FROM vox_saved_voices v JOIN vox_job_voice_slot j "+
  "ON v.chat_id=j.chat_id AND v.slot=j.slot WHERE j.job_id=? AND j.chat_id=? LIMIT 1"
 ).bind(jobId,chat).all<{audio_b64:string}>()
 return found.results[0]?.audio_b64||null
}
export async function voxVoiceMenu(env:VoiceEnv,chat:string,send:(s:string)=>Promise<void>):Promise<void>{
 await setupVoxVoices(env.MEMORY_DB)
 const rows=await env.MEMORY_DB.prepare(
  "SELECT slot,name FROM vox_saved_voices WHERE chat_id=? ORDER BY slot"
 ).bind(chat).all<{slot:number;name:string}>()
 await send("Your VoxCPM2 voice library:\n"+Array.from({length:5},(_,i)=>{
  const found=rows.results.find(x=>x.slot===i+1)
  return (i+1)+". "+(found?found.name:"Empty")
 }).join("\n")+"\n\nGenerate: /voxvoice 1 YOUR TEXT\nRename: /voxrename 1 Narrator\nSave a new voice with the button on a generated audio message.")
}
async function tg(env:VoiceEnv,method:string,payload:Record<string,unknown>):Promise<Record<string,unknown>>{
 const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/'+method,{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),
  signal:AbortSignal.timeout(15000)})
 const j=await r.json() as {ok?:boolean;result?:Record<string,unknown>}
 if(!r.ok||!j.ok)throw Error('Telegram '+method+' failed')
 return j.result||{}
}
export async function handleVoxCallback(env:VoiceEnv,cb:VoxCallback):Promise<void>{
 const chat=String(cb.message?.chat.id??'')
 try{
  if(!chat||String(cb.from.id)!==chat||!cb.data?.startsWith('vx:'))return
  await setupVoxVoices(env.MEMORY_DB)
  const parts=cb.data.split(':')
  const job=Number(parts[2])
  if(!Number.isSafeInteger(job)||job<1)throw Error('Invalid audio job')
  const record=await env.MEMORY_DB.prepare(
   'SELECT job_id FROM vox_voice_samples WHERE job_id=? AND chat_id=?'
  ).bind(job,chat).all<{job_id:number}>()
  if(!record.results.length)throw Error('Saved voice sample unavailable')
  if(parts[1]==='save'){
   const rows=await env.MEMORY_DB.prepare(
    'SELECT slot,name FROM vox_saved_voices WHERE chat_id=?'
   ).bind(chat).all<{slot:number;name:string}>()
   const options=Array.from({length:5},(_,i)=>{
    const slot=i+1,existing=rows.results.find(x=>x.slot===slot)
    return [{text:String(slot)+'. '+(existing?existing.name+' (replace)':'Empty'),
     callback_data:'vx:slot:'+job+':'+slot}]
   })
   await tg(env,'sendMessage',{chat_id:chat,text:'Choose a VoxCPM2 voice slot to save this generated voice:',
    reply_markup:{inline_keyboard:options}})
  }else if(parts[1]==='slot'){
   const slot=Number(parts[3])
   if(!Number.isInteger(slot)||slot<1||slot>5)throw Error('Invalid slot')
   const result=await env.MEMORY_DB.prepare(
    "INSERT INTO vox_saved_voices(chat_id,slot,name,audio_b64,source_job) "+
    "SELECT ?,?, ?,audio_b64,job_id FROM vox_voice_samples WHERE job_id=? AND chat_id=? "+
    "ON CONFLICT(chat_id,slot) DO UPDATE SET name=excluded.name,audio_b64=excluded.audio_b64,"+
    "source_job=excluded.source_job,updated_at=unixepoch()"
   ).bind(chat,slot,'Voice '+slot,job,chat).run()
   if(!result.meta.changes)throw Error('Voice could not be stored')
   await tg(env,'sendMessage',{chat_id:chat,text:'Saved VoxCPM2 voice '+slot+
    ' from job #'+job+'.\nReuse: /voxvoice '+slot+' မင်္ဂလာပါ။\nRename: /voxrename '+slot+' Documentary'})
  }
 }catch(e){
  console.error('Vox voice save failed',e instanceof Error?e.message.slice(0,110):'unknown')
  if(chat)await tg(env,'sendMessage',{chat_id:chat,text:'Could not save this voice. The reference clip may no longer be available.'}).catch(()=>undefined)
 }finally{
  await tg(env,'answerCallbackQuery',{callback_query_id:cb.id}).catch(()=>undefined)
 }
}
