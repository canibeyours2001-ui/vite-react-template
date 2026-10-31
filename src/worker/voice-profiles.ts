
import { isAllowedTelegramUser } from './telegram-access'

/**
 * Five reusable Qwen3-TTS Base voice references per authorized Telegram chat.
 *
 * D1 stores references and transcripts, never raw reference audio. Telegram file_id
 * is resolved only at generation time by the bot itself.
 */
type D1 = { prepare(sql: string): { bind(...params: (string | number)[]): {
  run(): Promise<{meta:{changes:number}}>
  all<T>(): Promise<{results:T[]}>
}}}
export type VoiceEnv = {
  MEMORY_DB: D1
  TELEGRAM_BOT_TOKEN: string
  TELEGRAM_CHAT_ID: string
  MVSEP_API_TOKEN?: string
}
type RefFile = { file_id:string; file_size?:number; file_name?:string; mime_type?:string }
export type VoiceMessage = {
  message_id:number
  text?:string
  caption?:string
  audio?:RefFile
  voice?:RefFile
  document?:RefFile
  reply_to_message?:{audio?:RefFile;voice?:RefFile;document?:RefFile}
}
export type VoiceCallback = { id:string; data?:string; from:{id:number}; message?:{chat:{id:number;type?:string};message_id:number} }
type Profile={slot:number;name:string;telegram_file_id:string;ref_text:string}
type Session={state:string;slot:number|null;custom_file_id:string|null;custom_ref_text:string|null;lang:string}
type Job={id:number;chat_id:string;telegram_file_id:string;ref_text:string;lang:string;speech_text:string}
const LIMIT=6*1024*1024
// MVSEP publishes no Qwen3-TTS text-size maximum. This limit protects
// Telegram/Workers/D1 from oversized uploads; it is NOT an MVSEP model limit.
const MAX_TTS_TEXT_BYTES=128*1024
const LANGUAGES=new Set(['Auto','English','Chinese','Japanese','Korean','German','French','Russian','Portuguese','Spanish','Italian'])
const help='Voice cloning:\n/savevoice 1 Narrator (reply to audio; transcript optional)\n/voices — saved voice slots\n/clone — select a saved or custom voice\nSend plain speech text (up to Telegram\'s 4,096-character message limit).\n/tts_long — collect a longer script as several plain messages\n/tts_done — finish the long script and review before generating\n/tts_status — check generation\n/clonelang English — set language\n/cancel — cancel voice selection\nNo file upload needed for scripts. MVSEP decides its actual text limit; longer requests may be rejected. Only clone permitted voices.'
function usableFile(file?:RefFile):file is RefFile{
  if(!file?.file_id || (file.file_size||0)>LIMIT)return false
  const ext=(file.file_name||'').toLowerCase()
  return !file.mime_type || file.mime_type.startsWith('audio/') ||
    /\.(wav|mp3|flac|ogg|oga|m4a)$/i.test(ext)
}
async function tg(env:VoiceEnv,method:string,data:Record<string,unknown>):Promise<Record<string,unknown>>{
  const resp=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/'+method,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data),
    signal:AbortSignal.timeout(18000)
  })
  const json=await resp.json() as {ok?:boolean;description?:string;result?:Record<string,unknown>}
  if(!resp.ok||!json.ok)throw new Error('Telegram '+method+' failed '+(json.description||resp.status))
  return json.result||{}
}
async function say(env:VoiceEnv,chat:string,text:string,keyboard?:{inline_keyboard:Array<Array<{text:string;callback_data:string}>>}){
  await tg(env,'sendMessage',{chat_id:chat,text:text.slice(0,3900),
    ...(keyboard?{reply_markup:keyboard}:{})})
}
async function init(db:D1){
  await db.prepare('CREATE TABLE IF NOT EXISTS qwen_voice_profiles (chat_id TEXT NOT NULL, slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 5), name TEXT NOT NULL, telegram_file_id TEXT NOT NULL, ref_text TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (chat_id,slot))').bind().run()
  await db.prepare('CREATE TABLE IF NOT EXISTS mvsep_tts_tracking (job_id INTEGER PRIMARY KEY, hash TEXT UNIQUE NOT NULL, status_message_id INTEGER, last_label TEXT NOT NULL DEFAULT \'\', checked_at INTEGER NOT NULL DEFAULT 0)').bind().run()
  await db.prepare('CREATE TABLE IF NOT EXISTS qwen_clone_sessions (chat_id TEXT PRIMARY KEY, state TEXT NOT NULL, slot INTEGER, custom_file_id TEXT, custom_ref_text TEXT, lang TEXT NOT NULL DEFAULT \'English\', updated_at INTEGER NOT NULL DEFAULT (unixepoch()))').bind().run()
  await db.prepare('CREATE TABLE IF NOT EXISTS qwen_clone_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, source_message_id INTEGER NOT NULL, telegram_file_id TEXT NOT NULL, ref_text TEXT NOT NULL, speech_text TEXT NOT NULL, lang TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'pending\', created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE(chat_id,source_message_id))').bind().run()
  await db.prepare('CREATE TABLE IF NOT EXISTS qwen_clone_long_parts (chat_id TEXT NOT NULL, source_message_id INTEGER NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY(chat_id,source_message_id))').bind().run()
}
async function profiles(db:D1,chat:string){
  const data=await db.prepare('SELECT slot,name,telegram_file_id,ref_text FROM qwen_voice_profiles WHERE chat_id=? ORDER BY slot').bind(chat).all<Profile>()
  return data.results
}
async function session(db:D1,chat:string):Promise<Session|null>{
  const rows=await db.prepare('SELECT state,slot,custom_file_id,custom_ref_text,lang FROM qwen_clone_sessions WHERE chat_id=?').bind(chat).all<Session>()
  return rows.results[0]||null
}
async function setSession(db:D1,chat:string,st:string,slot:number|null,file:string|null,ref:string|null,lang:string){
  await db.prepare('INSERT INTO qwen_clone_sessions (chat_id,state,slot,custom_file_id,custom_ref_text,lang) VALUES (?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET state=excluded.state,slot=excluded.slot,custom_file_id=excluded.custom_file_id,custom_ref_text=excluded.custom_ref_text,lang=excluded.lang,updated_at=unixepoch()').bind(chat,st,slot||0,file||'',ref||'',lang).run()
}
async function clearSession(db:D1,chat:string){
  await db.prepare('DELETE FROM qwen_clone_sessions WHERE chat_id=?').bind(chat).run()
  await db.prepare('DELETE FROM qwen_clone_long_parts WHERE chat_id=?').bind(chat).run()
}
function voiceButtons(data:Profile[]){
  const buttons=Array.from({length:5},(_,i)=>{
    const voice=data.find(v=>v.slot===i+1)
    return [{text:voice?(i+1)+'. '+voice.name:(i+1)+'. (empty)',callback_data:voice?'qw:slot:'+(i+1):'qw:empty'}]
  })
  buttons.push([{text:'Upload custom voice 🎤',callback_data:'qw:custom'}])
  buttons.push([{text:'Cancel',callback_data:'qw:cancel'}])
  return {inline_keyboard:buttons}
}
function selectedFile(m:VoiceMessage):RefFile|undefined{
  const reply=m.reply_to_message
  return reply?.audio||reply?.voice||
    (reply?.document&&usableFile(reply.document)?reply.document:undefined)
}
function inboundFile(m:VoiceMessage):RefFile|undefined{
  return m.audio||m.voice||(m.document&&usableFile(m.document)?m.document:undefined)
}
function apiConfigured(env:VoiceEnv):boolean{
  return Boolean(env.MVSEP_API_TOKEN)
}
/** Returns true for an intercepted voice command or active clone session. */
export async function handleVoiceMessage(env:VoiceEnv,msg:VoiceMessage,chat:string,content:string):Promise<boolean>{
  const [commandRaw]=content.trim().split(/\s+/,1)
  const cmd=(commandRaw||'').split('@')[0].toLowerCase()
  // Never treat help/AI requests as speech text, even inside an active clone wizard.
  if (['/ask','/help','/commands'].includes(cmd)) return false
  const recognized=['/savevoice','/voices','/clone','/clone_help','/tts_status','/cancel','/clonelang','/tts_long','/tts_done'].includes(cmd)
  let current:Session|null=null
  if(!recognized&&!inboundFile(msg)&&!content.trim())return false
  try {
    await init(env.MEMORY_DB)
    current=await session(env.MEMORY_DB,chat)
    if(!recognized&&!current)return false
    if(cmd==='/clone_help'){await say(env,chat,help);return true}
    if(cmd==='/cancel'){await clearSession(env.MEMORY_DB,chat);await say(env,chat,'Voice cloning cancelled.');return true}
    if(cmd==='/tts_status'){
      const rows=await env.MEMORY_DB.prepare(
        'SELECT j.id,j.status,t.hash FROM qwen_clone_jobs j LEFT JOIN mvsep_tts_tracking t ON t.job_id=j.id WHERE j.chat_id=? ORDER BY j.id DESC LIMIT 1'
      ).bind(chat).all<{id:number;status:string;hash:string|null}>()
      const last=rows.results[0]
      if(!last){await say(env,chat,'No Qwen3-TTS jobs found. Use /clone to begin.');return true}
      if(last.hash&&['waiting','processing','distributing','merging'].includes(last.status)){
        try{
          const state=await mvsepGet(last.hash)
          await say(env,chat,voiceState(state)+'\nJob: '+last.id)
        }catch{
          await say(env,chat,'Qwen3-TTS job #'+last.id+' last known status: '+last.status)
        }
      }else{
        await say(env,chat,'Qwen3-TTS job #'+last.id+': '+last.status)
      }
      return true
    }
    if(cmd==='/voices'){
      const data=await profiles(env.MEMORY_DB,chat)
      await say(env,chat,'Saved voice profiles:\n'+Array.from({length:5},(_,i)=>{
        const v=data.find(x=>x.slot===i+1)
        return (i+1)+'. '+(v?v.name:'Empty')
      }).join('\n')+'\n\nSave: reply to a recording with /savevoice 1 Narrator. No transcript required.')
      return true
    }
    if(cmd==='/savevoice'){
      const rest=content.replace(/^\/savevoice(?:@\w+)?\s*/i,'')
      const m=rest.match(/^([1-5])\s+([^|\n]{1,50}?)(?:\s*\|\s*(.{1,1000}))?$/s)
      const ref=selectedFile(msg)
      if(!m||!ref||!usableFile(ref)){
        await say(env,chat,'Reply to a 3–15 sec reference audio/voice with:\n/savevoice 1 Narrator\nTranscript not required.')
        return true
      }
      await env.MEMORY_DB.prepare('INSERT INTO qwen_voice_profiles (chat_id,slot,name,telegram_file_id,ref_text) VALUES (?,?,?,?,?) ON CONFLICT(chat_id,slot) DO UPDATE SET name=excluded.name,telegram_file_id=excluded.telegram_file_id,ref_text=excluded.ref_text,updated_at=unixepoch()')
        .bind(chat,Number(m[1]),m[2].trim(),ref.file_id,(m[3]||'').trim()).run()
      await say(env,chat,'Saved voice '+m[1]+': '+m[2].trim()+'. Use /clone to generate.')
      return true
    }
    if(cmd==='/clonelang'){
      const lang=content.replace(/^\/clonelang(?:@\w+)?\s*/i,'').trim()
      if(!LANGUAGES.has(lang)){await say(env,chat,'Choose: '+Array.from(LANGUAGES).join(', '));return true}
      await setSession(env.MEMORY_DB,chat,current?.state||'idle',current?.slot??null,current?.custom_file_id??null,current?.custom_ref_text??null,lang)
      await say(env,chat,'Cloning language set: '+lang)
      return true
    }
    if(cmd==='/clone'){
      const data=await profiles(env.MEMORY_DB,chat)
      await env.MEMORY_DB.prepare('DELETE FROM qwen_clone_long_parts WHERE chat_id=?').bind(chat).run()
      await setSession(env.MEMORY_DB,chat,'select',null,null,null,current?.lang||'English')
      await say(env,chat,'Choose a saved voice or upload a custom recording:',voiceButtons(data))
      return true
    }
    if(['target_text','custom_transcript','collect_text'].indexOf(current?.state||'')<0 &&
        (cmd==='/tts_long'||cmd==='/tts_done')){
      await say(env,chat,'Choose a saved or custom voice with /clone first. Then use /tts_long to send several plain text messages.');return true
    }
    if(!current||current.state==='select'||current.state==='idle')return false
    const text=content.trim()
    if(current.state==='custom_audio'){
      const ref=inboundFile(msg)
      if(!ref||!usableFile(ref)){await say(env,chat,'Please send an audio file or voice message (up to 6 MB).');return true}
      await setSession(env.MEMORY_DB,chat,'target_text',null,ref.file_id,'',current.lang)
      await say(env,chat,'Reference voice uploaded. Send your spoken text (up to 4,096 characters in one Telegram message). For longer scripts send /tts_long, then multiple plain text messages, then /tts_done. MVSEP determines its text limit. No reference transcript needed.')
      return true
    }
    // Long mode combines multiple ordinary Telegram text messages into one
    // MVSEP job. Never submit a billable task until Generate audio is confirmed.
    if(cmd==='/tts_long' && ['target_text','custom_transcript'].includes(current.state)){
      await env.MEMORY_DB.prepare(
        'DELETE FROM qwen_clone_long_parts WHERE chat_id=?'
      ).bind(chat).run()
      await setSession(env.MEMORY_DB,chat,'collect_text',current.slot,current.custom_file_id,current.custom_ref_text,current.lang)
      await say(env,chat,'Long speech mode started. Send your script as several PLAIN TEXT messages (each up to 4,096 characters). I will combine them in order. Send /tts_done when finished. Total bot safeguard: 128 KiB of UTF-8 text. MVSEP determines its actual maximum. /cancel stops.')
      return true
    }
    if(current.state==='collect_text' && cmd!=='/tts_done'){
      if(cmd==='/tts_long'){await say(env,chat,'Long text collection is already active. Send more text or /tts_done.');return true}
      if(!text || /^\/[a-z_]+(?:\s|$)/i.test(text)){await say(env,chat,'Send PLAIN speech text messages, or /tts_done to finish. /cancel discards the script.');return true}
      const updated=await env.MEMORY_DB.prepare(
        "INSERT OR IGNORE INTO qwen_clone_long_parts(chat_id,source_message_id,text) "+
        "SELECT ?,?,? WHERE (SELECT COALESCE(SUM(length(CAST(text AS BLOB))+1),0) "+
        "FROM qwen_clone_long_parts WHERE chat_id=?)+length(CAST(? AS BLOB))<=?"
      ).bind(chat,msg.message_id,text,chat,text,MAX_TTS_TEXT_BYTES).run()
      if(updated.meta.changes!==1){
        await say(env,chat,'Text message already received or 128 KiB safety limit reached. Send /tts_done to finish, or /cancel to restart.')
        return true
      }
      const row=(await env.MEMORY_DB.prepare(
        'SELECT COALESCE(SUM(length(CAST(text AS BLOB))+1),0) AS bytes,COUNT(*) AS parts FROM qwen_clone_long_parts WHERE chat_id=?'
      ).bind(chat).all<{bytes:number;parts:number}>()).results[0]
      await say(env,chat,'Part '+(row?.parts||0)+' saved ('+(row?.bytes||0)+' UTF-8 bytes total). Send more plain text, or /tts_done to review and confirm MVSEP generation.')
      return true
    }
    if(['target_text','custom_transcript'].includes(current.state)||
       (current.state==='collect_text'&&cmd==='/tts_done')){
      let speechText=text
      if(current.state==='collect_text'){
        const parts=(await env.MEMORY_DB.prepare(
          'SELECT text FROM qwen_clone_long_parts WHERE chat_id=? ORDER BY source_message_id ASC'
        ).bind(chat).all<{text:string}>()).results
        speechText=parts.map(x=>x.text).join('\n').trim()
      }else if(cmd==='/tts_done'){
        await say(env,chat,'To build a longer script, send /tts_long first; otherwise just send your plain speech text.')
        return true
      }
      const speechBytes=new TextEncoder().encode(speechText).byteLength
      if(!speechText || speechBytes>MAX_TTS_TEXT_BYTES){
        await say(env,chat,'Send plain speech text, up to 4,096 characters per Telegram message. For longer text use /tts_long, send several text messages, then /tts_done. MVSEP determines what it can actually generate.')
        return true
      }
      let fid=current.custom_file_id,ref=current.custom_ref_text,voiceName='Custom upload'
      if(current.slot&&current.slot>0){
        const row=(await profiles(env.MEMORY_DB,chat)).find(x=>x.slot===current!.slot)
        if(!row){await clearSession(env.MEMORY_DB,chat);await say(env,chat,'Saved voice missing. Retry /clone.');return true}
        fid=row.telegram_file_id;ref=row.ref_text;voiceName=row.name
      }
      if(!fid){await say(env,chat,'Reference audio missing. Retry /clone.');return true}
      await env.MEMORY_DB.prepare('INSERT OR IGNORE INTO qwen_clone_jobs (chat_id,source_message_id,telegram_file_id,ref_text,speech_text,lang,status) VALUES (?,?,?,?,?,?,\'pending\')')
        .bind(chat,msg.message_id,fid,ref||'',speechText,current.lang).run()
      const job=(await env.MEMORY_DB.prepare('SELECT id FROM qwen_clone_jobs WHERE chat_id=? AND source_message_id=?').bind(chat,msg.message_id).all<{id:number}>()).results[0]
      await clearSession(env.MEMORY_DB,chat)
      if(!job){await say(env,chat,'Could not prepare generation.');return true}
      await say(env,chat,'Ready to generate with '+voiceName+' ('+current.lang+').\nSpeech length: '+speechText.length+' characters ('+speechBytes+' UTF-8 bytes).\nPreview: '+speechText.slice(0,320)+
        '\n\nMVSEP decides what text length it can accept. Confirm to submit (credits may apply).',
        {inline_keyboard:[[{text:'Generate audio',callback_data:'qw:gen:'+job.id}],
          [{text:'Cancel',callback_data:'qw:drop:'+job.id}]]})
      return true
    }
    return false
  } catch(e){
    console.error('Qwen Telegram message failure',e instanceof Error?e.name:'unknown')
    await say(env,chat,'Could not process voice selection. Check Worker logs.').catch(()=>undefined)
    return true
  }
}
/** Own-chat callbacks only; requires answerCallbackQuery even on error. */
export async function handleVoiceCallback(env:VoiceEnv,cb:VoiceCallback):Promise<void>{
  const chat=String(cb.message?.chat.id||'')
  try {
    if(!cb.data?.startsWith('qw:') ||
       !await isAllowedTelegramUser(env,chat,String(cb.from.id),cb.message?.chat.type))return
    await init(env.MEMORY_DB)
    const data=cb.data
    const current=await session(env.MEMORY_DB,chat)
    if(data==='qw:cancel'){
      await clearSession(env.MEMORY_DB,chat)
      await say(env,chat,'Cancelled. Use /clone to start again.')
    }else if(data==='qw:empty'){
      await say(env,chat,'This slot is empty. Save a voice with /savevoice first.')
    }else if(data.startsWith('qw:slot:')){
      if(current?.state!=='select')throw new Error('Expired voice picker')
      const slot=Number(data.slice('qw:slot:'.length))
      const selected=(await profiles(env.MEMORY_DB,chat)).find(v=>v.slot===slot)
      if(!selected)throw new Error('Voice slot not found')
      await setSession(env.MEMORY_DB,chat,'target_text',slot,null,null,current.lang)
      await say(env,chat,'Selected: '+selected.name+'\nSend plain speech text (up to 4,096 characters per Telegram message). For longer scripts, send /tts_long, then multiple plain text messages, then /tts_done. No text files. MVSEP decides the actual limit. Language: '+current.lang)
    }else if(data==='qw:custom'){
      if(current?.state!=='select')throw new Error('Expired voice picker')
      await setSession(env.MEMORY_DB,chat,'custom_audio',null,null,null,current.lang)
      await say(env,chat,'Upload a 3–15 second reference voice or audio file (6 MB max).')
    }else if(data.startsWith('qw:gen:')||data.startsWith('qw:drop:')){
      const confirm=data.startsWith('qw:gen:')
      const id=Number(data.split(':')[2])
      if(!Number.isSafeInteger(id)||id<1)throw new Error('Invalid job')
      if(confirm&&!apiConfigured(env)){
        await say(env,chat,'MVSEP_API_TOKEN is missing. No job was submitted.')
      }else{
        const res=await env.MEMORY_DB.prepare(
          "UPDATE qwen_clone_jobs SET status=?,updated_at=unixepoch() WHERE id=? AND chat_id=? AND status='pending'"
        ).bind(confirm?'queued':'cancelled',id,chat).run()
        if(res.meta.changes===1)await say(env,chat,confirm?'MVSEP Qwen3-TTS job queued. Status will update automatically.':'Generation cancelled.')
        else await say(env,chat,'This request was already handled.')
      }
    }
  }catch(e){
    console.error('Qwen callback failure',e instanceof Error?e.message.slice(0,120):'unknown')
    if(await isAllowedTelegramUser(env,chat,String(cb.from.id),cb.message?.chat.type))
      await say(env,chat,'That selection expired or failed. Use /clone to start again.').catch(()=>undefined)
  }finally{
    await tg(env,'answerCallbackQuery',{callback_query_id:cb.id}).catch(()=>undefined)
  }
}
async function download(env:VoiceEnv,id:string):Promise<Blob>{
  const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/getFile?file_id='+encodeURIComponent(id),{signal:AbortSignal.timeout(20000)})
  const data=await r.json() as {ok?:boolean;result?:{file_path?:string;file_size?:number}}
  const path=data.result?.file_path||''
  if(!r.ok||!data.ok||!path||path.startsWith('/')||path.includes('..')||(data.result?.file_size||0)>LIMIT)
    throw new Error('Bad Telegram reference')
  const a=await fetch('https://api.telegram.org/file/bot'+env.TELEGRAM_BOT_TOKEN+'/'+
    path.split('/').map(encodeURIComponent).join('/'),{signal:AbortSignal.timeout(30000)})
  if(!a.ok||Number(a.headers.get('content-length')||0)>LIMIT)throw new Error('Bad reference download')
  const b=await a.blob()
  if(b.size<1||b.size>LIMIT)throw new Error('Audio size invalid')
  return b
}
/**
 * MVSEP Qwen3-TTS Voice Cloning, sep_type=120.
 * This path uses ONLY MVSEP_API_TOKEN; no Modal or GPU deployment is needed.
 * Once confirmed, jobs are claimed before submission. A timeout never retries
 * an uncertain paid request automatically.
 */
