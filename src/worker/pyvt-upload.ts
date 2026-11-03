
import {selectedDubCommand} from './pyvt-menu'
const PART=8*1024*1024, LIMIT=1024*1024*1024
type DB={prepare(q:string):{bind(...a:(string|number)[]):{run():Promise<{meta:{changes:number}}>;all<T>():Promise<{results:T[]}>}}}
type Part={partNumber:number;etag:string}
type R2={createMultipartUpload:(key:string,opts?:{httpMetadata?:{contentType:string}})=>Promise<{uploadId:string}>;resumeMultipartUpload:(key:string,id:string)=>{uploadPart:(part:number,body:ReadableStream<Uint8Array>)=>Promise<Part>;complete:(p:Part[])=>Promise<unknown>;abort:()=>Promise<void>};head:(key:string)=>Promise<{size:number}|null>;get:(key:string)=>Promise<{size:number;body:ReadableStream<Uint8Array>}|null>;delete:(key:string)=>Promise<void>}
export type UploadEnv={MEMORY_DB:DB;DUB_UPLOADS:R2;TELEGRAM_WEBHOOK_SECRET:string;TELEGRAM_BOT_TOKEN:string}
async function sign(env:UploadEnv,chat:string,expiry:number){
 const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.TELEGRAM_WEBHOOK_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign'])
 const v=await crypto.subtle.sign('HMAC',k,new TextEncoder().encode('dub-u:'+chat+':'+expiry))
 return [...new Uint8Array(v)].map(x=>x.toString(16).padStart(2,'0')).join('')
}
function equal(a:string,b:string){if(a.length!==b.length)return false;let v=0;for(let i=0;i<a.length;i++)v|=a.charCodeAt(i)^b.charCodeAt(i);return v===0}
export async function dubUploadLink(env:UploadEnv,chat:string){
 if(!env.DUB_UPLOADS||!env.TELEGRAM_WEBHOOK_SECRET||!/^[0-9]{5,20}$/.test(chat))throw Error('Large-video uploader unavailable')
 const expiry=Math.floor(Date.now()/1000)+3600
 return 'https://vite-react-template.canibeyours2001.workers.dev/dub/u?chat='+chat+'&expire='+expiry+'&sig='+await sign(env,chat,expiry)
}
async function auth(env:UploadEnv,request:Request){
 const u=new URL(request.url),chat=u.searchParams.get('chat')||'',sig=u.searchParams.get('sig')||'',expire=Number(u.searchParams.get('expire')),now=Math.floor(Date.now()/1000)
 if(!/^[0-9]{5,20}$/.test(chat)||!/^[a-f0-9]{64}$/.test(sig)||!Number.isSafeInteger(expire)||expire<now||expire>now+3600)return null
 return equal(await sign(env,chat,expire),sig)?chat:null
}
async function schema(db:DB){
 await db.prepare('CREATE TABLE IF NOT EXISTS pyvt_upload_sessions(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,key TEXT UNIQUE NOT NULL,upload_id TEXT NOT NULL,size INTEGER NOT NULL,ext TEXT NOT NULL,status TEXT NOT NULL DEFAULT "uploading",created_at INTEGER NOT NULL DEFAULT (unixepoch()))').bind().run()
}
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}})
const failure=(status:number,error:string)=>json({ok:false,error},status)
type Sess={id:string;chat_id:string;key:string;upload_id:string;size:number;ext:string;status:string}
const PAGE=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CYAW Video Dub Upload</title>
<style>body{margin:0;background:#131926;color:#eef3ff;font:16px system-ui;padding:25px}main{max-width:550px;margin:36px auto;border:1px solid #36425b;border-radius:19px;background:#1d2737;padding:24px}h1{font-size:24px}p,small{color:#c5d0e1}input,progress{display:block;margin:22px 0;width:100%}button{padding:13px 22px;background:#5294ff;color:white;border:0;border-radius:10px;font-size:17px}button:disabled{opacity:.5}#notice{white-space:pre-wrap;overflow-wrap:anywhere}</style></head>
<body><main><h1>🎬 Video dubbing upload</h1><p>Upload MP4, MOV, MKV or WebM up to 1 GiB. Files transfer to private R2 storage in 8 MB chunks; no Telegram file-size limit.</p>
<input id="file" type="file" accept=".mp4,.mov,.mkv,.webm"><button id="go">Upload &amp; start dubbing</button><progress id="progress" value="0" max="100"></progress><p id="notice">Choose target language and voice in Telegram /dub first.</p><small>Keep this tab open. The private link expires after one hour.</small></main>
<script>
const q=location.search, f=document.getElementById('file'), b=document.getElementById('go'), p=document.getElementById('progress'), status=document.getElementById('notice'), CHUNK=8*1024*1024;
async function api(path,opt){
 const r=await fetch('/dub/u/'+path+q,opt),x=await r.json().catch(()=>({error:'Invalid response'}))
 if(!r.ok||!x.ok)throw Error(x.error||'Upload HTTP '+r.status)
 return x
}
b.onclick=async()=>{
 const file=f.files&&f.files[0];if(!file){status.textContent='Choose a video first.';return}
 b.disabled=true
 try{
  const setup=await api('init',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:file.name,size:file.size})})
  const parts=[],count=Math.ceil(file.size/CHUNK)
  for(let n=1;n<=count;n++){
   const body=file.slice((n-1)*CHUNK,Math.min(n*CHUNK,file.size))
   let part
   for(let retry=0;retry<3;retry++){
    try{part=await api('part',{method:'POST',headers:{'content-type':'application/octet-stream','x-session-id':setup.session,'x-part-number':String(n)},body});break}
    catch(e){if(retry===2)throw e}
   }
   parts.push({partNumber:part.partNumber,etag:part.etag});p.value=Math.round(n/count*100);status.textContent='Uploading part '+n+'/'+count+' ('+p.value+'%)'
  }
  const done=await api('finish',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session:setup.session,parts})})
  status.textContent=done.message||'Uploaded; check Telegram.'
 }catch(e){status.textContent='Upload failed: '+String(e.message||e)}
 finally{b.disabled=false}
}
</script></body></html>`;
export async function handleDubUpload(env:UploadEnv,request:Request,queue:(chat:string,key:string,size:number,ext:string)=>Promise<string>):Promise<Response>{
 if(!env.DUB_UPLOADS)return failure(503,'R2 upload service not bound')
 const chat=await auth(env,request)
 if(!chat)return failure(403,'Expired upload link. Request /dub_upload in Telegram again.')
 const path=new URL(request.url).pathname
 if(path==='/dub/u'&&request.method==='GET')return new Response(PAGE,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer'}})
 if(!['/dub/u/init','/dub/u/part','/dub/u/finish'].includes(path)||request.method!=='POST')return failure(404,'Invalid upload route')
 await schema(env.MEMORY_DB)
 if(path==='/dub/u/init'){
  if(!await selectedDubCommand(env,chat))return failure(409,'Select target language, translation provider, TTS and voice in Telegram /dub first.')
  const input=await request.json().catch(()=>null) as {name?:string;size?:number}|null
  const size=Number(input?.size), ext=String(input?.name||'').toLowerCase().match(/\.(mp4|mov|mkv|webm)$/)?.[1]
  if(!ext||!Number.isSafeInteger(size)||size<4096||size>LIMIT)return failure(413,'Choose an MP4, MOV, MKV or WebM video up to 1 GiB.')
  const recent=await env.MEMORY_DB.prepare('SELECT id FROM pyvt_upload_sessions WHERE chat_id=? AND status="uploading" AND created_at>unixepoch()-3600 LIMIT 1').bind(chat).all<{id:string}>()
  if(recent.results.length)return failure(409,'An upload session is already active. Finish it or use a new link after one hour.')
  const id=crypto.randomUUID(),key='pyvt/'+chat+'/'+id+'.'+ext
  const up=await env.DUB_UPLOADS.createMultipartUpload(key,{httpMetadata:{contentType:ext==='mkv'?'video/x-matroska':'video/mp4'}})
  try{await env.MEMORY_DB.prepare('INSERT INTO pyvt_upload_sessions(id,chat_id,key,upload_id,size,ext) VALUES(?,?,?,?,?,?)').bind(id,chat,key,up.uploadId,size,ext).run()}
  catch(e){await env.DUB_UPLOADS.resumeMultipartUpload(key,up.uploadId).abort().catch(()=>{});throw e}
  return json({ok:true,session:id})
 }
 const data=path.endsWith('/finish')?await request.clone().json().catch(()=>({})):null
 const sessionId=path.endsWith('/part')?request.headers.get('x-session-id'):(data as {session?:string}|null)?.session
 if(!sessionId||!/^[a-f0-9-]{36}$/.test(sessionId))return failure(400,'Invalid session ID')
 const result=await env.MEMORY_DB.prepare('SELECT id,chat_id,key,upload_id,size,ext,status FROM pyvt_upload_sessions WHERE id=? AND chat_id=?').bind(sessionId,chat).all<Sess>()
 const s=result.results[0]
 if(!s||s.status!=='uploading')return failure(409,'Upload session no longer active')
 const up=env.DUB_UPLOADS.resumeMultipartUpload(s.key,s.upload_id)
 if(path.endsWith('/part')){
  const n=Number(request.headers.get('x-part-number')),count=Math.ceil(s.size/PART),length=Number(request.headers.get('content-length')||0)
  if(!Number.isInteger(n)||n<1||n>count||n>128)return failure(400,'Invalid part')
  if(length>PART||!request.body)return failure(413,'Chunk exceeds 8 MiB')
  const part=await up.uploadPart(n,request.body)
  return json({ok:true,partNumber:part.partNumber,etag:part.etag})
 }
 const parts=(data as {parts?:Part[]}|null)?.parts,count=Math.ceil(s.size/PART)
 if(!Array.isArray(parts)||parts.length!==count||!parts.every((v,i)=>v?.partNumber===i+1&&typeof v.etag==='string'&&v.etag.length>=16))
  return failure(400,'All uploaded parts must be present')
 await up.complete(parts)
 const obj=await env.DUB_UPLOADS.head(s.key)
 if(!obj||obj.size!==s.size){await env.DUB_UPLOADS.delete(s.key).catch(()=>{});return failure(422,'Size mismatch after upload')}
 await env.MEMORY_DB.prepare('UPDATE pyvt_upload_sessions SET status="complete" WHERE id=? AND chat_id=? AND status="uploading"').bind(sessionId,chat).run()
 const message=await queue(chat,s.key,s.size,s.ext)
 return json({ok:true,message})
}
