/** Provider-specific media jobs for the existing Telegram Hono bot.
 * OVH SDXL accepts anonymous requests. HF uses secret-only routed inference credits.
 * Each approved prompt can be submitted only once; no paid retry on uncertain results.
 */
import { InferenceClient } from '@huggingface/inference'

type Db={prepare(sql:string):{bind(...args:(string|number)[]):{run():Promise<{meta:{changes:number}}>;all<T>():Promise<{results:T[]}>}}}
export type ExternalImageEnv={MEMORY_DB:Db;TELEGRAM_BOT_TOKEN:string;HUGGINGFACE_API_TOKEN?:string}
export type ExternalProvider='ovh'|'hf'
type ImageJob={id:string;chat_id:string;message_id:number;provider:ExternalProvider;prompt:string;status:string;created_at:number;updated_at:number;error:string}
const OVH='https://stable-diffusion-xl.endpoints.kepler.ai.cloud.ovh.net/api/text2image'
const HF_MODEL='black-forest-labs/FLUX.1-schnell'
const clean=(s:unknown,max=200)=>String(s??'').replace(/[\u0000-\u001f<>]/g,' ').slice(0,max)
async function tg(env:ExternalImageEnv,method:string,body:Record<string,unknown>|FormData){
 const isForm=body instanceof FormData
 const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/'+method,{method:'POST',headers:isForm?{}:{'content-type':'application/json'},body:isForm?body:JSON.stringify(body),signal:AbortSignal.timeout(30000)})
 const j=await r.json().catch(()=>({})) as {ok?:boolean}
 if(!r.ok||!j.ok)throw Error('Telegram '+method+' failed HTTP '+r.status)
}
const say=(env:ExternalImageEnv,chat:string,msg:string)=>tg(env,'sendMessage',{chat_id:chat,text:clean(msg,3800)})
export async function initExternalImages(db:Db){
 await db.prepare("CREATE TABLE IF NOT EXISTS external_image_jobs (id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,message_id INTEGER NOT NULL,provider TEXT NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL DEFAULT (unixepoch()),updated_at INTEGER NOT NULL DEFAULT (unixepoch()),error TEXT NOT NULL DEFAULT '',UNIQUE(chat_id,message_id))").bind().run()
}
export async function queueExternalImage(env:ExternalImageEnv,chat:string,messageId:number,prompt:string,provider:ExternalProvider){
 if(provider==='hf'&&!env.HUGGINGFACE_API_TOKEN)throw Error('HUGGINGFACE_API_TOKEN secret is missing')
 if(!prompt.trim()||prompt.length>1500)throw Error('Image prompt must contain 1–1500 characters')
 await initExternalImages(env.MEMORY_DB)
 const r=await env.MEMORY_DB.prepare('INSERT OR IGNORE INTO external_image_jobs (id,chat_id,message_id,provider,prompt,status) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(),chat,messageId,provider,prompt,'queued').run()
 if(r.meta.changes===1)await say(env,chat,provider==='ovh'?'✅ OVHcloud anonymous SDXL queued. No API key or Neurons required. Output is 1024×1024.':'✅ Hugging Face FLUX.1 Schnell queued. Uses your Hugging Face inference credits (not Cloudflare Neurons).')
 return r.meta.changes===1
}
async function generateOvh(prompt:string){
 const r=await fetch(OVH,{method:'POST',headers:{'content-type':'application/json',accept:'application/octet-stream'},body:JSON.stringify({prompt,negative_prompt:'blurred, distorted, low quality, watermark, embedded text'}),signal:AbortSignal.timeout(110000)})
 if(!r.ok){await r.body?.cancel();throw Error('OVH SDXL HTTP '+r.status)}
 if(Number(r.headers.get('content-length')||0)>20*1024*1024){await r.body?.cancel();throw Error('OVH image too large')}
 const contentType=(r.headers.get('content-type')||'').split(';')[0].trim()
 if(!['image/jpeg','image/png','image/webp','application/octet-stream'].includes(contentType))throw Error('OVH did not return a supported image')
 const bytes=await r.arrayBuffer()
 if(bytes.byteLength===0||bytes.byteLength>20*1024*1024)throw Error('OVH returned an empty or oversized image')
 const signature=new Uint8Array(bytes).slice(0,8)
 const png=signature[0]===137&&signature[1]===80&&signature[2]===78&&signature[3]===71
 const jpg=signature[0]===255&&signature[1]===216&&signature[2]===255
 const webp=signature[0]===82&&signature[1]===73&&signature[2]===70&&signature[3]===70
 if(!png&&!jpg&&!webp)throw Error('OVH output did not have a valid image header')
 return new File([bytes],'ovh-sdxl.'+(png?'png':jpg?'jpg':'webp'),{type:png?'image/png':jpg?'image/jpeg':'image/webp'})
}
async function generateHf(env:ExternalImageEnv,prompt:string){
 const token=env.HUGGINGFACE_API_TOKEN
 if(!token)throw Error('Hugging Face API token missing')
 const client=new InferenceClient(token)
 const result=await client.textToImage({model:HF_MODEL,provider:'auto',inputs:prompt,parameters:{num_inference_steps:4}},{signal:AbortSignal.timeout(110000)})
 if(!(result instanceof Blob)||result.size===0||result.size>20*1024*1024)throw Error('Hugging Face returned an empty/oversized result')
 const data=await result.arrayBuffer()
 const h=new Uint8Array(data).slice(0,8)
 const png=h[0]===137&&h[1]===80&&h[2]===78&&h[3]===71
 const jpg=h[0]===255&&h[1]===216&&h[2]===255
 const webp=h[0]===82&&h[1]===73&&h[2]===70&&h[3]===70
 if(!png&&!jpg&&!webp)throw Error('Hugging Face output was not a recognized image file')
 return new File([data],'hf-flux.'+(png?'png':jpg?'jpg':'webp'),{type:png?'image/png':jpg?'image/jpeg':'image/webp'})
}
async function submit(env:ExternalImageEnv,j:ImageJob){
 const claim=await env.MEMORY_DB.prepare("UPDATE external_image_jobs SET status='submitting',updated_at=unixepoch() WHERE id=? AND status='queued'").bind(j.id).run()
 if(claim.meta.changes!==1)return
 let requested=false
 try{
  if(j.provider==='hf'){
   if(!env.HUGGINGFACE_API_TOKEN)throw Error('Hugging Face token not configured')
   // Non-generating key validation; avoid spending credits for missing/invalid token.
   const who=await fetch('https://huggingface.co/api/whoami-v2',{headers:{Authorization:'Bearer '+env.HUGGINGFACE_API_TOKEN},signal:AbortSignal.timeout(12000)})
   if(!who.ok){await who.body?.cancel();throw Error('Hugging Face authentication failed (HTTP '+who.status+')')}
   await who.body?.cancel()
  }
  requested=true
  const file=j.provider==='ovh'?await generateOvh(j.prompt):await generateHf(env,j.prompt)
  const form=new FormData();form.set('chat_id',j.chat_id);form.set('caption',j.provider==='ovh'?'✅ OVHcloud SDXL 1024×1024 (anonymous)':'✅ Hugging Face FLUX.1 Schnell');form.set('document',file)
  await tg(env,'sendDocument',form)
  await env.MEMORY_DB.prepare("UPDATE external_image_jobs SET status='done',updated_at=unixepoch(),error='' WHERE id=?").bind(j.id).run()
 }catch(e){
  const msg=clean(e instanceof Error?e.message:'Image service unavailable',220)
  const uncertain=requested&&!/^OVH SDXL HTTP [45]\d\d$/.test(msg)&&!/^Hugging Face authentication failed/.test(msg)
  await env.MEMORY_DB.prepare('UPDATE external_image_jobs SET status=?,error=?,updated_at=unixepoch() WHERE id=?').bind(uncertain?'uncertain':'failed',msg,j.id).run()
  await say(env,j.chat_id,'⚠️ '+(j.provider==='ovh'?'OVHcloud SDXL':'Hugging Face FLUX')+' request did not complete: '+msg+'\nNo automatic retries or charges will be triggered.').catch(()=>{})
 }
}
export async function pollExternalImages(env:ExternalImageEnv){
 if(!env.TELEGRAM_BOT_TOKEN||!env.MEMORY_DB)return
 await initExternalImages(env.MEMORY_DB)
 const r=await env.MEMORY_DB.prepare("SELECT * FROM external_image_jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 2").bind().all<ImageJob>()
 for(const j of r.results){if(j.provider==='ovh'||j.provider==='hf')await submit(env,j)}
}
export async function checkImageProviders(env:ExternalImageEnv,chat:string){
 const hfConfigured=!!env.HUGGINGFACE_API_TOKEN
 let hf='Not configured'
 if(hfConfigured){
  try{const r=await fetch('https://huggingface.co/api/whoami-v2',{headers:{Authorization:'Bearer '+env.HUGGINGFACE_API_TOKEN!},signal:AbortSignal.timeout(12000)});hf=r.ok?'Token authenticated':'Token rejected (HTTP '+r.status+')';await r.body?.cancel()}
  catch{hf='Token configured; validation unavailable'}
 }
 await say(env,chat,'🎨 Image providers\n\nOVHcloud SDXL: anonymous, no API key; free at current provider pricing, 2 requests/minute/IP.\nModelScope Qwen-Image: saved API secret; credits/grains may apply.\nHugging Face: '+hf+'; monthly inference credits apply.\nCloudflare Workers AI: active; Neurons apply.\n\nTry: /ovhimage your prompt\n/msimage your prompt\n/hfimage your prompt\n/genimage for Cloudflare')
}