const MVSEP_API='https://sg.mvsep.com/api'
class MvsepSubmissionRejected extends Error {}
type MvsepResponse={
  success?:boolean;status?:string;error?:string;message?:string;
  data?:{hash?:string;link?:string;message?:string;current_order?:number;queue_count?:number;
    finished_chunks?:number;all_chunks?:number;files?:unknown}
}
function mvsepLink(raw:unknown):string|null{
  if(typeof raw!=='string')return null
  try{
    const u=new URL(raw)
    if(u.protocol==='https:' && (u.hostname==='mvsep.com' || u.hostname.endsWith('.mvsep.com')))return u.href
  }catch{}
  return null
}
function outputLinks(value:unknown):string[]{
  const links:string[]=[]
  const visit=(v:unknown,depth:number)=>{
    if(depth>4||links.length>6)return
    const url=mvsepLink(v)
    if(url){links.push(url);return}
    if(Array.isArray(v)){for(const x of v)visit(x,depth+1)}
    else if(v&&typeof v==='object'){
      for(const [key,x] of Object.entries(v)){
        if(['url','link','download','download_url','file','path','files','outputs'].includes(key))
          visit(x,depth+1)
        else if(typeof x==='object') visit(x,depth+1)
      }
    }
  }
  visit(value,0)
  return [...new Set(links)]
}
function voiceState(data:MvsepResponse):string{
  let status='Qwen3-TTS (MVSEP): '+(data.status||'unknown')
  if(typeof data.data?.current_order==='number')status+='\nQueue position: '+data.data.current_order
  if(typeof data.data?.queue_count==='number')status+='\nQueue length: '+data.data.queue_count
  if(typeof data.data?.finished_chunks==='number'&&typeof data.data?.all_chunks==='number')
    status+='\nChunks: '+data.data.finished_chunks+'/'+data.data.all_chunks
  if(data.status==='failed'&&data.data?.message)status+='\n'+data.data.message.slice(0,200)
  return status.slice(0,3000)
}
async function mvsepGet(hash:string):Promise<MvsepResponse>{
  const r=await fetch(MVSEP_API+'/separation/get?hash='+encodeURIComponent(hash),
    {signal:AbortSignal.timeout(18000)})
  if(!r.ok)throw new Error('MVSEP status HTTP '+r.status)
  return r.json() as Promise<MvsepResponse>
}
async function mvsepCreate(env:VoiceEnv,job:Job,blob:Blob):Promise<string>{
  const f=new FormData()
  f.set('api_token',env.MVSEP_API_TOKEN!)
  f.set('audiofile',blob,'reference.ogg')
  f.set('sep_type','120')
  f.set('add_opt1',job.speech_text)
  if(job.ref_text.trim())f.set('add_opt2',job.ref_text.trim())
  f.set('add_opt3',job.lang.toLowerCase())
  f.set('add_opt4','0')
  f.set('output_format','0')
  f.set('is_demo','0')
  const r=await fetch(MVSEP_API+'/separation/create',{method:'POST',body:f,
    signal:AbortSignal.timeout(90000)})
  const j=await r.json() as MvsepResponse
  if(!r.ok||!j.success||!j.data?.hash){
    const reason=String(j.data?.message||j.message||j.error||('HTTP '+r.status)).slice(0,240)
    // A definitive 4xx/explicit rejection with no task hash did not create a paid job.
    // Timeouts and unclear server failures still remain submit-uncertain.
    if(!j.data?.hash && ((r.status>=400&&r.status<500)||j.success===false))
      throw new MvsepSubmissionRejected(reason)
    throw new Error('MVSEP task acceptance uncertain: '+reason)
  }
  return j.data.hash
}
async function statusMessage(env:VoiceEnv,chat:string,id:number,text:string){
  if(id>0){
    try{
      await tg(env,'editMessageText',{chat_id:chat,message_id:id,text:text.slice(0,3900),
        disable_web_page_preview:true})
      return
    }catch(e){console.error('TTS status edit failed',e instanceof Error?e.name:'unknown')}
  }
  await say(env,chat,text)
}
export async function processQwenVoiceJobs(env:VoiceEnv):Promise<void>{
  if(!apiConfigured(env))return
  await init(env.MEMORY_DB)
  // Always poll previously accepted requests before creating a new paid request.
  const rows=await env.MEMORY_DB.prepare(
    "SELECT j.id,j.chat_id,t.hash,t.status_message_id,t.last_label FROM qwen_clone_jobs j "+
    "JOIN mvsep_tts_tracking t ON t.job_id=j.id "+
    "WHERE j.status IN ('waiting','processing','distributing','merging') AND t.checked_at < unixepoch()-35 "+
    "ORDER BY t.checked_at ASC LIMIT 4"
  ).bind().all<{id:number;chat_id:string;hash:string;status_message_id:number;last_label:string}>()
  for(const active of rows.results){
    try{
      const state=await mvsepGet(active.hash)
      const stage=state.status||'unknown'
      const label=voiceState(state)+'\nJob: '+active.id
      await env.MEMORY_DB.prepare(
        'UPDATE mvsep_tts_tracking SET checked_at=unixepoch(), last_label=? WHERE job_id=?'
      ).bind(label,active.id).run()
      if(label!==active.last_label) await statusMessage(env,active.chat_id,active.status_message_id,label)
      if(['waiting','processing','distributing','merging'].includes(stage)){
        await env.MEMORY_DB.prepare('UPDATE qwen_clone_jobs SET status=?,updated_at=unixepoch() WHERE id=?')
          .bind(stage,active.id).run()
      }else if(stage==='done'){
        // Mark as delivering BEFORE sending to Telegram to prevent duplicate deliveries.
        const claimed=await env.MEMORY_DB.prepare(
          "UPDATE qwen_clone_jobs SET status='delivering',updated_at=unixepoch() WHERE id=? AND status IN ('waiting','processing','distributing','merging')"
        ).bind(active.id).run()
        if(claimed.meta.changes!==1)continue
        const files=outputLinks(state.data?.files)
        const fallback=mvsepLink(state.data?.link)
        try{
          if(files.length){
            const url=files[0]
            // Telegram fetches an HTTPS MVSEP file URL directly (no large Worker uploads).
            const sent=await tg(env,'sendAudio',{
              chat_id:active.chat_id,audio:url,
              caption:'Qwen3-TTS generated audio #'+active.id
            })
            if(!sent)throw new Error('No Telegram response')
          }else if(fallback){
            await say(env,active.chat_id,'Qwen3-TTS completed. Download: '+fallback)
          }else{
            await say(env,active.chat_id,'Qwen3-TTS completed, but no download link was returned. Check MVSEP job '+active.hash)
          }
          await env.MEMORY_DB.prepare("UPDATE qwen_clone_jobs SET status='done',updated_at=unixepoch() WHERE id=?")
            .bind(active.id).run()
        }catch{
          await env.MEMORY_DB.prepare("UPDATE qwen_clone_jobs SET status='delivery-failed',updated_at=unixepoch() WHERE id=?")
            .bind(active.id).run()
          await say(env,active.chat_id,'Audio is ready, but Telegram delivery failed. MVSEP result: '+(fallback||files[0]||active.hash)).catch(()=>undefined)
        }
      }else if(['failed','not_found'].includes(stage)){
        await env.MEMORY_DB.prepare('UPDATE qwen_clone_jobs SET status=?,updated_at=unixepoch() WHERE id=?')
          .bind(stage,active.id).run()
      }
    }catch(e){
      console.error('MVSEP TTS polling failed',e instanceof Error?e.message.slice(0,100):'unknown')
      await env.MEMORY_DB.prepare('UPDATE mvsep_tts_tracking SET checked_at=unixepoch() WHERE job_id=?')
        .bind(active.id).run()
    }
  }
  // Submit at most one confirmed task, and never automatically retry timeouts.
  const found=await env.MEMORY_DB.prepare(
    "SELECT id,chat_id,telegram_file_id,ref_text,lang,speech_text FROM qwen_clone_jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1"
  ).bind().all<Job>()
  const job=found.results[0]
  if(!job)return
  const claimed=await env.MEMORY_DB.prepare(
    "UPDATE qwen_clone_jobs SET status='submitting',updated_at=unixepoch() WHERE id=? AND status='queued'"
  ).bind(job.id).run()
  if(claimed.meta.changes!==1)return
  let id=0
  try{
    const result=await tg(env,'sendMessage',{chat_id:job.chat_id,text:'Qwen3-TTS #'+job.id+': uploading reference to MVSEP...'})
    id=Number(result.message_id||0)
    const blob=await download(env,job.telegram_file_id)
    const hash=await mvsepCreate(env,job,blob)
    await env.MEMORY_DB.prepare(
      'INSERT OR REPLACE INTO mvsep_tts_tracking(job_id,hash,status_message_id,last_label,checked_at) VALUES (?,?,?,?,0)'
    ).bind(job.id,hash,id,'').run()
    await env.MEMORY_DB.prepare(
      "UPDATE qwen_clone_jobs SET status='waiting',updated_at=unixepoch() WHERE id=?"
    ).bind(job.id).run()
    await statusMessage(env,job.chat_id,id,'Qwen3-TTS submitted to MVSEP.\nJob: '+job.id+'\nTracking automatically every minute.')
  }catch(e){
    const rejected=e instanceof MvsepSubmissionRejected
    console.error(rejected?'MVSEP TTS input rejected:':'MVSEP TTS submission uncertain:',
      e instanceof Error?e.message.slice(0,140):'unknown')
    await env.MEMORY_DB.prepare(
      "UPDATE qwen_clone_jobs SET status=?,updated_at=unixepoch() WHERE id=?"
    ).bind(rejected?'rejected':'submit-uncertain',job.id).run()
    await statusMessage(env,job.chat_id,id,rejected
      ?'MVSEP did not accept this request: '+(e as Error).message.slice(0,200)+
        '\nMVSEP determines the supported text length. Try a shorter speech passage with /clone.'
      :'Qwen3-TTS submission failed or timed out. No automatic resubmission, to avoid duplicate charges. Check MVSEP history.'
    ).catch(()=>undefined)
  }
}

