/** Optional, authenticated ZeroGPU Space for image generation.
 * Calls junaidmalik/Qwen-Image-2.1 Gradio API, with stable, observed /v2/generate endpoint.
 * This is NOT Hugging Face Inference Providers and uses a different daily GPU quota.
 * Never retries a potentially quota-consuming submission.
 */
type Db={prepare(sql:string):{bind(...args:(string|number)[]):{run():Promise<{meta:{changes:number}}>;all<T>():Promise<{results:T[]}>}}}
export type ZeroEnv={MEMORY_DB:Db;HUGGINGFACE_API_TOKEN?:string;TELEGRAM_BOT_TOKEN:string}
type Job={id:string;chat_id:string;message_id:number;prompt:string;status:string;event_id:string;created_at:number;error:string}
const SPACE='https://junaidmalik-qwen-image-2-1.hf.space';
const ENDP='/gradio_api/call/v2/generate';
const trim=(v:unknown,n=200)=>String(v??'').replace(/[\u0000-\u001f<>]/g,' ').slice(0,n);
const now=()=>Math.floor(Date.now()/1000);
async function tg(env:ZeroEnv,method:string,body:FormData|Record<string,unknown>){
 const form=body instanceof FormData;
 const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/'+method,{method:'POST',headers:form?{}:{'content-type':'application/json'},body:form?body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
 const data=await r.json().catch(()=>({})) as {ok?:boolean};
 if(!r.ok||!data.ok)throw Error('Telegram '+method+' HTTP '+r.status);
}
const tell=(env:ZeroEnv,chat:string,message:string)=>tg(env,'sendMessage',{chat_id:chat,text:trim(message,3900)});
export async function initZero(db:Db){
 await db.prepare("CREATE TABLE IF NOT EXISTS hf_zero_image_jobs (id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,message_id INTEGER NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL,event_id TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL DEFAULT (unixepoch()),updated_at INTEGER NOT NULL DEFAULT (unixepoch()),UNIQUE(chat_id,message_id))").bind().run()
}
export async function queueZeroImage(env:ZeroEnv,chat:string,messageId:number,prompt:string){
 if(!env.HUGGINGFACE_API_TOKEN)throw Error('HUGGINGFACE_API_TOKEN missing');
 if(prompt.trim().length===0||prompt.length>1400)throw Error('ZeroGPU prompt must contain 1–1400 characters');
 await initZero(env.MEMORY_DB);
 const r=await env.MEMORY_DB.prepare('INSERT OR IGNORE INTO hf_zero_image_jobs (id,chat_id,message_id,prompt,status) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(),chat,messageId,prompt,'queued').run();
 if(r.meta.changes===1)await tell(env,chat,'🤗 Hugging Face ZeroGPU Qwen-Image 2.1 queued. This consumes your ZeroGPU daily GPU minutes, not Inference Providers credits. One submission only; progress will be checked automatically.');
 return r.meta.changes===1;
}
async function submit(env:ZeroEnv,j:Job){
 const claim=await env.MEMORY_DB.prepare("UPDATE hf_zero_image_jobs SET status='submitting',updated_at=unixepoch() WHERE id=? AND status='queued'").bind(j.id).run();
 if(claim.meta.changes!==1)return;
 if(!env.HUGGINGFACE_API_TOKEN){await env.MEMORY_DB.prepare("UPDATE hf_zero_image_jobs SET status='failed',error='No HF token' WHERE id=?").bind(j.id).run();return;}
 let attempted=false;
 try{
  const payload={prompt:j.prompt,transparent:false,size_preset:'1:1 — 1024x1024',steps:10,true_cfg_scale:1,negative_prompt:'',seed:0,randomize_seed:true};
  attempted=true;
  const r=await fetch(SPACE+ENDP,{method:'POST',headers:{Authorization:'Bearer '+env.HUGGINGFACE_API_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(20000)});
  const data=await r.json().catch(()=>({})) as Record<string,unknown>;
  if(!r.ok){
   attempted=false;
   const reason='ZeroGPU returned HTTP '+r.status+' '+trim(data.detail||data.error||data.message,150);
   await env.MEMORY_DB.prepare('UPDATE hf_zero_image_jobs SET status=?,error=?,updated_at=unixepoch() WHERE id=?').bind('failed',reason,j.id).run();
   await tell(env,j.chat_id,'⚠️ '+reason+' (no automatic retries)').catch(()=>{});
   return;
  }
  const event=String(data.event_id||'');
  if(!/^[a-zA-Z0-9_-]{6,120}$/.test(event))throw Error('ZeroGPU did not return a valid event ID');
  await env.MEMORY_DB.prepare("UPDATE hf_zero_image_jobs SET status='running',event_id=?,updated_at=unixepoch() WHERE id=?").bind(event,j.id).run();
  await tell(env,j.chat_id,'⏳ HF ZeroGPU Space accepted the request. Waiting for Qwen-Image generation and delivery.');
 }catch(e){
  const error=trim(e instanceof Error?e.message:'ZeroGPU submission error');
  await env.MEMORY_DB.prepare('UPDATE hf_zero_image_jobs SET status=?,error=?,updated_at=unixepoch() WHERE id=?').bind(attempted?'uncertain':'failed',error,j.id).run();
  await tell(env,j.chat_id,'⚠️ ZeroGPU submission status '+(attempted?'uncertain':'failed')+': '+error+'. No retries will be started automatically.').catch(()=>{});
 }
}
function findImage(response:unknown):string{
 if(!Array.isArray(response))return '';
 const first=response[0];
 if(typeof first==='string'&&first.startsWith('https://'))return first;
 if(first&&typeof first==='object'){
  const item=first as Record<string,unknown>;
  if(typeof item.url==='string')return item.url;
  if(typeof item.path==='string'&&item.path.startsWith('/gradio_api/file='))return SPACE+item.path;
 }
 return '';
}
function imageHost(url:string){try{const x=new URL(url);return x.origin===SPACE&&!x.username&&!x.password}catch{return false}}
async function poll(env:ZeroEnv,j:Job){
 if(!/^[a-zA-Z0-9_-]{6,120}$/.test(j.event_id))return;
 if(now()-j.created_at>3600){
  await env.MEMORY_DB.prepare("UPDATE hf_zero_image_jobs SET status='expired',error='Space event expired after 1 hour',updated_at=unixepoch() WHERE id=?").bind(j.id).run();return;
 }
 try{
  const url=SPACE+'/gradio_api/call/generate/'+encodeURIComponent(j.event_id);
  const r=await fetch(url,{headers:{Authorization:'Bearer '+env.HUGGINGFACE_API_TOKEN,'Accept':'text/event-stream'},signal:AbortSignal.timeout(15000)});
  if(!r.ok){await r.body?.cancel();throw Error('ZeroGPU event HTTP '+r.status)}
  const reader=r.body?.getReader();if(!reader)throw Error('Missing ZeroGPU event stream');
  const decoder=new TextDecoder();let buffer='',total=0,completed=false,failed=false,imageUrl='',failure='';
  try{
   while(true){
    const part=await reader.read();if(part.done)break;
    buffer+=decoder.decode(part.value,{stream:true});total+=part.value.byteLength;
    if(total>240000)throw Error('ZeroGPU event exceeded safety limit');
    const chunks=buffer.split(/\r?\n\r?\n/);buffer=chunks.pop()||'';
    for(const block of chunks){
     const event=(block.match(/^event:\s*([^\r\n]+)/m)||[])[1]||'';
     const json=block.split(/\r?\n/).filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trim()).join('\n');
     if(event==='complete'){
      completed=true;let data:unknown;try{data=JSON.parse(json)}catch{throw Error('ZeroGPU complete event missing JSON')}
      imageUrl=findImage(data);break;
     }
     if(event==='error'){failed=true;failure='The Space reported a generation error';break;}
    }
    if(completed||failed)break;
   }
  }finally{await reader.cancel().catch(()=>{});}
  if(failed){await env.MEMORY_DB.prepare("UPDATE hf_zero_image_jobs SET status='failed',error=?,updated_at=unixepoch() WHERE id=?").bind(failure,j.id).run();await tell(env,j.chat_id,'❌ ZeroGPU generation failed. No automatic retries.');return;}
  if(!completed)return;
  if(!imageHost(imageUrl)){
   await env.MEMORY_DB.prepare("UPDATE hf_zero_image_jobs SET status='delivery-failed',error='Unexpected output URL',updated_at=unixepoch() WHERE id=?").bind(j.id).run();
   await tell(env,j.chat_id,'⚠️ ZeroGPU generated output but returned an unsupported image link. No duplicate generation was attempted.');return;
  }
  const claimed=await env.MEMORY_DB.prepare("UPDATE hf_zero_image_jobs SET status='delivering',updated_at=unixepoch() WHERE id=? AND status='running'").bind(j.id).run();if(claimed.meta.changes!==1)return;
  try{
   const d=await fetch(imageUrl,{headers:{Authorization:'Bearer '+env.HUGGINGFACE_API_TOKEN},signal:AbortSignal.timeout(25000)});
   if(!d.ok)throw Error('ZeroGPU image download HTTP '+d.status);
   if(Number(d.headers.get('content-length')||0)>22*1024*1024){await d.body?.cancel();throw Error('ZeroGPU image too large');}
   const type=(d.headers.get('content-type')||'').split(';')[0];
   if(!['image/png','image/jpeg','image/webp'].includes(type))throw Error('ZeroGPU file is not a supported image');
   const bytes=await d.arrayBuffer();if(!bytes.byteLength||bytes.byteLength>22*1024*1024)throw Error('ZeroGPU image empty or too large');
   const form=new FormData();form.set('chat_id',j.chat_id);form.set('caption','✅ Hugging Face ZeroGPU Qwen-Image 2.1');form.set('document',new File([bytes],'hf-zerogpu.'+(type==='image/png'?'png':type==='image/jpeg'?'jpg':'webp'),{type}));
   await tg(env,'sendDocument',form);
   await env.MEMORY_DB.prepare("UPDATE hf_zero_image_jobs SET status='done',updated_at=unixepoch() WHERE id=?").bind(j.id).run();
  }catch(e){
   await env.MEMORY_DB.prepare("UPDATE hf_zero_image_jobs SET status='delivery-failed',error=?,updated_at=unixepoch() WHERE id=?").bind(trim(e instanceof Error?e.message:'Delivery error'),j.id).run();
   await tell(env,j.chat_id,'⚠️ ZeroGPU finished, but Telegram image delivery failed. It will not regenerate automatically.').catch(()=>{});
  }
 }catch(e){
  const error=trim(e instanceof Error?e.message:'Polling error');
  if(!/AbortError|timeout/i.test(error))await env.MEMORY_DB.prepare('UPDATE hf_zero_image_jobs SET error=?,updated_at=unixepoch() WHERE id=?').bind(error,j.id).run();
 }
}
export async function pollZeroImages(env:ZeroEnv){
 if(!env.HUGGINGFACE_API_TOKEN||!env.MEMORY_DB||!env.TELEGRAM_BOT_TOKEN)return;
 await initZero(env.MEMORY_DB);
 const r=await env.MEMORY_DB.prepare("SELECT * FROM hf_zero_image_jobs WHERE status IN ('queued','running') ORDER BY created_at ASC LIMIT 3").bind().all<Job>();
 for(const j of r.results){if(j.status==='queued')await submit(env,j);else await poll(env,j)}
}
export async function zeroStatus(env:ZeroEnv,chat:string){
 await initZero(env.MEMORY_DB);
 const r=await env.MEMORY_DB.prepare('SELECT status,error FROM hf_zero_image_jobs WHERE chat_id=? ORDER BY created_at DESC LIMIT 1').bind(chat).all<Pick<Job,'status'|'error'>>();
 const j=r.results[0];await tell(env,chat,j?'Latest ZeroGPU image: '+j.status+(j.error?' — '+trim(j.error):''):'No Hugging Face ZeroGPU jobs yet. Try /hfzero PROMPT');
}
