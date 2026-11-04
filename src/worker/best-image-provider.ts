/** Quality-first automatic provider routing for ordinary image prompts.
 * Explicit provider commands keep their existing behavior.
 * Do not use paid/grain-based services without an explicit provider selection.
 * Provider fallback is PRE-SUBMISSION ONLY, never retry after uncertain inference.
 */
import {queueZeroImage} from './hf-zerogpu'
import {queueExternalImage} from './external-image'

type DB={prepare:(sql:string)=>{bind:(...values:(string|number)[])=>{run:()=>Promise<{meta:{changes:number}}>;all:<T>()=>Promise<{results:T[]}>}}}
export type BestImageEnv={MEMORY_DB:DB;TELEGRAM_BOT_TOKEN:string;HUGGINGFACE_API_TOKEN?:string}
export type BestImageChoice='hfzero'|'ovh'
const SPACE='https://junaidmalik-qwen-image-2-1.hf.space'

/** Check existence and auth without consuming any inference credits or GPU minutes. */
async function zeroGpuReady(env:BestImageEnv):Promise<boolean>{
 if(!env.HUGGINGFACE_API_TOKEN)return false
 try{
  const [auth,info]=await Promise.all([
   fetch('https://huggingface.co/api/whoami-v2',{
    headers:{Authorization:'Bearer '+env.HUGGINGFACE_API_TOKEN},signal:AbortSignal.timeout(8000)
   }),
   fetch(SPACE+'/gradio_api/info',{signal:AbortSignal.timeout(8000)})
  ])
  if(!auth.ok||!info.ok){await auth.body?.cancel();await info.body?.cancel();return false}
  await auth.body?.cancel()
  const data=await info.json() as {named_endpoints?:Record<string,unknown>}
  return !!data.named_endpoints?.['/generate']
 }catch{return false}
}
/** Keep a failing HF ZeroGPU Space out of automatic routing for one hour.
 * A reachable Space is not proof that its last generation succeeded.
 * This is only a pre-submission provider choice: never retry a submitted job.
 * An unavailable D1 status table does not block an otherwise working Space.
 */
async function zeroGpuRecentlyFailed(env:BestImageEnv):Promise<boolean>{
 try{
  const rows=await env.MEMORY_DB.prepare(
   'SELECT status,created_at FROM hf_zero_image_jobs ORDER BY created_at DESC LIMIT 1'
  ).bind().all<{status:string;created_at:number}>()
  const last=rows.results[0]
  return !!last && last.status==='failed' &&
   Number.isFinite(last.created_at) &&
   Math.floor(Date.now()/1000)-last.created_at<3600
 }catch{return false}
}
/** A fixed ranking for the connected no-extra-payment providers.
 * Paid Qwen-Image-2512, ModelScope grain requests and HF inference credits
 * remain opt-in even when a corresponding secret exists.
 */
export async function selectBestImageProvider(env:BestImageEnv):Promise<BestImageChoice>{
 if(!(await zeroGpuRecentlyFailed(env)) && await zeroGpuReady(env))return 'hfzero'
 return 'ovh'
}
export async function queueBestImage(env:BestImageEnv,chat:string,messageId:number,prompt:string){
 const provider=await selectBestImageProvider(env)
 // The checks above do not reserve ZeroGPU minutes. The Space can later
 // refuse a job if its quota is exhausted. We deliberately do not auto-retry
 // on another service because an already-submitted inference may be running.
 if(provider==='hfzero'){
  await queueZeroImage(env,chat,messageId,prompt.slice(0,1400))
  return provider
 }
 await queueExternalImage(env,chat,messageId,prompt.slice(0,1500),'ovh')
 return provider
}
