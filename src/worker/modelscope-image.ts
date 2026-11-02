/** ModelScope image generation from an existing private Telegram bot.
 * API secret is read only from Worker binding; all inference happens on cron.
 * Each accepted request is submitted at most once; unknown HTTP outcomes are NOT retried.
 */
export type MsDb={prepare(sql:string):{bind(...v:(string|number)[]):{run():Promise<{meta:{changes:number}}>;all<T>():Promise<{results:T[]}>}}}
export type MsEnv={MEMORY_DB:MsDb;TELEGRAM_BOT_TOKEN:string;MODELSCOPE_API_TOKEN?:string}
type Job={id:string;chat_id:string;message_id:number;prompt:string;model:string;task_id:string;status:string;created_at:number;updated_at:number;error:string;output_url:string}
const BASE='https://api-inference.modelscope.cn';
export const MS_MODEL='Qwen/Qwen-Image-2.1-Turbo';
const NOW=()=>Math.floor(Date.now()/1000);
const MODEL_ALLOW=new Set(['Qwen/Qwen-Image-2.1-Turbo','Qwen/Qwen-Image']);
const clean=(x:unknown,max=190)=>String(x||'').replace(/[\u0000-\u001f<>]/g,' ').slice(0,max);
async function telegram(env:MsEnv,method:string,body:Record<string,unknown>|FormData){
 const form=body instanceof FormData;
 const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/'+method,{method:'POST',headers:form?{}:{'content-type':'application/json'},body:form?body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
 const j=await r.json().catch(()=>({})) as {ok?:boolean};
 if(!r.ok||!j.ok)throw Error('Telegram delivery HTTP '+r.status);
}
async function tell(env:MsEnv,chat:string,text:string){return telegram(env,'sendMessage',{chat_id:chat,text:clean(text,3900)})}
export async function initModelScope(db:MsDb){
 await db.prepare('CREATE TABLE IF NOT EXISTS modelscope_image_jobs (id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,message_id INTEGER NOT NULL,prompt TEXT NOT NULL,model TEXT NOT NULL,task_id TEXT NOT NULL DEFAULT \'\',status TEXT NOT NULL,created_at INTEGER NOT NULL DEFAULT (unixepoch()),updated_at INTEGER NOT NULL DEFAULT (unixepoch()),error TEXT NOT NULL DEFAULT \'\',output_url TEXT NOT NULL DEFAULT \'\',UNIQUE(chat_id,message_id))').bind().run();
}
export async function queueModelScopeImage(env:MsEnv,chat:string,messageId:number,prompt:string,notify=true){
 if(!env.MODELSCOPE_API_TOKEN){if(notify)await tell(env,chat,'ModelScope is not configured in Cloudflare secrets.');return false}
 if(!prompt.trim()||prompt.length>1500)throw Error('ModelScope prompt must contain 1–1500 characters');
 await initModelScope(env.MEMORY_DB);
 const added=await env.MEMORY_DB.prepare('INSERT OR IGNORE INTO modelscope_image_jobs (id,chat_id,message_id,prompt,model,status) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(),chat,messageId,prompt,MS_MODEL,'queued').run();
 if(added.meta.changes===1&&notify)await tell(env,chat,'🎨 ModelScope Qwen-Image 2.1 Turbo queued. Each successful inference may consume 1 ModelScope grain. I will check progress and deliver the image automatically.');
 return added.meta.changes===1;
}
async function modelFetch(env:MsEnv,url:string,init:RequestInit){
 if(!env.MODELSCOPE_API_TOKEN)throw Error('Missing MODELSCOPE_API_TOKEN');
 const h=new Headers(init.headers);
 h.set('Authorization','Bearer '+env.MODELSCOPE_API_TOKEN);
 h.set('Accept','application/json');
 return fetch(url,{...init,headers:h,signal:AbortSignal.timeout(19000)});
}
async function create(env:MsEnv,j:Job){
 const claim=await env.MEMORY_DB.prepare("UPDATE modelscope_image_jobs SET status='submitting',updated_at=unixepoch() WHERE id=? AND status='queued'").bind(j.id).run();
 if(claim.meta.changes!==1)return;
 if(!MODEL_ALLOW.has(j.model)){
  await env.MEMORY_DB.prepare("UPDATE modelscope_image_jobs SET status='failed',error='Model not in allowlist' WHERE id=?").bind(j.id).run();return;
 }
 let attempted=false;
 try{
  // Public /v1/models works without a token, so it cannot validate inference permission.
  // One explicitly approved generation request is needed to validate the user's API access.
  attempted=true;
  const r=await modelFetch(env,BASE+'/v1/images/generations',{method:'POST',headers:{'content-type':'application/json','X-ModelScope-Async-Mode':'true'},body:JSON.stringify({model:j.model,prompt:j.prompt})});
  const data=await r.json().catch(()=>({})) as Record<string,unknown>;
  if(!r.ok){
   // Rejections are final, but don't create a retry loop that consumes grains.
   await env.MEMORY_DB.prepare('UPDATE modelscope_image_jobs SET status=?,updated_at=unixepoch(),error=? WHERE id=?').bind('failed','Generation HTTP '+r.status+' '+clean(data.message||data.error||data.detail,140),j.id).run();
   await tell(env,j.chat_id,'⚠️ ModelScope rejected image generation: HTTP '+r.status+' ('+clean(data.message||data.error||data.detail,120)+'). No new request will be retried automatically.');
   return;
  }
  const task=String(data.task_id||'');
  if(!/^[a-z0-9_-]{4,140}$/i.test(task))throw Error('ModelScope returned no valid async task ID');
  await env.MEMORY_DB.prepare('UPDATE modelscope_image_jobs SET status=?,task_id=?,updated_at=unixepoch() WHERE id=?').bind('running',task,j.id).run();
  await tell(env,j.chat_id,'✅ ModelScope accepted your image request. Processing; I will send the image when it completes.');
 }catch(e){
  const reason=e instanceof Error?clean(e.message,220):'API unavailable';
  const uncertain=attempted&&!/^Generation HTTP /.test(reason);
  await env.MEMORY_DB.prepare('UPDATE modelscope_image_jobs SET status=?,error=?,updated_at=unixepoch() WHERE id=?').bind(uncertain?'uncertain':'failed',reason,j.id).run();
  await tell(env,j.chat_id,'⚠️ ModelScope '+(uncertain?'response was uncertain after submission; do not retry until checking account tasks.':'preflight failed: '+reason)).catch(()=>{});
 }
}
function trustedImage(url:string){
 try{
  const u=new URL(url);
  return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&
   ['modelscope.cn','modelscope.ai','aliyuncs.com','alicdn.com'].some(root=>u.hostname===root||u.hostname.endsWith('.'+root));
 }catch{return false}
}
async function poll(env:MsEnv,j:Job){
 if(!/^[a-z0-9_-]{4,140}$/i.test(j.task_id))return;
 if(NOW()-j.created_at>8*3600){await env.MEMORY_DB.prepare("UPDATE modelscope_image_jobs SET status='expired',error='Timed out after 8h' WHERE id=?").bind(j.id).run();return;}
 try{
  const r=await modelFetch(env,BASE+'/v1/tasks/'+encodeURIComponent(j.task_id),{headers:{'X-ModelScope-Task-Type':'image_generation'},method:'GET'});
  if(!r.ok){await r.body?.cancel();throw Error('ModelScope task HTTP '+r.status)}
  const data=await r.json() as Record<string,unknown>;
  const status=String(data.task_status||data.status||'').toUpperCase();
  if(['PENDING','RUNNING','PROCESSING','QUEUED','WAITING','IN_PROGRESS'].includes(status))return;
  if(status==='FAILED'||status==='CANCELLED'){
   await env.MEMORY_DB.prepare('UPDATE modelscope_image_jobs SET status=?,error=?,updated_at=unixepoch() WHERE id=?').bind('failed',clean(data.message||data.error||'Model failed',200),j.id).run();
   await tell(env,j.chat_id,'❌ ModelScope generation failed: '+clean(data.message||data.error||'Provider reported failure',180));return;
  }
  if(status!=='SUCCEED'&&status!=='SUCCEEDED')return;
  const images=data.output_images;
  const url=Array.isArray(images)&&typeof images[0]==='string'?images[0]:'';
  if(!url||!trustedImage(url)){
   await env.MEMORY_DB.prepare("UPDATE modelscope_image_jobs SET status='delivery-failed',error='Output host or URL not trusted',updated_at=unixepoch() WHERE id=?").bind(j.id).run();
   await tell(env,j.chat_id,'⚠️ ModelScope completed but returned an image link outside the current safety allowlist. No second generation was started.');return;
  }
  const claimed=await env.MEMORY_DB.prepare("UPDATE modelscope_image_jobs SET status='delivering',output_url=?,updated_at=unixepoch() WHERE id=? AND status='running'").bind(url,j.id).run();
  if(claimed.meta.changes!==1)return;
  try{
   const download=await fetch(url,{signal:AbortSignal.timeout(25000)});
   if(!download.ok)throw Error('Image download HTTP '+download.status);
   if(Number(download.headers.get('content-length')||0)>20*1024*1024){await download.body?.cancel();throw Error('Image exceeds 20 MB');}
   const contentType=(download.headers.get('content-type')||'').toLowerCase();
   if(!/^image\/(png|jpeg|webp)/.test(contentType))throw Error('Provider image has invalid content type');
   const bytes=await download.arrayBuffer();
   if(!bytes.byteLength||bytes.byteLength>20*1024*1024)throw Error('Image missing or exceeds 20 MB');
   const ext=contentType.includes('png')?'png':contentType.includes('webp')?'webp':'jpg';
   const form=new FormData();form.set('chat_id',j.chat_id);form.set('caption','✅ ModelScope Qwen-Image 2.1 Turbo — generated image');form.set('document',new File([bytes],'modelscope-result.'+ext,{type:contentType}));
   await telegram(env,'sendDocument',form);
   await env.MEMORY_DB.prepare("UPDATE modelscope_image_jobs SET status='done',updated_at=unixepoch() WHERE id=?").bind(j.id).run();
  }catch(e){
   await env.MEMORY_DB.prepare("UPDATE modelscope_image_jobs SET status='delivery-failed',error=?,updated_at=unixepoch() WHERE id=?").bind(clean(e instanceof Error?e.message:'Delivery error',190),j.id).run();
   await tell(env,j.chat_id,'⚠️ Image generated, but file delivery failed. It will not be generated twice.').catch(()=>{});
  }
 }catch(e){
  await env.MEMORY_DB.prepare('UPDATE modelscope_image_jobs SET error=?,updated_at=unixepoch() WHERE id=?').bind(clean(e instanceof Error?e.message:'Polling error',190),j.id).run();
 }
}
export async function pollModelScopeImages(env:MsEnv){
 if(!env.MODELSCOPE_API_TOKEN||!env.TELEGRAM_BOT_TOKEN||!env.MEMORY_DB)return;
 await initModelScope(env.MEMORY_DB);
 const rows=await env.MEMORY_DB.prepare("SELECT * FROM modelscope_image_jobs WHERE status IN ('queued','running') ORDER BY created_at ASC LIMIT 6").bind().all<Job>();
 for(const j of rows.results){if(j.status==='queued')await create(env,j);else await poll(env,j)}
}
export async function modelScopeCommand(env:MsEnv,chat:string,text:string):Promise<boolean>{
 const trimmed=text.trim();
 if(/^\/msstatus(?:@\w+)?$/i.test(trimmed)){
  await initModelScope(env.MEMORY_DB);
  const r=await env.MEMORY_DB.prepare('SELECT status,error,model,created_at FROM modelscope_image_jobs WHERE chat_id=? ORDER BY created_at DESC LIMIT 1').bind(chat).all<Pick<Job,'status'|'error'|'model'|'created_at'>>();
  const j=r.results[0];await tell(env,chat,j?'ModelScope latest: '+j.status+(j.error?' — '+clean(j.error,170):''):'No ModelScope image jobs yet.');return true;
 }
 if(/^\/msimage(?:@\w+)?$/i.test(trimmed)){
  await tell(env,chat,'Try /msimage followed by your prompt. I will ask whether to improve it before generating.');return true;
 }
 return false;
}
