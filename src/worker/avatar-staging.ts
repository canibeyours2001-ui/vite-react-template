// LongCat Avatar 1.5 GGUF Telegram integration. Isolated D1 state; no changes to WAN routes.
type Media={file_id:string;file_size?:number;mime_type?:string}
type Msg={chat:{id:number};message_id:number;text?:string;caption?:string;photo?:Media[];document?:Media;audio?:Media;voice?:Media}
type SQL={bind:(...v:(string|number)[])=>{run:()=>Promise<{meta?:{changes?:number}}>;all:<T>()=>Promise<{results:T[]}>}}
type Env={TELEGRAM_BOT_TOKEN:string;MODAL_AVATAR_API_BASE?:string;MODAL_AVATAR_API_KEY?:string;MEMORY_DB:{prepare:(sql:string)=>SQL}}
type Session={chat_id:string;image_id:string;audio_id:string;status:string;job_id:string;updated_at:number}
const MAX_BYTES=8*1024*1024;
const cleanId=(id:string)=>/^[0-9a-f]{32}$/.test(id);
function cfg(env:Env){
 if(!env.MODAL_AVATAR_API_BASE||!env.MODAL_AVATAR_API_KEY)return null;
 const u=new URL(env.MODAL_AVATAR_API_BASE);
 if(u.protocol!=='https:'||!u.hostname.endsWith('.modal.run')||u.username||u.password||u.hash||u.search||u.pathname!=='/')throw Error('Invalid avatar endpoint');
 return {base:u.origin,key:env.MODAL_AVATAR_API_KEY};
}
async function telegram(env:Env,method:string,body:Record<string,unknown>|FormData){
 const isForm=body instanceof FormData;
 const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/'+method,{
  method:'POST',headers:isForm?{}:{'Content-Type':'application/json'},body:isForm?body:JSON.stringify(body),signal:AbortSignal.timeout(40000)});
 const j=await r.json().catch(()=>({})) as {ok?:boolean;result?:{file_path?:string};description?:string};
 if(!r.ok||!j.ok)throw Error('Telegram '+method+' failed: '+String(j.description||r.status).slice(0,95));
 return j.result;
}
async function say(env:Env,chat:string,txt:string){
 await telegram(env,'sendMessage',{chat_id:chat,text:txt.slice(0,3500)});
}
async function setup(env:Env){
 await env.MEMORY_DB.prepare("CREATE TABLE IF NOT EXISTS avatar_gguf_sessions(chat_id TEXT PRIMARY KEY,image_id TEXT NOT NULL DEFAULT '',audio_id TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'collecting',job_id TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL DEFAULT (unixepoch()))").bind().run();
}
async function get(env:Env,chat:string){
 const res=await env.MEMORY_DB.prepare('SELECT * FROM avatar_gguf_sessions WHERE chat_id=?').bind(chat).all<Session>();
 return res.results[0];
}
async function save(env:Env,chat:string,image:string,audio:string,status:string,job:string){
 await env.MEMORY_DB.prepare('INSERT INTO avatar_gguf_sessions(chat_id,image_id,audio_id,status,job_id,updated_at) VALUES(?,?,?,?,?,unixepoch()) ON CONFLICT(chat_id) DO UPDATE SET image_id=excluded.image_id,audio_id=excluded.audio_id,status=excluded.status,job_id=excluded.job_id,updated_at=unixepoch()').bind(chat,image,audio,status,job).run();
}
async function cas(env:Env,chat:string,previous:string,next:string){
 const r=await env.MEMORY_DB.prepare('UPDATE avatar_gguf_sessions SET status=?,updated_at=unixepoch() WHERE chat_id=? AND status=?').bind(next,chat,previous).run();
 return r.meta?.changes===1;
}
async function content(env:Env,id:string){
 const f=await telegram(env,'getFile',{file_id:id});
 if(!f?.file_path||f.file_path.includes('..'))throw Error('Invalid media path');
 const r=await fetch('https://api.telegram.org/file/bot'+env.TELEGRAM_BOT_TOKEN+'/'+f.file_path,{signal:AbortSignal.timeout(30000)});
 if(!r.ok||Number(r.headers.get('content-length')||0)>MAX_BYTES)throw Error('Telegram media exceeds 8 MB');
 const b=await r.arrayBuffer();
 if(!b.byteLength||b.byteLength>MAX_BYTES)throw Error('Telegram media exceeds 8 MB');
 const bytes=new Uint8Array(b);
 let encoded='';
 for(let i=0;i<bytes.length;i+=8192)encoded+=String.fromCharCode(...bytes.subarray(i,i+8192));
 return btoa(encoded);
}
async function checkJob(env:Env,s:Session){
 const api=cfg(env);
 if(!api||!cleanId(s.job_id))throw Error('Avatar endpoint unavailable');
 const id=s.job_id;
 const response=await fetch(api.base+'/v1/avatar/jobs/'+id,{
  headers:{'X-API-Key':api.key},signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw Error('Avatar status HTTP '+response.status);
 return {api,data:await response.json() as {status:string;error?:string;elapsed_gpu_seconds?:number;cost_usd?:number;duration_s?:number;bytes?:number}};
}
async function deliver(env:Env,s:Session):Promise<void>{
 if(s.status==='delivered'||s.status==='delivering')return;
 const {api,data}=await checkJob(env,s);
 if(data.status==='failed'){
  await save(env,s.chat_id,s.image_id,s.audio_id,'failed',s.job_id);
  await say(env,s.chat_id,'❌ LongCat Avatar failed. Your photo and audio remain in this chat; send /avatar to try again.');
  return;
 }
 if(data.status!=='succeeded')return;
 if(!await cas(env,s.chat_id,s.status,'delivering'))return;
 try{
  const r=await fetch(api.base+'/v1/avatar/jobs/'+s.job_id+'/video',{
   headers:{'X-API-Key':api.key},signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw Error('MP4 HTTP '+r.status);
  if(Number(r.headers.get('content-length')||0)>45*1024*1024)throw Error('MP4 too large');
  const blob=await r.blob();
  if(!blob.size||blob.size>45*1024*1024)throw Error('MP4 invalid size');
  const form=new FormData();
  form.set('chat_id',s.chat_id);
  form.set('caption','✅ LongCat Avatar 1.5 GGUF · '+(data.duration_s||4)+'s\n'+
   'GPU '+(data.elapsed_gpu_seconds||0)+'s · estimated $'+Number(data.cost_usd||0).toFixed(3));
  form.set('video',blob,'longcat-avatar.mp4');
  await telegram(env,'sendVideo',form);
  await save(env,s.chat_id,s.image_id,s.audio_id,'delivered',s.job_id);
 }catch(e){
  await save(env,s.chat_id,s.image_id,s.audio_id,'delivery-failed',s.job_id);
  throw e;
 }
}
async function status(env:Env,chat:string){
 const s=await get(env,chat);
 if(!s){await say(env,chat,'No Avatar session. Send /avatar to begin.');return;}
 if(!s.job_id){await say(env,chat,'Avatar '+s.status+'. '+(!s.image_id?'Send a portrait photo.':!s.audio_id?'Send an audio or voice message.':'Send /avatar generate.'));return;}
 if(s.status==='delivered'){await say(env,chat,'Your avatar video was delivered. Send /avatar for a new video.');return;}
 const {data}=await checkJob(env,s);
 if(data.status==='succeeded'){await deliver(env,s);return;}
 if(data.status==='failed'){await deliver(env,s);return;}
 await say(env,chat,'⏳ LongCat Avatar: '+data.status+' · checking automatically every minute.');
}
export async function handleAvatarStaging(env:Env,msg:Msg):Promise<boolean>{
 const chat=String(msg.chat.id),t=(msg.text||msg.caption||'').trim();
 const isStart=/^\/avatar(?:@\w+)?(?:\s|$)/i.test(t);
 const isStatus=/^\/avatar_status(?:@\w+)?$/i.test(t);
 const natural=/\b(?:longcat avatar|talking head|make (?:this|my) (?:photo|picture|portrait) (?:talk|speak))\b/i.test(t);
 const photo=msg.photo?.at(-1)||(msg.document?.mime_type?.startsWith('image/')?msg.document:undefined);
 const audio=msg.audio||msg.voice||(msg.document?.mime_type?.startsWith('audio/')?msg.document:undefined);
 if(!isStart&&!isStatus&&!natural&&!photo&&!audio)return false;
 await setup(env);
 const old=await get(env,chat);
 if(isStatus){await status(env,chat);return true;}
 if(/^\/avatar(?:@\w+)?\s+generate$/i.test(t)){
  if(!old?.image_id||!old.audio_id){await say(env,chat,'Send /avatar, a portrait photo and audio first.');return true;}
  if(old.job_id||!await cas(env,chat,'collecting','submitting')){
   await say(env,chat,'Avatar job is already '+old.status+'. Send /avatar_status.');return true;
  }
  const api=cfg(env);
  if(!api){await save(env,chat,old.image_id,old.audio_id,'collecting','');await say(env,chat,'Avatar GPU endpoint not yet configured.');return true;}
  try{
   const [image_base64,audio_base64]=await Promise.all([content(env,old.image_id),content(env,old.audio_id)]);
   const res=await fetch(api.base+'/v1/avatar/jobs',{
    method:'POST',headers:{'X-API-Key':api.key,'Content-Type':'application/json'},
    body:JSON.stringify({image_base64,audio_base64,duration_s:4}),
    signal:AbortSignal.timeout(45000)});
   if(!res.ok)throw Error('Modal rejected input HTTP '+res.status);
   const j=await res.json() as {id?:string};
   if(!j.id||!cleanId(j.id))throw Error('Modal returned invalid job id');
   await save(env,chat,old.image_id,old.audio_id,'running',j.id);
   await say(env,chat,'🎬 LongCat Avatar submitted. I will deliver the MP4 when finished. /avatar_status checks progress.');
  }catch(e){
   // Unknown timeout after POST cannot safely be retried: avoid duplicate billing.
   await save(env,chat,old.image_id,old.audio_id,'submission-uncertain','');
   await say(env,chat,'⚠️ Avatar submission could not be confirmed. No automatic retry to avoid duplicate GPU charges. Check Modal runs before starting again.');
   console.error('Avatar submission uncertain',e instanceof Error?e.name:'unknown');
  }
  return true;
 }
 if(isStart&&/^\/avatar(?:@\w+)?$/i.test(t)){
  if(old&&['running','submitting','delivering'].includes(old.status)){await status(env,chat);return true;}
  await save(env,chat,'','','collecting','');
  await say(env,chat,'🎭 LongCat Avatar 1.5 GGUF\n1. Send a portrait photo.\n2. Send a voice or audio recording (up to 4 seconds).\n3. Send /avatar generate to confirm GPU use.\nYour MP4 will be delivered here automatically.');
  return true;
 }
 if(natural&&!photo&&!old){await say(env,chat,'Send /avatar and a portrait photo plus speech audio to create a LongCat talking video.');return true;}
 if(!photo&&!audio)return false;
 if(!old&&!natural)return false;
 if(old&&old.status!=='collecting'&&!natural)return false;
 const s=old&&old.status==='collecting'?old:{chat_id:chat,image_id:'',audio_id:'',status:'collecting',job_id:'',updated_at:Math.floor(Date.now()/1000)};
 if((photo?.file_size||0)>MAX_BYTES||(audio?.file_size||0)>MAX_BYTES){await say(env,chat,'Each input must be 8 MB or smaller.');return true;}
 const im=photo?.file_id||s.image_id,au=audio?.file_id||s.audio_id;
 await save(env,chat,im,au,'collecting','');
 await say(env,chat,im&&au?'✅ Inputs received. Send /avatar generate to approve GPU generation.':im?'Photo received. Now send voice/audio.':'Audio received. Now send a portrait photo.');
 return true;
}
export async function pollAvatarGguf(env:Env):Promise<void>{
 if(!cfg(env))return;
 await setup(env);
 const rows=await env.MEMORY_DB.prepare("SELECT * FROM avatar_gguf_sessions WHERE status IN ('running','delivery-failed') AND job_id!='' ORDER BY updated_at ASC LIMIT 3").bind().all<Session>();
 for(const s of rows.results){
  try{await deliver(env,s)}catch(e){console.error('Avatar polling failed',e instanceof Error?e.name:'unknown')}
 }
}
