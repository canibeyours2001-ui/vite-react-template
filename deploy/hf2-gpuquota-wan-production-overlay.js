/* Additive Hugging Face ZeroGPU command overlay.
   Injected into a byte-matched, backed-up production Worker bundle.
   Never silently switches accounts or retries ambiguous generation submissions. */
const hfWanSpace = "https://alexnasa-wan2-2-animate-zerogpu.hf.space";
const hfWanEndpoint = "/animate_scene";
const hfWanPhotoMax = 5 * 1024 * 1024;
const hfWanVideoMax = 18 * 1024 * 1024;
const hfWanResultMax = 44 * 1024 * 1024;
const hfWanEstimatedGpuSeconds = 195;
const hfWanNote = (v, max = 260) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, " ").slice(0, max);
const hfWanToken = (env2) => env2.HUGGINGFACE2_API_TOKEN;
const hfWanNow = () => Math.floor(Date.now()/1e3);
async function hfWanTelegram(env2, method, data) {
  const isForm = data instanceof FormData;
  const reply = await fetch("https://api.telegram.org/bot" + env2.TELEGRAM_BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: isForm ? {} : {"content-type":"application/json"},
    body: isForm ? data : JSON.stringify(data),
    signal: AbortSignal.timeout(25e3)
  });
  const payload = await reply.json().catch(() => ({}));
  if (!reply.ok || payload.ok !== true) throw Error("Telegram " + method + " HTTP " + reply.status);
}
const hfWanTell = (env2,chat,text) => hfWanTelegram(env2,"sendMessage",{chat_id:chat,text:hfWanNote(text,3900)});
async function hfWanQuota(env2) {
  const token = hfWanToken(env2);
  if (!token) throw Error("HUGGINGFACE2_API_TOKEN is missing");
  const reply = await fetch("https://huggingface.co/api/spaces/zero-gpu/quota", {
    headers: {Authorization:"Bearer " + token, Accept:"application/json"},
    signal: AbortSignal.timeout(12e3)
  });
  if (!reply.ok) throw Error("HF quota HTTP " + reply.status + (reply.status===403 ? " (token needs Billing Read permission)" : ""));
  const x = await reply.json();
  const base = Number(x.base), left = Number(x.current);
  if (!Number.isFinite(base)||!Number.isFinite(left)||base<=0||left<0) throw Error("HF quota response invalid");
  return {base,left,reset:typeof x.resetsAt==="string"?x.resetsAt:"",paid:Number(x.overquotaUsed||0)};
}
function hfWanShowQuota(q) {
  const used=Math.max(0,q.base-q.left);
  return "HF ZeroGPU quota (token 2): " + (used/60).toFixed(1) + "/" + (q.base/60).toFixed(1) +
   " min used · "+(q.left/60).toFixed(1)+" min left"+(q.reset?"\nReset: "+q.reset:"\nReset not yet provided by Hugging Face")+
   (q.paid>0?"\nWarning: over-quota usage: "+(q.paid/60).toFixed(1)+" min":"");
}
async function hfWanInit(env2){
  await env2.MEMORY_DB.prepare("CREATE TABLE IF NOT EXISTS hf_wan22_jobs (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, video_id TEXT NOT NULL, photo_id TEXT NOT NULL, stage TEXT NOT NULL, event_id TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE(chat_id,message_id))").run();
}
async function hfWanQueue(env2,msg,chat) {
  const driving=msg.video || (msg.document && /^video\//.test(msg.document.mime_type||"") ? msg.document:null);
  const photo=msg.reply_to_message?.photo?.at(-1) || (msg.reply_to_message?.document && /^image\//.test(msg.reply_to_message.document.mime_type||"") ? msg.reply_to_message.document:null);
  if (!driving || !photo){
    await hfWanTell(env2,chat,"Wan 2.2 Animate: send a reference PHOTO first, then REPLY to it with a 2-second driving VIDEO and caption /wananimate. Maximum: 18 MB video and 5 MB photo. /gpuquota shows remaining free GPU minutes; /wan_status shows your latest job.");
    return;
  }
  if (Number(driving.file_size||0)>hfWanVideoMax || Number(photo.file_size||0)>hfWanPhotoMax) {
    await hfWanTell(env2,chat,"Wan input too large. Use a video under 18 MB and a photo under 5 MB.");return;
  }
  if(!hfWanToken(env2)){await hfWanTell(env2,chat,"HUGGINGFACE2_API_TOKEN secret is missing; no GPU request sent.");return;}
  let quota;
  try{quota=await hfWanQuota(env2);}
  catch(e){await hfWanTell(env2,chat,"Cannot verify Hugging Face ZeroGPU quota: "+hfWanNote(e.message)+". No generation started.");return;}
  if(quota.left<hfWanEstimatedGpuSeconds){
    await hfWanTell(env2,chat,hfWanShowQuota(quota)+"\nWan generation blocked: approximately 195 GPU-seconds are needed. No auto-switching accounts or paid over-quota usage.");return;
  }
  await hfWanInit(env2);
  const r=await env2.MEMORY_DB.prepare("INSERT OR IGNORE INTO hf_wan22_jobs (id, chat_id, message_id, video_id, photo_id, stage) VALUES (?,?,?,?,?,'queued')")
   .bind(crypto.randomUUID(),chat,msg.message_id,driving.file_id,photo.file_id).run();
  if(r.meta.changes) await hfWanTell(env2,chat,"Wan 2.2 Animate 2-second job queued with token 2. A single GPU attempt will be made; use /wan_status to check progress.\n"+hfWanShowQuota(quota));
}
async function hfWanStatus(env2,chat) {
  await hfWanInit(env2);
  const j=await env2.MEMORY_DB.prepare("SELECT stage,error,created_at FROM hf_wan22_jobs WHERE chat_id=? ORDER BY created_at DESC LIMIT 1").bind(chat).all();
  const row=j.results?.[0];
  await hfWanTell(env2,chat,row?"Wan Animate: "+row.stage+(row.error?"\n"+hfWanNote(row.error):""):"No Wan Animate job yet.");
}
async function hfWanIntercept(request,env2,ctx,originalFetch){
  if(request.method!=="POST" || new URL(request.url).pathname!=="/telegram/webhook")return originalFetch(request,env2,ctx);
  const incoming = await request.clone().json().catch(()=>null);
  const msg=incoming?.message;
  const cmd=String(msg?.text||msg?.caption||"").trim();
  if(!/^\/(gpuquota|wananimate|wan_status)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(cmd))return originalFetch(request,env2,ctx);
  if(!env2.TELEGRAM_WEBHOOK_SECRET ||
    request.headers.get("X-Telegram-Bot-Api-Secret-Token")!==env2.TELEGRAM_WEBHOOK_SECRET) return new Response("Unauthorized",{status:401});
  const chat=String(msg?.chat?.id||""), sender=String(msg?.from?.id||"");
  if(!await isAllowedTelegramUser(env2,chat,sender,msg?.chat?.type))return Response.json({ok:true});
  const action=cmd.match(/^\/([A-Za-z_]+)/i)?.[1].toLowerCase();
  const job=(async()=>{
    try{
      if(action==="gpuquota"){
        const quota=await hfWanQuota(env2);
        await hfWanTell(env2,chat,hfWanShowQuota(quota));
      }else if(action==="wan_status"){
        await hfWanStatus(env2,chat);
      }else await hfWanQueue(env2,msg,chat);
    }catch(e){console.error("HF Wan command failed",e instanceof Error?e.name:"unknown");
      await hfWanTell(env2,chat,"Wan command failed: "+hfWanNote(e instanceof Error?e.message:"unknown")).catch(()=>{});
    }
  })();
  if(ctx&&typeof ctx.waitUntil==="function")ctx.waitUntil(job);else await job;
  return Response.json({ok:true});
}
async function hfWanFail(env2,j,error,stage="failed"){
  await env2.MEMORY_DB.prepare("UPDATE hf_wan22_jobs SET stage=?,error=?,updated_at=unixepoch() WHERE id=?").bind(stage,hfWanNote(error),j.id).run();
  await hfWanTell(env2,j.chat_id,"Wan Animate "+stage+": "+hfWanNote(error)).catch(()=>{});
}
async function hfWanFile(env2,id,limit,allowed){
  const meta=await fetch("https://api.telegram.org/bot"+env2.TELEGRAM_BOT_TOKEN+"/getFile?file_id="+encodeURIComponent(id),{signal:AbortSignal.timeout(12e3)});
  const m=await meta.json();
  if(!meta.ok||!m.ok||!m.result?.file_path)throw Error("Telegram file unavailable");
  if(Number(m.result.file_size||0)>limit)throw Error("Telegram file exceeds size limit");
  const raw=await fetch("https://api.telegram.org/file/bot"+env2.TELEGRAM_BOT_TOKEN+"/"+m.result.file_path,{signal:AbortSignal.timeout(24e3)});
  if(!raw.ok)throw Error("Telegram file download HTTP "+raw.status);
  const bytes=await raw.arrayBuffer();
  if(!bytes.byteLength||bytes.byteLength>limit)throw Error("Invalid or oversized input");
  const fromHeader=String(raw.headers.get("content-type")||"").split(";")[0];
  const type=allowed.includes(fromHeader)?fromHeader:allowed[0];
  return new File([bytes],type.startsWith("video/")?"drive.mp4":"reference.jpg",{type});
}
async function hfWanUpload(env2,file){
  const form=new FormData();form.set("files",file);
  const r=await fetch(hfWanSpace+"/gradio_api/upload",{method:"POST",headers:{Authorization:"Bearer "+hfWanToken(env2)},body:form,signal:AbortSignal.timeout(22e3)});
  if(!r.ok)throw Error("HF Space upload HTTP "+r.status);
  const paths=await r.json();
  const path=Array.isArray(paths)&&typeof paths[0]==="string"?paths[0]:"";
  if(!path.startsWith("/tmp/gradio/")||path.length>1000)throw Error("Unexpected Gradio upload path");
  return {path,orig_name:file.name,mime_type:file.type,meta:{_type:"gradio.FileData"}};
}
async function hfWanSubmit(env2,j){
  const acquired=await env2.MEMORY_DB.prepare("UPDATE hf_wan22_jobs SET stage='preparing',updated_at=unixepoch() WHERE id=? AND stage='queued'").bind(j.id).run();
  if(!acquired.meta.changes)return;
  let requestSent=false;
  try{
    const q=await hfWanQuota(env2);
    if(q.left<hfWanEstimatedGpuSeconds)throw Error("ZeroGPU quota too low for this render. "+hfWanShowQuota(q));
    const video=await hfWanFile(env2,j.video_id,hfWanVideoMax,["video/mp4"]);
    const image=await hfWanFile(env2,j.photo_id,hfWanPhotoMax,["image/jpeg","image/png","image/webp"]);
    const v=await hfWanUpload(env2,video),i=await hfWanUpload(env2,image);
    const params=[v,2,i,"Character Swap","Low Res"];
    requestSent=true;
    const r=await fetch(hfWanSpace+"/gradio_api/call/animate_scene",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+hfWanToken(env2)},body:JSON.stringify({data:params}),signal:AbortSignal.timeout(24e3)});
    if(!r.ok){requestSent=false;throw Error("HF generation HTTP "+r.status);}
    const x=await r.json();
    const event=x?.event_id;
    if(typeof event!=="string"||!(/^[a-zA-Z0-9_-]{5,120}$/).test(event))throw Error("Space did not return a valid event ID");
    await env2.MEMORY_DB.prepare("UPDATE hf_wan22_jobs SET stage='running',event_id=?,updated_at=unixepoch() WHERE id=?").bind(event,j.id).run();
    await hfWanTell(env2,j.chat_id,"Wan Animate accepted the video. Waiting for the 2-second pose animation.").catch(()=>{});
  }catch(e){await hfWanFail(env2,j,requestSent?"Submission outcome unknown; not retrying":e.message,requestSent?"uncertain":"failed");}
}
function hfWanVideoUrl(result){
  if(!Array.isArray(result)||!result[0])return "";
  const first=result[0];
  const item=typeof first==="object"&&first.video?first.video:first;
  const raw=typeof item==="object"?item.url||item.path:typeof item==="string"?item:"";
  if(!raw||typeof raw!=="string")return "";
  try{
    const url=new URL(raw,hfWanSpace);
    if(url.origin!==hfWanSpace||url.username||url.password)return "";
    if(!url.pathname.startsWith("/gradio_api/file=")&&!url.pathname.startsWith("/file="))return "";
    return url.toString();
  }catch{return "";}
}
async function hfWanDeliver(env2,j,url){
  const acquired=await env2.MEMORY_DB.prepare("UPDATE hf_wan22_jobs SET stage='delivering',updated_at=unixepoch() WHERE id=? AND stage='running'").bind(j.id).run();
  if(!acquired.meta.changes)return;
  try{
    const resp=await fetch(url,{headers:{Authorization:"Bearer "+hfWanToken(env2)},signal:AbortSignal.timeout(24e3)});
    if(!resp.ok)throw Error("HF result download HTTP "+resp.status);
    if(Number(resp.headers.get("content-length")||0)>hfWanResultMax){await resp.body?.cancel();throw Error("Video too large");}
    const data=await resp.arrayBuffer();
    if(data.byteLength<1024||data.byteLength>hfWanResultMax)throw Error("Empty or oversized video");
    const form=new FormData();form.set("chat_id",j.chat_id);form.set("caption","Wan 2.2 Animate via Hugging Face ZeroGPU");form.set("video",new File([data],"wan-animate.mp4",{type:"video/mp4"}));
    await hfWanTelegram(env2,"sendVideo",form);
    await env2.MEMORY_DB.prepare("UPDATE hf_wan22_jobs SET stage='done',updated_at=unixepoch() WHERE id=?").bind(j.id).run();
  }catch(e){await hfWanFail(env2,j,e.message,"delivery-failed");}
}
async function hfWanPollOne(env2,j){
  if(hfWanNow()-j.created_at>3*3600){await hfWanFail(env2,j,"Job expired after three hours","expired");return;}
  if(!(/^[a-zA-Z0-9_-]{5,120}$/).test(j.event_id))return;
  try{
    const res=await fetch(hfWanSpace+"/gradio_api/call/animate_scene/"+encodeURIComponent(j.event_id),{headers:{Authorization:"Bearer "+hfWanToken(env2),Accept:"text/event-stream"},signal:AbortSignal.timeout(12e3)});
    if(!res.ok){await res.body?.cancel();if(res.status===404)await hfWanFail(env2,j,"Generation event expired");return;}
    const stream=res.body?.getReader();
    if(!stream)return;
    const decoder=new TextDecoder();let text="",byteCount=0,url="",error=false,finished=false;
    try{
      while(true){
        const next=await stream.read();if(next.done)break;
        text+=decoder.decode(next.value,{stream:true});byteCount+=next.value.byteLength;
        if(byteCount>256e3)throw Error("Generation event too large");
        const blocks=text.split(/\r?\n\r?\n/);text=blocks.pop()||"";
        for(const block of blocks){
          const type=(block.match(/^event:\s*([^\r\n]+)/m)||[])[1];
          if(type==="error"){error=true;break;}
          if(type==="complete"){
            const s=block.split(/\r?\n/).filter(x=>x.startsWith("data:")).map(x=>x.slice(5).trim()).join("\n");
            try{url=hfWanVideoUrl(JSON.parse(s));}catch{}
            finished=true;break;
          }
        }
        if(error||finished)break;
      }
    }finally{await stream.cancel().catch(()=>{});}
    if(error){await hfWanFail(env2,j,"HF Space reported generation error");return;}
    if(finished){if(url)await hfWanDeliver(env2,j,url);else await hfWanFail(env2,j,"Space finished without a compatible video URL","delivery-failed");}
  }catch(e){/* Poll timeout: safe to poll later, no new GPU submission. */
    if(e?.name!=="TimeoutError")console.error("Wan status polling error",e instanceof Error?e.name:"unknown");
  }
}
async function hfWanScheduled(env2){
  if(!env2.MEMORY_DB||!hfWanToken(env2)||!env2.TELEGRAM_BOT_TOKEN)return;
  try{
    await hfWanInit(env2);
    const running=await env2.MEMORY_DB.prepare("SELECT * FROM hf_wan22_jobs WHERE stage='running' ORDER BY created_at LIMIT 2").all();
    for(const j of running.results||[])await hfWanPollOne(env2,j);
    const jobs=await env2.MEMORY_DB.prepare("SELECT * FROM hf_wan22_jobs WHERE stage='queued' ORDER BY created_at LIMIT 1").all();
    if(jobs.results?.[0])await hfWanSubmit(env2,jobs.results[0]);
  }catch(e){console.error("Wan scheduled task error",e instanceof Error?e.name:"unknown");}
}
