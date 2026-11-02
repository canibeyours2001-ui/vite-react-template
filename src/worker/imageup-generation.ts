/** image-upscaling.net text-to-image and guided editing. Site-published multipart API:
 * POST /image_gen_upload, GET /image_gen_get_status, Cookie: client_id=...
 * Never use a new client identity to circumvent an exhausted quota.
 * Exactly one image-generation request per existing account ID is in flight.
 */
export type UpgenMedia={file_id:string;mime_type?:string;file_size?:number;file_name?:string}
export type UpgenConfig={model:string;aspect:string;references?:UpgenMedia[]}
type D1={prepare(sql:string):{bind(...v:(string|number)[]):{run():Promise<{meta:{changes:number}}>;all<T>():Promise<{results:T[]}>}}}
export type UpgenEnv={MEMORY_DB:D1;TELEGRAM_BOT_TOKEN:string;IMAGE_CLIENT_IDS?:string}
type Job={id:string;chat_id:string;message_id:number;prompt:string;model:string;aspect:string;ref_ids:string;client_slot:number;seen_ids:string;external_id:string;status:string;created_at:number;updated_at:number;error:string}
export const UPGEN_MODELS=[
 {id:'Z-Image-Turbo',name:'Z-Image-Turbo',priceCents:2,refs:0},
 {id:'Qwen-Image-2512',name:'Qwen-Image-2512',priceCents:10,refs:0},
 {id:'Qwen-Image-Edit-2511',name:'Qwen-Image-Edit-2511',priceCents:12,refs:2}
] as const;
export const UPGEN_ASPECTS=['1:1','16:9','9:16','4:3','3:4','3:2','2:3'] as const;
const UP='https://image-upscaling.net';
const safe=(v:unknown,n=180)=>String(v??'').replace(/[\u0000-\u001f<>]/g,' ').slice(0,n);
const ids=(env:UpgenEnv)=>(env.IMAGE_CLIENT_IDS||'').split(',').map(x=>x.trim()).filter(x=>/^[a-zA-Z0-9]{32}$/.test(x));
const slot=(env:UpgenEnv,chat:string)=>Number(BigInt(chat.replace(/\D/g,'')||'0')%BigInt(ids(env).length));
async function tg(env:UpgenEnv,method:string,body:FormData|Record<string,unknown>){
 const form=body instanceof FormData;
 const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/'+method,{method:'POST',headers:form?{}:{'content-type':'application/json'},body:form?body:JSON.stringify(body),signal:AbortSignal.timeout(26000)});
 const j=await r.json().catch(()=>({})) as {ok?:boolean};if(!r.ok||!j.ok)throw Error('Telegram '+method+' HTTP '+r.status);
 return j;
}
async function say(env:UpgenEnv,chat:string,text:string){return tg(env,'sendMessage',{chat_id:chat,text:safe(text,3800)})}
async function endpoint(env:UpgenEnv,clientSlot:number,path:string,init:RequestInit={}){
 const client=ids(env)[clientSlot];if(!client)throw Error('Image-upscaling.net account not configured');
 const h=new Headers(init.headers);h.set('Cookie','client_id='+client);
 return fetch(UP+'/'+path,{...init,headers:h,signal:AbortSignal.timeout(25000)});
}
async function json(env:UpgenEnv,clientSlot:number,path:string){
 const r=await endpoint(env,clientSlot,path);if(!r.ok){await r.body?.cancel();throw Error('Image provider '+path+' HTTP '+r.status)}
 return r.json() as Promise<unknown>;
}
const arr=(x:unknown):Record<string,unknown>[]=>(Array.isArray(x)?x:[]).filter(y=>y&&typeof y==='object'&&!Array.isArray(y));
const fingerprint=(x:Record<string,unknown>)=>String(x.req_id||x.filename||x.image_url||'');
export async function initUpgen(db:D1){
 await db.prepare("CREATE TABLE IF NOT EXISTS imageup_generation_jobs (id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,message_id INTEGER NOT NULL,prompt TEXT NOT NULL,model TEXT NOT NULL,aspect TEXT NOT NULL,ref_ids TEXT NOT NULL,client_slot INTEGER NOT NULL,seen_ids TEXT NOT NULL DEFAULT '[]',external_id TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,created_at INTEGER NOT NULL DEFAULT (unixepoch()),updated_at INTEGER NOT NULL DEFAULT (unixepoch()),error TEXT NOT NULL DEFAULT '',UNIQUE(chat_id,message_id))").bind().run();
}
export async function queueImageUp(env:UpgenEnv,chat:string,messageId:number,prompt:string,options:UpgenConfig){
 const model=UPGEN_MODELS.find(x=>x.id===options.model);
 if(!model||!UPGEN_ASPECTS.some(x=>x===options.aspect))throw Error('Unsupported image-upscaling.net model or aspect ratio');
 if(!prompt.trim()||prompt.length>3000)throw Error('Image prompt must contain 1–3000 characters');
 const refs=options.references||[];
 if(refs.length>model.refs)throw Error('Too many reference images for this model');
 if(model.refs&&refs.length===0)throw Error('Qwen Image Edit requires a reference photo');
 if(refs.some(x=>!x.file_id||x.file_id.length>300))throw Error('Invalid reference photo');
 if(!ids(env).length)throw Error('IMAGE_CLIENT_IDS missing from Cloudflare secrets');
 const selected=slot(env,chat);
 await initUpgen(env.MEMORY_DB);
 // Account concurrency is serialized at submit time; do not redirect to a new identity.
 const r=await env.MEMORY_DB.prepare('INSERT OR IGNORE INTO imageup_generation_jobs (id,chat_id,message_id,prompt,model,aspect,ref_ids,client_slot,status) VALUES (?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),chat,messageId,prompt,model.id,options.aspect,JSON.stringify(refs),selected,'queued').run();
 if(r.meta.changes===1)await say(env,chat,'🖼 '+model.name+' '+options.aspect+' queued. Estimated service cost €'+(model.priceCents/100).toFixed(2)+' (free daily quota applies; Qwen models may require supporter balance). I will deliver your image automatically.');
 return r.meta.changes===1;
}
async function telegramFile(env:UpgenEnv,media:UpgenMedia){
 if(media.file_size&&media.file_size>10*1024*1024)throw Error('Reference image exceeds 10 MB');
 const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/getFile?file_id='+encodeURIComponent(media.file_id),{signal:AbortSignal.timeout(12000)});
 const data=await r.json().catch(()=>({})) as {ok?:boolean;result?:{file_path?:string;file_size?:number}};
 const p=data.result?.file_path||'';
 if(!r.ok||!data.ok||!p||p.includes('..')||p.startsWith('/'))throw Error('Telegram reference image location missing');
 if((data.result?.file_size||0)>10*1024*1024)throw Error('Reference image too large');
 const f=await fetch('https://api.telegram.org/file/bot'+env.TELEGRAM_BOT_TOKEN+'/'+p,{signal:AbortSignal.timeout(18000)});
 if(!f.ok)throw Error('Reference image download failed');
 const b=await f.arrayBuffer();if(!b.byteLength||b.byteLength>10*1024*1024)throw Error('Reference image is empty or too large');
 const ext=/\.png$/i.test(p)?'png':/\.webp$/i.test(p)?'webp':'jpg';
 return new File([b],'reference.'+ext,{type:ext==='png'?'image/png':ext==='webp'?'image/webp':'image/jpeg'});
}
async function submit(env:UpgenEnv,j:Job){
 // No account has more than one image_gen task active simultaneously. Avoid ambiguity in provider status.
 const concurrent=await env.MEMORY_DB.prepare("SELECT id FROM imageup_generation_jobs WHERE client_slot=? AND id!=? AND status IN ('submitting','running','delivery') LIMIT 1").bind(j.client_slot,j.id).all<{id:string}>();
 if(concurrent.results.length)return;
 const claim=await env.MEMORY_DB.prepare("UPDATE imageup_generation_jobs SET status='submitting',updated_at=unixepoch() WHERE id=? AND status='queued'").bind(j.id).run();
 if(claim.meta.changes!==1)return;
 let posted=false;
 try{
  const model=UPGEN_MODELS.find(m=>m.id===j.model);
  if(!model||!UPGEN_ASPECTS.some(x=>x===j.aspect))throw Error('Model or aspect ratio no longer allowed');
  const info=await json(env,j.client_slot,'get_account_info') as {has_free_quota_left?:boolean;balance?:number;quota_free?:number;quota_used?:number};
  const free=Math.max(0,Number(info.quota_free||0)-Number(info.quota_used||0));
  const balance=Number(info.balance)||0;
  const cost=model.priceCents/100;
  if(free+Math.max(0,balance)<cost && info.has_free_quota_left===false)throw Error('Image service quota exhausted; this model requires €'+cost.toFixed(2));
  if(model.priceCents>2&&balance<1)throw Error('Qwen image models may be supporter-only: add at least €1 to the provider account before using this option. No generation submitted.');
  const before=arr(await json(env,j.client_slot,'image_gen_get_status'));
  const seen=before.map(fingerprint).filter(Boolean);
  const form=new FormData();form.set('prompt',j.prompt);form.set('model',j.model);form.set('aspect_ratio',j.aspect);
  const refs=JSON.parse(j.ref_ids) as UpgenMedia[];
  for(const media of refs){form.append('ref_images',await telegramFile(env,media));}
  // Submit once. If it times out after entering the provider network, never retry automatically.
  posted=true;
  const response=await endpoint(env,j.client_slot,'image_gen_upload',{method:'POST',body:form});
  const body=await response.text();
  if(!response.ok){posted=false;throw Error('Image service rejected generation (HTTP '+response.status+'): '+safe(body,160));}
  const external=safe(body,350);
  await env.MEMORY_DB.prepare("UPDATE imageup_generation_jobs SET status='running',seen_ids=?,external_id=?,updated_at=unixepoch() WHERE id=?").bind(JSON.stringify(seen),external,j.id).run();
  await say(env,j.chat_id,'⏳ Image-upscaling.net accepted '+j.model+'. Waiting for image generation and Telegram delivery.');
 }catch(e){
  const reason=safe(e instanceof Error?e.message:'Unknown image generation error',235);
  await env.MEMORY_DB.prepare('UPDATE imageup_generation_jobs SET status=?,error=?,updated_at=unixepoch() WHERE id=?').bind(posted?'uncertain':'failed',reason,j.id).run();
  await say(env,j.chat_id,'⚠️ '+reason+'\nNo automatic retry, to protect your free quota or balance.').catch(()=>{});
 }
}
async function progress(env:UpgenEnv,j:Job){
 if(Math.floor(Date.now()/1000)-j.created_at>3*3600){
  await env.MEMORY_DB.prepare("UPDATE imageup_generation_jobs SET status='expired',error='Provider exceeded 3-hour window',updated_at=unixepoch() WHERE id=?").bind(j.id).run();return;
 }
 try{
  const list=arr(await json(env,j.client_slot,'image_gen_get_status'));
  const seen=new Set(JSON.parse(j.seen_ids) as string[]);
  // The website exposes prompt, model, aspect ratio and per-job req_id/filename.
  // Never send unrelated images even if the account has multiple jobs.
  const hits=list.filter(x=>String(x.prompt||'')===j.prompt&&String(x.model||'')===j.model&&String(x.aspect_ratio||'')===j.aspect)
    .filter(x=>!fingerprint(x)||!seen.has(fingerprint(x)));
  const done=hits.find(x=>Boolean(x.completed)&&typeof x.image_url==='string');
  if(!done)return;
  // The site's frontend also accepts relative image_url paths; resolve
  // against the fixed provider origin, never against user-controlled input.
  const rawUrl=String(done.image_url||'');let host:URL;
  try{host=new URL(rawUrl,UP);if(host.protocol!=='https:'||!['image-upscaling.net','www.image-upscaling.net'].includes(host.hostname)||host.username||host.password)throw Error('Unsafe result');}
  catch{throw Error('Provider returned untrusted result URL');}
  const url=host.toString();
  const lock=await env.MEMORY_DB.prepare("UPDATE imageup_generation_jobs SET status='delivery',updated_at=unixepoch() WHERE id=? AND status='running'").bind(j.id).run();
  if(lock.meta.changes!==1)return;
  try{
   const client=ids(env)[j.client_slot];const r=await fetch(url,{headers:{Cookie:'client_id='+client},signal:AbortSignal.timeout(25000)});
   if(!r.ok)throw Error('Image file download HTTP '+r.status);
   if(Number(r.headers.get('content-length')||0)>22*1024*1024){await r.body?.cancel();throw Error('Image too large for Telegram');}
   const b=await r.arrayBuffer();if(!b.byteLength||b.byteLength>22*1024*1024)throw Error('Invalid generated image size');
   const h=new Uint8Array(b).slice(0,12);const png=h[0]===137&&h[1]===80&&h[2]===78&&h[3]===71;const jpg=h[0]===255&&h[1]===216;const webp=String.fromCharCode(...h.slice(0,4))==='RIFF'&&String.fromCharCode(...h.slice(8,12))==='WEBP';
   if(!png&&!jpg&&!webp)throw Error('Generated output is not a valid image');
   const ext=png?'png':jpg?'jpg':'webp';const form=new FormData();form.set('chat_id',j.chat_id);form.set('caption','✅ Image-upscaling.net '+j.model+' · '+j.aspect);form.set('document',new File([b],'imageup-'+j.model+'.'+ext,{type:'image/'+(jpg?'jpeg':ext)}));
   await tg(env,'sendDocument',form);
   await env.MEMORY_DB.prepare("UPDATE imageup_generation_jobs SET status='done',updated_at=unixepoch() WHERE id=?").bind(j.id).run();
  }catch(e){
   await env.MEMORY_DB.prepare("UPDATE imageup_generation_jobs SET status='delivery-failed',error=?,updated_at=unixepoch() WHERE id=?").bind(safe(e instanceof Error?e.message:'Delivery failed',200),j.id).run();
   await say(env,j.chat_id,'⚠️ Image generation finished but delivery failed. No second generation will be submitted.').catch(()=>{});
  }
 }catch(e){await env.MEMORY_DB.prepare('UPDATE imageup_generation_jobs SET error=?,updated_at=unixepoch() WHERE id=?').bind(safe(e instanceof Error?e.message:'Poll failed',195),j.id).run();}
}
export async function pollImageUp(env:UpgenEnv){
 if(!env.MEMORY_DB||!env.TELEGRAM_BOT_TOKEN||!ids(env).length)return;
 await initUpgen(env.MEMORY_DB);
 const r=await env.MEMORY_DB.prepare("SELECT * FROM imageup_generation_jobs WHERE status IN ('queued','running') ORDER BY created_at ASC LIMIT 8").bind().all<Job>();
 for(const j of r.results){if(j.status==='queued')await submit(env,j);else await progress(env,j);}
}
