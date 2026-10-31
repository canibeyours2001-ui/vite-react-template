
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
  QWEN_TTS_API_BASE?: string
  QWEN_TTS_API_KEY?: string
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
export type VoiceCallback = { id:string; data?:string; from:{id:number}; message?:{chat:{id:number};message_id:number} }
type Profile={slot:number;name:string;telegram_file_id:string;ref_text:string}
type Session={state:string;slot:number|null;custom_file_id:string|null;custom_ref_text:string|null;lang:string}
type Job={id:number;chat_id:string;telegram_file_id:string;ref_text:string;lang:string;speech_text:string}
const LIMIT=6*1024*1024
const LANGUAGES=new Set(['Auto','English','Chinese','Japanese','Korean','German','French','Russian','Portuguese','Spanish','Italian'])
const help='Voice cloning:\n/savevoice 1 Narrator | exact reference transcript (as a reply to a voice recording)\n/voices — show your 5 saved slots\n/clone — choose a saved voice or upload custom\n/clonelang English — set speech language\n/cancel — stop\nOnly use your own voice or voices you have permission to clone.'
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
  await db.prepare('CREATE TABLE IF NOT EXISTS qwen_clone_sessions (chat_id TEXT PRIMARY KEY, state TEXT NOT NULL, slot INTEGER, custom_file_id TEXT, custom_ref_text TEXT, lang TEXT NOT NULL DEFAULT \'English\', updated_at INTEGER NOT NULL DEFAULT (unixepoch()))').bind().run()
  await db.prepare('CREATE TABLE IF NOT EXISTS qwen_clone_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, source_message_id INTEGER NOT NULL, telegram_file_id TEXT NOT NULL, ref_text TEXT NOT NULL, speech_text TEXT NOT NULL, lang TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'pending\', created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE(chat_id,source_message_id))').bind().run()
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
  return Boolean(env.QWEN_TTS_API_BASE&&env.QWEN_TTS_API_KEY)
}
/** Returns true for an intercepted voice command or active clone session. */
export async function handleVoiceMessage(env:VoiceEnv,msg:VoiceMessage,chat:string,content:string):Promise<boolean>{
  const [commandRaw]=content.trim().split(/\s+/,1)
  const cmd=(commandRaw||'').split('@')[0].toLowerCase()
  const recognized=['/savevoice','/voices','/clone','/clone_help','/cancel','/clonelang'].includes(cmd)
  let current:Session|null=null
  if(!recognized&&!inboundFile(msg)&&!content.trim())return false
  try {
    await init(env.MEMORY_DB)
    current=await session(env.MEMORY_DB,chat)
    if(!recognized&&!current)return false
    if(cmd==='/clone_help'){await say(env,chat,help);return true}
    if(cmd==='/cancel'){await clearSession(env.MEMORY_DB,chat);await say(env,chat,'Voice cloning cancelled.');return true}
    if(cmd==='/voices'){
      const data=await profiles(env.MEMORY_DB,chat)
      await say(env,chat,'Saved voice profiles:\n'+Array.from({length:5},(_,i)=>{
        const v=data.find(x=>x.slot===i+1)
        return (i+1)+'. '+(v?v.name:'Empty')
      }).join('\n')+'\n\nAdd or update: reply to a reference recording with /savevoice SLOT NAME | exact transcript.')
      return true
    }
    if(cmd==='/savevoice'){
      const rest=content.replace(/^\/savevoice(?:@\w+)?\s*/i,'')
      const m=rest.match(/^([1-5])\s+([^|\n]{1,50})\s*\|\s*(.{1,1000})$/s)
      const ref=selectedFile(msg)
      if(!m||!ref||!usableFile(ref)){
        await say(env,chat,'Reply to a 3–15 sec reference audio/voice with:\n/savevoice 1 Narrator | the exact spoken words')
        return true
      }
      await env.MEMORY_DB.prepare('INSERT INTO qwen_voice_profiles (chat_id,slot,name,telegram_file_id,ref_text) VALUES (?,?,?,?,?) ON CONFLICT(chat_id,slot) DO UPDATE SET name=excluded.name,telegram_file_id=excluded.telegram_file_id,ref_text=excluded.ref_text,updated_at=unixepoch()')
        .bind(chat,Number(m[1]),m[2].trim(),ref.file_id,m[3].trim()).run()
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
      await setSession(env.MEMORY_DB,chat,'select',null,null,null,current?.lang||'English')
      await say(env,chat,'Choose a saved voice or upload a custom recording:',voiceButtons(data))
      return true
    }
    if(!current||current.state==='select'||current.state==='idle')return false
    const text=content.trim()
    if(current.state==='custom_audio'){
      const ref=inboundFile(msg)
      if(!ref||!usableFile(ref)){await say(env,chat,'Please send an audio file or voice message (up to 6 MB).');return true}
      await setSession(env.MEMORY_DB,chat,'custom_transcript',null,ref.file_id,null,current.lang)
      await say(env,chat,'Now type the EXACT words spoken in your reference recording.')
      return true
    }
    if(current.state==='custom_transcript'){
      if(!text||text.length>1000){await say(env,chat,'Send the reference transcript (1–1000 characters).');return true}
      await setSession(env.MEMORY_DB,chat,'target_text',null,current.custom_file_id,text,current.lang)
      await say(env,chat,'Reference transcript saved. Now send the NEW text you want the voice to speak. Max 1000 characters.')
      return true
    }
    if(current.state==='target_text'){
      if(!text||text.length>1000){await say(env,chat,'Send target speech text (1–1000 characters).');return true}
      let fid=current.custom_file_id,ref=current.custom_ref_text,voiceName='Custom upload'
      if(current.slot&&current.slot>0){
        const row=(await profiles(env.MEMORY_DB,chat)).find(x=>x.slot===current!.slot)
        if(!row){await clearSession(env.MEMORY_DB,chat);await say(env,chat,'Saved voice missing. Retry /clone.');return true}
        fid=row.telegram_file_id;ref=row.ref_text;voiceName=row.name
      }
      if(!fid||!ref){await say(env,chat,'Reference audio or transcript missing. Retry /clone.');return true}
      await env.MEMORY_DB.prepare('INSERT OR IGNORE INTO qwen_clone_jobs (chat_id,source_message_id,telegram_file_id,ref_text,speech_text,lang,status) VALUES (?,?,?,?,?,?,\'pending\')')
        .bind(chat,msg.message_id,fid,ref,text,current.lang).run()
      const job=(await env.MEMORY_DB.prepare('SELECT id FROM qwen_clone_jobs WHERE chat_id=? AND source_message_id=?').bind(chat,msg.message_id).all<{id:number}>()).results[0]
      await clearSession(env.MEMORY_DB,chat)
      if(!job){await say(env,chat,'Could not prepare generation.');return true}
      await say(env,chat,'Ready to generate with '+voiceName+' ('+current.lang+').\nText: '+text.slice(0,320)+
        '\n\nConfirm to start GPU inference (charges may apply).',
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
    if(!chat||chat!==env.TELEGRAM_CHAT_ID||!cb.data?.startsWith('qw:'))return
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
      await say(env,chat,'Selected: '+selected.name+'\nSend the text you want this voice to speak. Language: '+current.lang)
    }else if(data==='qw:custom'){
      if(current?.state!=='select')throw new Error('Expired voice picker')
      await setSession(env.MEMORY_DB,chat,'custom_audio',null,null,null,current.lang)
      await say(env,chat,'Upload a 3–15 second reference voice or audio file (6 MB max).')
    }else if(data.startsWith('qw:gen:')||data.startsWith('qw:drop:')){
      const confirm=data.startsWith('qw:gen:')
      const id=Number(data.split(':')[2])
      if(!Number.isSafeInteger(id)||id<1)throw new Error('Invalid job')
      if(confirm&&!apiConfigured(env)){
        await say(env,chat,'Your voice and text are ready, but Qwen Modal GPU endpoint is not configured yet. No generation has started or been billed.')
      }else{
        const res=await env.MEMORY_DB.prepare(
          "UPDATE qwen_clone_jobs SET status=?,updated_at=unixepoch() WHERE id=? AND chat_id=? AND status='pending'"
        ).bind(confirm?'queued':'cancelled',id,chat).run()
        if(res.meta.changes===1)await say(env,chat,confirm?'Audio generation queued. The bot will deliver the WAV when ready.':'Generation cancelled.')
        else await say(env,chat,'This request was already handled.')
      }
    }
  }catch(e){
    console.error('Qwen callback failure',e instanceof Error?e.message.slice(0,120):'unknown')
    if(chat===env.TELEGRAM_CHAT_ID)await say(env,chat,'That selection expired or failed. Use /clone to start again.').catch(()=>undefined)
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
/** Performs at most one explicit-confirmed generation per scheduled invocation.
 * Claims pending request before sending to GPU, no automatic retry if uncertain.
 */
export async function processQwenVoiceJobs(env:VoiceEnv):Promise<void>{
  if(!apiConfigured(env))return
  const url=new URL(env.QWEN_TTS_API_BASE!)
  if(url.protocol!=='https:'||!url.hostname.endsWith('.modal.run')||url.pathname!=='/'||
    url.search||url.hash||url.username||url.password)return
  await init(env.MEMORY_DB)
  const found=await env.MEMORY_DB.prepare(
    "SELECT id,chat_id,telegram_file_id,ref_text,lang,speech_text FROM qwen_clone_jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1"
  ).bind().all<Job>()
  const job=found.results[0]
  if(!job)return
  const claim=await env.MEMORY_DB.prepare("UPDATE qwen_clone_jobs SET status='running',updated_at=unixepoch() WHERE id=? AND status='queued'").bind(job.id).run()
  if(claim.meta.changes!==1)return
  try{
    await say(env,job.chat_id,'Qwen voice job #'+job.id+': preparing audio.')
    const file=await download(env,job.telegram_file_id)
    const f=new FormData()
    f.set('ref_audio',file,'reference.ogg')
    f.set('ref_text',job.ref_text)
    f.set('text',job.speech_text)
    f.set('language',job.lang)
    await say(env,job.chat_id,'Qwen voice job #'+job.id+': generating speech.')
    const r=await fetch(url.origin+'/v1/clone',{method:'POST',
      headers:{Authorization:'Bearer '+env.QWEN_TTS_API_KEY},body:f,signal:AbortSignal.timeout(240000)})
    if(!r.ok)throw new Error('GPU HTTP '+r.status)
    const audio=await r.blob()
    if(audio.size<44||audio.size>45*1024*1024)throw new Error('Invalid generated WAV size')
    const form=new FormData()
    form.set('chat_id',job.chat_id)
    form.set('caption','Qwen3-TTS voice clone #'+job.id)
    form.set('audio',audio,'qwen-voice-'+job.id+'.wav')
    const delivered=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/sendAudio',{
      method:'POST',body:form,signal:AbortSignal.timeout(60000)})
    if(!delivered.ok)throw new Error('Telegram output HTTP '+delivered.status)
    await env.MEMORY_DB.prepare("UPDATE qwen_clone_jobs SET status='done',updated_at=unixepoch() WHERE id=?").bind(job.id).run()
  }catch(e){
    console.error('Qwen voice job #'+job.id+' failed:',e instanceof Error?e.message.slice(0,120):'unknown')
    await env.MEMORY_DB.prepare("UPDATE qwen_clone_jobs SET status='failed',updated_at=unixepoch() WHERE id=?").bind(job.id).run()
    await say(env,job.chat_id,'Qwen voice job #'+job.id+' failed. No automatic retry, to avoid duplicate GPU charges.').catch(()=>undefined)
  }
}
