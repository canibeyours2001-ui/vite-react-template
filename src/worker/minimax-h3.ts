/**
 * MiniMax-H3 (Video Generation V2) opt-in Telegram connector.
 * This is a billed API: never submit without MINIMAX_API_KEY and explicit /h3 command.
 * Secrets never go to Telegram. No retry on ambiguous submissions.
 */
type DB = {prepare(q:string):{bind(...a:(string|number)[]):{run():Promise<{meta:{changes:number}}>;all<T>():Promise<{results:T[]}>}}}
export type H3Env = {MEMORY_DB:DB;TELEGRAM_BOT_TOKEN:string;MINIMAX_API_KEY?:string}
type Media={file_id:string;file_size?:number;mime_type?:string}
type Msg={message_id:number;photo?:Media[];document?:Media;reply_to_message?:{photo?:Media[];document?:Media}}
type Job={id:string;chat_id:string;message_id:number;file_id:string;prompt:string;duration:number;task_id:string;status:string;error:string;created_at:number}
const API='https://api.minimax.io'
const MAX_IMAGE=5*1024*1024
const compact=(x:unknown,n=350)=>String(x??'').replace(/[\u0000-\u001f<>]/g,' ').slice(0,n)
const ts=()=>Math.floor(Date.now()/1000)
const headers=(env:H3Env)=>({Authorization:'Bearer '+env.MINIMAX_API_KEY,'Content-Type':'application/json'})
async function say(env:H3Env,chat:string,text:string){
  const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/sendMessage',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chat,text:compact(text,3900)}),
    signal:AbortSignal.timeout(15000)
  })
  if(!r.ok)throw new Error('Telegram sendMessage HTTP '+r.status)
}
async function init(env:H3Env){
  await env.MEMORY_DB.prepare("CREATE TABLE IF NOT EXISTS minimax_h3_jobs (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, file_id TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL, duration INTEGER NOT NULL DEFAULT 10, task_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE(chat_id,message_id))").bind().run()
}
export async function handleH3Command(env:H3Env,msg:Msg,chat:string,raw:string):Promise<boolean>{
  const text=raw.trim()
  if(/^\/h3_status(?:@\w+)?$/i.test(text)){
    await init(env)
    const jobs=await env.MEMORY_DB.prepare('SELECT status,error,duration FROM minimax_h3_jobs WHERE chat_id=? ORDER BY created_at DESC LIMIT 1').bind(chat).all<{status:string;error:string;duration:number}>()
    const j=jobs.results[0]
    await say(env,chat,j?'MiniMax-H3: '+j.status+' ('+j.duration+'s)'+(j.error?' — '+compact(j.error,180):''):'No MiniMax-H3 jobs yet.')
    return true
  }
  const match=/^\/h3(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text)
  if(!match)return false
  if(!env.MINIMAX_API_KEY){
    await say(env,chat,'MiniMax-H3 uses the paid MiniMax API, not free HF ZeroGPU. Add a Pay-as-you-go/Credit API key as the Cloudflare Worker secret MINIMAX_API_KEY. No paid request was sent.')
    return true
  }
  let input=(match[1]||'').trim(),duration=10
  const leading=/^(\d+)(?:s)?\s+([\s\S]+)$/i.exec(input)
  if(leading){duration=Number(leading[1]);input=leading[2].trim()}
  const media=msg.photo?.at(-1)||(msg.document&&/^image\/(jpeg|png|webp)$/.test(msg.document.mime_type||'')?msg.document:undefined)
    ||msg.reply_to_message?.photo?.at(-1)||(msg.reply_to_message?.document&&/^image\/(jpeg|png|webp)$/.test(msg.reply_to_message.document.mime_type||'')?msg.reply_to_message.document:undefined)
  if(!input){
    await say(env,chat,'MiniMax-H3 (paid API): /h3 10 your prompt (text-to-video), or send/reply to a photo with /h3 15 your prompt (image-to-video). Choose 4–15 seconds. /h3_status shows progress. Explicit /h3 submissions can incur MiniMax charges.')
    return true
  }
  if(!Number.isInteger(duration)||duration<4||duration>15||input.length>7000||Number(media?.file_size||0)>MAX_IMAGE){
    await say(env,chat,'Choose an integer 4–15 seconds, a prompt under 7000 characters and an image up to 5 MB.')
    return true
  }
  await init(env)
  const r=await env.MEMORY_DB.prepare("INSERT OR IGNORE INTO minimax_h3_jobs (id,chat_id,message_id,file_id,prompt,duration,status) VALUES (?,?,?,?,?,?,'queued')").bind(crypto.randomUUID(),chat,msg.message_id,media?.file_id||'',input,duration).run()
  if(r.meta.changes===1)await say(env,chat,'MiniMax-H3 '+duration+'s generation queued (paid provider). One submission only; /h3_status to check. No automatic paid retry.')
  return true
}
async function fail(env:H3Env,j:Job,status:string,error:string){
  await env.MEMORY_DB.prepare('UPDATE minimax_h3_jobs SET status=?,error=?,updated_at=unixepoch() WHERE id=?').bind(status,compact(error,250),j.id).run()
  await say(env,j.chat_id,'MiniMax-H3 '+status+': '+compact(error,160)).catch(()=>{})
}
async function imageData(env:H3Env,fileId:string){
  const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/getFile?file_id='+encodeURIComponent(fileId),{signal:AbortSignal.timeout(10000)})
  const v=await r.json() as {ok?:boolean;result?:{file_path?:string;file_size?:number}}
  if(!r.ok||!v.ok||!v.result?.file_path||Number(v.result.file_size||0)>MAX_IMAGE)throw new Error('Telegram image unavailable or >5 MB')
  const p=await fetch('https://api.telegram.org/file/bot'+env.TELEGRAM_BOT_TOKEN+'/'+v.result.file_path,{signal:AbortSignal.timeout(15000)})
  if(!p.ok)throw new Error('Image download HTTP '+p.status)
  const bytes=new Uint8Array(await p.arrayBuffer())
  if(!bytes.byteLength||bytes.byteLength>MAX_IMAGE)throw new Error('Image exceeds 5 MB')
  const mime=(p.headers.get('content-type')||'').split(';')[0]
  const type=['image/jpeg','image/png','image/webp'].includes(mime)?mime:'image/jpeg'
  let binary=''
  for(let i=0;i<bytes.byteLength;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384))
  return 'data:'+type+';base64,'+btoa(binary)
}
async function submit(env:H3Env,j:Job){
  const claim=await env.MEMORY_DB.prepare("UPDATE minimax_h3_jobs SET status='submitting',updated_at=unixepoch() WHERE id=? AND status='queued'").bind(j.id).run()
  if(claim.meta.changes!==1)return
  let attempted=false
  try{
    if(!env.MINIMAX_API_KEY)throw new Error('MINIMAX_API_KEY unavailable')
    const content:Array<Record<string,unknown>>=[{type:'text',text:j.prompt}]
    if(j.file_id)content.push({type:'image_url',image_url:{url:await imageData(env,j.file_id)},role:'first_frame'})
    const body={model:'MiniMax-H3',content,resolution:'2K',duration:j.duration,ratio:j.file_id?'adaptive':'16:9'}
    attempted=true
    const response=await fetch(API+'/v2/video_generation',{method:'POST',headers:headers(env),body:JSON.stringify(body),signal:AbortSignal.timeout(25000)})
    const json=await response.json() as {task_id?:unknown;error?:{message?:string}}
    if(!response.ok){attempted=false;throw new Error('MiniMax API HTTP '+response.status+': '+compact(json.error?.message,150))}
    if(typeof json.task_id!=='string'||!/^\d{6,30}$/.test(json.task_id))throw new Error('MiniMax task response missing valid task_id')
    await env.MEMORY_DB.prepare("UPDATE minimax_h3_jobs SET status='running',task_id=?,updated_at=unixepoch() WHERE id=?").bind(json.task_id,j.id).run()
    await say(env,j.chat_id,'MiniMax-H3 accepted '+j.duration+'s video generation; /h3_status tracks it.').catch(()=>{})
  }catch(e){await fail(env,j,attempted?'uncertain':'failed',attempted?'Paid submission outcome unknown. No automatic retry.':e instanceof Error?e.message:'Failed before submission')}
}
function usableVideoUrl(input:unknown){
  if(typeof input!=='string'||input.length>2000)return ''
  try{
    const u=new URL(input)
    if(u.protocol!=='https:'||u.username||u.password||u.hostname==='localhost'||/^(?:\d{1,3}\.){3}\d{1,3}$/.test(u.hostname)||u.hostname.endsWith('.local'))return ''
    return u.toString()
  }catch{return ''}
}
async function deliver(env:H3Env,j:Job,url:string){
  const claim=await env.MEMORY_DB.prepare("UPDATE minimax_h3_jobs SET status='delivering',updated_at=unixepoch() WHERE id=? AND status='running'").bind(j.id).run()
  if(claim.meta.changes!==1)return
  try{
    const form=new FormData()
    form.set('chat_id',j.chat_id)
    form.set('video',url)
    form.set('caption','MiniMax-H3 • '+j.duration+'s • native audio where produced')
    const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/sendVideo',{method:'POST',body:form,signal:AbortSignal.timeout(30000)})
    if(!r.ok){
      // Video may exceed Telegram URL-fetch limits; provide the HTTPS result link.
      await say(env,j.chat_id,'MiniMax-H3 finished ('+j.duration+'s), but Telegram could not attach the 2K video. Open your result: '+url)
    }
    await env.MEMORY_DB.prepare("UPDATE minimax_h3_jobs SET status='done',updated_at=unixepoch() WHERE id=?").bind(j.id).run()
  }catch(e){await fail(env,j,'delivery-failed',e instanceof Error?e.message:'Telegram delivery failed')}
}
async function poll(env:H3Env,j:Job){
  if(ts()-j.created_at>3*3600){await fail(env,j,'expired','Job expired after 3 hours');return}
  if(!/^\d{6,30}$/.test(j.task_id))return
  try{
    const r=await fetch(API+'/v2/query/video_generation/'+j.task_id,{headers:headers(env),signal:AbortSignal.timeout(16000)})
    if(!r.ok){if(r.status===404)await fail(env,j,'failed','MiniMax task was not found');return}
    const json=await r.json() as {task?:{status?:string;content?:{url?:string};error?:{message?:string}}}
    const task=json.task
    if(task?.status==='succeeded'){
      const url=usableVideoUrl(task.content?.url)
      if(url)await deliver(env,j,url)
      else await fail(env,j,'delivery-failed','Completed task missing usable HTTPS video URL')
    }else if(['failed','cancelled','expired'].includes(task?.status||''))await fail(env,j,task?.status||'failed',compact(task?.error?.message||'Provider reported failure',150))
  }catch{/* Status polling retries next cron; never resubmit a paid task. */}
}
export async function pollH3Jobs(env:H3Env){
  if(!env.MINIMAX_API_KEY||!env.TELEGRAM_BOT_TOKEN||!env.MEMORY_DB)return
  await init(env)
  const active=await env.MEMORY_DB.prepare("SELECT * FROM minimax_h3_jobs WHERE status='running' ORDER BY created_at ASC LIMIT 3").bind().all<Job>()
  for(const j of active.results)await poll(env,j)
  const queued=await env.MEMORY_DB.prepare("SELECT * FROM minimax_h3_jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1").bind().all<Job>()
  if(queued.results[0])await submit(env,queued.results[0])
}