/**
 * Text-only context for the existing Cloudflare AI assistant.
 * It can reason about available voice slots and current wizard state.
 * Never include file IDs, audio, tokens, reference transcripts or user speech text.
 */
export async function voiceAssistantContext(env:VoiceEnv,chat:string):Promise<string>{
  try{
    await init(env.MEMORY_DB)
    const [data,active,job]=await Promise.all([
      profiles(env.MEMORY_DB,chat),
      session(env.MEMORY_DB,chat),
      env.MEMORY_DB.prepare(
        'SELECT id,status FROM qwen_clone_jobs WHERE chat_id=? ORDER BY id DESC LIMIT 1'
      ).bind(chat).all<{id:number;status:string}>()
    ])
    let latestWanStatus='unavailable'
    let latestMvsepStatus='unavailable'
    try{
      const records=await env.MEMORY_DB.prepare(
        'SELECT status FROM wan_video_jobs WHERE chat_id=? ORDER BY created_at DESC LIMIT 1'
      ).bind(chat).all<{status:string}>()
      latestWanStatus=records.results[0]?.status||'none'
    }catch{ /* WAN job table optional during initial setup */ }
    try{
      const records=await env.MEMORY_DB.prepare(
        'SELECT status FROM mvsep_live_jobs WHERE chat_id=? ORDER BY created_at DESC LIMIT 1'
      ).bind(chat).all<{status:string}>()
      latestMvsepStatus=records.results[0]?.status||'none'
    }catch{ /* MVSEP table optional until first separation */ }
    const safeName=(name:string)=>name.replace(/[\r\n<>]/g,' ').slice(0,48)
    return JSON.stringify({
      saved_voice_slots:Array.from({length:5},(_,i)=>({
        slot:i+1,
        name:safeName(data.find(x=>x.slot===i+1)?.name||''),
        configured:Boolean(data.find(x=>x.slot===i+1))
      })),
      current_voice_step:active?.state||'none',
      current_voice_slot:active?.slot||null,
      chosen_language:active?.lang||'English',
      latest_voice_job:job.results[0]||null,
      latest_wan_job_status:latestWanStatus,
      latest_mvsep_job_status:latestMvsepStatus,
      mvsep_qwen_enabled:apiConfigured(env),
      mvsep_token_configured:Boolean((env as VoiceEnv & { MVSEP_API_TOKEN?:string }).MVSEP_API_TOKEN),
      last_updated:'live database snapshot'
    })
  }catch(e){
    console.error('Qwen assistant context error:',e instanceof Error?e.name:'unknown')
    return '{"status":"voice database context unavailable"}'
  }
}
