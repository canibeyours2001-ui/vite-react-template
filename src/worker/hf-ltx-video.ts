/**
 * Optional LTX-2.5 ZeroGPU image-to-video (+native synchronized audio) integration.
 * Explicit /ltx command only. Never alters existing Wan or dubbing workflows.
 * One-shot submission: an ambiguous network result is never retried automatically.
 */
type DB = {prepare(q:string):{bind(...a:(string|number)[]):{run():Promise<{meta:{changes:number}}>;all<T>():Promise<{results:T[]}>}}}
export type LtxEnv={MEMORY_DB:DB;TELEGRAM_BOT_TOKEN:string;HUGGINGFACE_API_TOKEN?:string}
type Media={file_id:string;file_size?:number;mime_type?:string}
type Msg={message_id:number;photo?:Media[];document?:Media;reply_to_message?:{photo?:Media[];document?:Media}}
type Job={id:string;chat_id:string;message_id:number;file_id:string;prompt:string;status:string;event_id:string;created_at:number;error:string}
const SPACE='https://lightricks-ltx-2-5.hf.space'
const ENDPOINT='/run'
const MAX_IMAGE=5*1024*1024
const MAX_VIDEO=44*1024*1024
const short=(v:unknown,n=250)=>String(v??'').replace(/[\u0000-\u001f<>]/g,' ').slice(0,n)
const auth=(env:LtxEnv)=>({Authorization:'Bearer '+env.HUGGINGFACE_API_TOKEN})
const now=()=>Math.floor(Date.now()/1000)
async function send(env:LtxEnv,chat:string,message:string) {
  const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/sendMessage',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chat,text:short(message,3900)}),signal:AbortSignal.timeout(18000)
  })
  if(!r.ok)throw new Error('Telegram message HTTP '+r.status)
}
async function init(env:LtxEnv){
  await env.MEMORY_DB.prepare("CREATE TABLE IF NOT EXISTS hf_ltx25_jobs (id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,message_id INTEGER NOT NULL,file_id TEXT NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL,event_id TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL DEFAULT (unixepoch()),updated_at INTEGER NOT NULL DEFAULT (unixepoch()),UNIQUE(chat_id,message_id))").bind().run()
}
async function status(env:LtxEnv,chat:string){
  await init(env)
  const x=await env.MEMORY_DB.prepare('SELECT status,error,created_at FROM hf_ltx25_jobs WHERE chat_id=? ORDER BY created_at DESC LIMIT 1').bind(chat).all<{status:string;error:string;created_at:number}>()
  const j=x.results[0]
  await send(env,chat,j?'LTX-2.5: '+j.status+(j.error?' — '+short(j.error,130):''):'No LTX-2.5 video job yet.')
}
export async function handleLtxCommand(env:LtxEnv,msg:Msg,chat:string,rawText:string):Promise<boolean>{
  const text=rawText.trim()
  if(/^\/ltx_status(?:@\w+)?$/i.test(text)){await status(env,chat);return true}
  if(/^\/ltxprobe(?:@\w+)?$/i.test(text)){
    try{
      const r=await fetch(SPACE+'/gradio_api/info',{signal:AbortSignal.timeout(10000)})
      if(!r.ok)throw new Error('HTTP '+r.status)
      const j=await r.json() as {named_endpoints?:Record<string,unknown>}
      await send(env,chat,j.named_endpoints?.[ENDPOINT]?'LTX-2.5 public Gradio image-to-video API: online. Generation still depends on your ZeroGPU quota and queue.':'LTX-2.5 Space is up but the image-to-video API has changed. No generation submitted.')
    }catch{await send(env,chat,'LTX-2.5 Space is unavailable. No GPU quota was used.')}
    return true
  }
  const m=/^\/ltx(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text)
  if(!m)return false
  const prompt=(m[1]||'').trim()
  const media=msg.photo?.at(-1)||
    (msg.document&&/^image\/(jpeg|png|webp)$/.test(msg.document.mime_type||'')?msg.document:undefined)||
    msg.reply_to_message?.photo?.at(-1)||
    (msg.reply_to_message?.document&&/^image\/(jpeg|png|webp)$/.test(msg.reply_to_message.document.mime_type||'')?msg.reply_to_message.document:undefined)
  if(!prompt||!media){
    await send(env,chat,'LTX-2.5 with synchronized sound: attach a photo with caption /ltx your scene and audio prompt, or reply to a photo with /ltx your prompt. Use /ltxprobe to check the free Space; /ltx_status checks jobs. Default: 2 seconds, 512×512, Fast. A failed GPU run may still consume your daily HF ZeroGPU minutes.')
    return true
  }
  if(!env.HUGGINGFACE_API_TOKEN){await send(env,chat,'Hugging Face API token is not configured. No job started.');return true}
  if(prompt.length>1000||prompt.length<4||Number(media.file_size||0)>MAX_IMAGE){
    await send(env,chat,'Use a 4–1000 character prompt and a photo of 5 MB or less.');return true
  }
  await init(env)
  const r=await env.MEMORY_DB.prepare("INSERT OR IGNORE INTO hf_ltx25_jobs (id,chat_id,message_id,file_id,prompt,status) VALUES (?,?,?,?,?,'queued')").bind(crypto.randomUUID(),chat,msg.message_id,media.file_id,prompt).run()
  if(r.meta.changes===1)await send(env,chat,'LTX-2.5 image-to-video with synchronized audio queued. Uses HF ZeroGPU quota (not Inference Providers). One generation attempt only; no automatic retry if the outcome is uncertain. Check /ltx_status.')
  return true
}
async function fail(env:LtxEnv,j:Job,reason:string,state='failed'){
  await env.MEMORY_DB.prepare('UPDATE hf_ltx25_jobs SET status=?,error=?,updated_at=unixepoch() WHERE id=?').bind(state,short(reason,250),j.id).run()
  await send(env,j.chat_id,'LTX-2.5 '+state+': '+short(reason,180)).catch(()=>{})
}
async function getTelegramImage(env:LtxEnv,j:Job):Promise<File>{
  const info=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/getFile?file_id='+encodeURIComponent(j.file_id),{signal:AbortSignal.timeout(12000)})
  const json=await info.json() as {ok?:boolean;result?:{file_path?:string;file_size?:number}}
  if(!info.ok||!json.ok||!json.result?.file_path)throw new Error('Telegram file lookup failed')
  if(Number(json.result.file_size||0)>MAX_IMAGE)throw new Error('Image exceeds 5 MB')
  const image=await fetch('https://api.telegram.org/file/bot'+env.TELEGRAM_BOT_TOKEN+'/'+json.result.file_path,{signal:AbortSignal.timeout(15000)})
  if(!image.ok)throw new Error('Telegram image download failed')
  const bytes=await image.arrayBuffer()
  if(bytes.byteLength===0||bytes.byteLength>MAX_IMAGE)throw new Error('Image too large or empty')
  const type=(image.headers.get('content-type')||'').split(';')[0]
  const mime=['image/jpeg','image/png','image/webp'].includes(type)?type:'image/jpeg'
  return new File([bytes],'ltx-reference.'+(mime==='image/png'?'png':mime==='image/webp'?'webp':'jpg'),{type:mime})
}
async function submit(env:LtxEnv,j:Job){
  const claim=await env.MEMORY_DB.prepare("UPDATE hf_ltx25_jobs SET status='submitting',updated_at=unixepoch() WHERE id=? AND status='queued'").bind(j.id).run()
  if(claim.meta.changes!==1)return
  let gpuAttempted=false
  try{
    if(!env.HUGGINGFACE_API_TOKEN)throw new Error('HF token missing')
    const img=await getTelegramImage(env,j)
    const form=new FormData();form.set('files',img)
    const uploaded=await fetch(SPACE+'/gradio_api/upload',{method:'POST',headers:auth(env),body:form,signal:AbortSignal.timeout(20000)})
    if(!uploaded.ok)throw new Error('Space upload HTTP '+uploaded.status)
    const paths=await uploaded.json() as unknown
    const path=Array.isArray(paths)&&typeof paths[0]==='string'?paths[0]:''
    if(!path||path.length>1000||!path.startsWith('/'))throw new Error('Unexpected Gradio upload response')
    const data=[
      j.prompt+' Include synchronized natural audio matching the movement and setting.',
      {path,orig_name:img.name,mime_type:img.type,meta:{_type:'gradio.FileData'}},
      512,512,2.0,42,'conv',false,false,false
    ]
    gpuAttempted=true
    const resp=await fetch(SPACE+'/gradio_api/call'+ENDPOINT,{
      method:'POST',headers:{...auth(env),'Content-Type':'application/json'},
      body:JSON.stringify({data}),signal:AbortSignal.timeout(22000)
    })
    if(!resp.ok){gpuAttempted=false;throw new Error('Space generation HTTP '+resp.status)}
    const result=await resp.json() as {event_id?:unknown}
    if(typeof result.event_id!=='string'||!/^[A-Za-z0-9_-]{5,120}$/.test(result.event_id))throw new Error('No valid Gradio event ID')
    await env.MEMORY_DB.prepare("UPDATE hf_ltx25_jobs SET status='running',event_id=?,updated_at=unixepoch() WHERE id=?").bind(result.event_id,j.id).run()
    await send(env,j.chat_id,'LTX-2.5 accepted the image-to-video request. Waiting for a 2-second clip with generated sound.').catch(()=>{})
  }catch(e){
    await fail(env,j,gpuAttempted?'Submission outcome unknown; not resubmitting automatically':e instanceof Error?e.message:'Submission failed',gpuAttempted?'uncertain':'failed')
  }
}
function resultVideo(data:unknown):string{
  if(!Array.isArray(data))return ''
  for(const candidate of data.slice(0,2)){
    if(!candidate||typeof candidate!=='object')continue
    const v=candidate as Record<string,unknown>
    const video=v.video&&typeof v.video==='object'?v.video as Record<string,unknown>:v
    const raw=typeof video.url==='string'?video.url:typeof video.path==='string'?video.path:''
    if(!raw)continue
    try{
      const url=new URL(raw,SPACE)
      const origin=new URL(SPACE)
      if(url.origin!==origin.origin||url.username||url.password)continue
      if(!url.pathname.startsWith('/gradio_api/file=')&&!url.pathname.startsWith('/file='))continue
      return url.toString()
    }catch{continue}
  }
  return ''
}
async function deliver(env:LtxEnv,j:Job,url:string){
  const claim=await env.MEMORY_DB.prepare("UPDATE hf_ltx25_jobs SET status='delivering',updated_at=unixepoch() WHERE id=? AND status='running'").bind(j.id).run()
  if(claim.meta.changes!==1)return
  try{
    const resp=await fetch(url,{headers:auth(env),signal:AbortSignal.timeout(24000)})
    if(!resp.ok)throw new Error('Space video HTTP '+resp.status)
    if(Number(resp.headers.get('content-length')||0)>MAX_VIDEO){await resp.body?.cancel();throw new Error('Video larger than Telegram delivery limit')}
    const video=await resp.arrayBuffer()
    if(video.byteLength<1024||video.byteLength>MAX_VIDEO)throw new Error('Invalid or oversized video output')
    const form=new FormData();form.set('chat_id',j.chat_id)
    form.set('caption','LTX-2.5 ZeroGPU • image-to-video + native sound')
    form.set('video',new File([video],'ltx25-audio-video.mp4',{type:'video/mp4'}))
    const sent=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/sendVideo',{method:'POST',body:form,signal:AbortSignal.timeout(28000)})
    if(!sent.ok)throw new Error('Telegram sendVideo HTTP '+sent.status)
    await env.MEMORY_DB.prepare("UPDATE hf_ltx25_jobs SET status='done',updated_at=unixepoch() WHERE id=?").bind(j.id).run()
  }catch(e){await fail(env,j,e instanceof Error?e.message:'Video delivery error','delivery-failed')}
}
async function poll(env:LtxEnv,j:Job){
  if(now()-j.created_at>3*3600){await fail(env,j,'Job expired after three hours','expired');return}
  if(!/^[A-Za-z0-9_-]{5,120}$/.test(j.event_id))return
  try{
    const response=await fetch(SPACE+'/gradio_api/call'+ENDPOINT+'/'+encodeURIComponent(j.event_id),{
      headers:{...auth(env),Accept:'text/event-stream'},signal:AbortSignal.timeout(11000)
    })
    if(!response.ok){await response.body?.cancel();if(response.status===404)await fail(env,j,'Space lost the event ID');return}
    const reader=response.body?.getReader()
    if(!reader)return
    const decoder=new TextDecoder();let buffer='',received=0,done=false,err=false,videoUrl=''
    try{
      while(true){
        const chunk=await reader.read()
        if(chunk.done)break
        buffer+=decoder.decode(chunk.value,{stream:true})
        received+=chunk.value.byteLength
        if(received>260000)throw new Error('Space response too large')
        const blocks=buffer.split(/\r?\n\r?\n/);buffer=blocks.pop()||''
        for(const block of blocks){
          const event=(block.match(/^event:\s*([^\r\n]+)/m)||[])[1]
          if(event==='error'){err=true;break}
          if(event==='complete'){
            const dataText=block.split(/\r?\n/).filter(s=>s.startsWith('data:')).map(s=>s.slice(5).trim()).join('\n')
            try{videoUrl=resultVideo(JSON.parse(dataText))}catch{}
            done=true;break
          }
        }
        if(done||err)break
      }
    }finally{await reader.cancel().catch(()=>{})}
    if(err){await fail(env,j,'Space generation reported an error');return}
    if(done){if(videoUrl)await deliver(env,j,videoUrl);else await fail(env,j,'Space completed without a compatible video URL','delivery-failed')}
  }catch{/* A poll timeout is not a new generation; retry status polling next cron. */}
}
export async function pollLtxJobs(env:LtxEnv){
  if(!env.HUGGINGFACE_API_TOKEN||!env.TELEGRAM_BOT_TOKEN||!env.MEMORY_DB)return
  await init(env)
  const running=await env.MEMORY_DB.prepare("SELECT * FROM hf_ltx25_jobs WHERE status='running' ORDER BY created_at ASC LIMIT 3").bind().all<Job>()
  for(const j of running.results)await poll(env,j)
  const queued=await env.MEMORY_DB.prepare("SELECT * FROM hf_ltx25_jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1").bind().all<Job>()
  if(queued.results[0])await submit(env,queued.results[0])
}
