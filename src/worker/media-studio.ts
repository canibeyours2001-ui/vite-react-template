// @ts-nocheck
import {providerReceipt,duration,aiFooter} from './usage-receipts'
import {UPGEN_MODELS,UPGEN_ASPECTS} from './imageup-generation'
// CYAW Media Studio: existing Hono/Telegram integration, no second webhook.

// Use a stable regional host for creation. Old SG-host jobs may still be visible only on DE/DE2.
const MV = 'https://de.mvsep.com/api';
const MV_FALLBACK = ['https://de2.mvsep.com/api', 'https://sg.mvsep.com/api'];
const UP = 'https://image-upscaling.net';
const IMAGE_MODELS=[
 {id:'@cf/black-forest-labs/flux-1-schnell',name:'FLUX.1 Schnell',steps:4,output:'base64'},
 {id:'@cf/bytedance/stable-diffusion-xl-lightning',name:'SDXL Lightning',steps:4,output:'stream'},
 {id:'@cf/stabilityai/stable-diffusion-xl-base-1.0',name:'SDXL Base 1.0',steps:20,output:'stream'}
];
const LIMIT = 10_000_000;
const epoch = () => Math.floor(Date.now()/1000);
async function progress(env,j,text){
  if(!j.progress_message_id || j.last_status===text)return;
  const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/editMessageText',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({chat_id:j.chat_id,message_id:j.progress_message_id,text:text.slice(0,3900)})
  });
  if(r.ok) await env.MEMORY_DB.prepare('UPDATE studio_jobs SET last_status=? WHERE id=?').bind(text,j.id).run();
}
const truncate = (s,n=70) => String(s ?? '').slice(0,n);
const keys = rows => ({inline_keyboard:rows});
const btn = (label,data) => ({text:truncate(label,56),callback_data:'st:'+data});
const parseJSON = (v, fallback={}) => {try {return JSON.parse(v)}catch{return fallback}};
const safeHost = (url,domain) => {
  try { const u = new URL(url); return u.protocol === 'https:' && (u.hostname === domain || u.hostname.endsWith('.'+domain)); }
  catch {return false}
};
const imageIds = env => (env.IMAGE_CLIENT_IDS || '').split(',').map(x=>x.trim()).filter(x=>/^[A-Za-z0-9]{32}$/.test(x));
async function tg(env,method,data) {
  if (!env.TELEGRAM_BOT_TOKEN) throw Error('Telegram token is not configured');
  const response=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/'+method,{
    method:'POST', body:data instanceof FormData?data:JSON.stringify(data),
    headers:data instanceof FormData?{}:{'Content-Type':'application/json'}
  });
  const out=await response.json();
  if(!response.ok||!out.ok)throw Error('Telegram '+method+' failed: '+truncate(out.description,160));
  return out.result;
}
const message = (env,id,text,keyboard) => tg(env,'sendMessage',{chat_id:id,text:truncate(text,4000),reply_markup:keyboard,disable_web_page_preview:true});
async function media(env,chatId,url,type='document',extra={}) {
  // Forward verified provider-origin media as a file; never send provider keys to Telegram.
  if(!safeHost(url,'mvsep.com')&&!safeHost(url,'image-upscaling.net'))throw Error('Untrusted media URL');
  const r=await fetch(url,{headers:extra.cookie?{Cookie:extra.cookie}:{}});
  if(!r.ok)throw Error('Download failed ('+r.status+')');
  const b=await r.blob();
  if(b.size>48*1024*1024)throw Error('Result exceeds Telegram bot upload size; use the provider link');
  const form=new FormData();
  form.set('chat_id',String(chatId));
  const suffix=(new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i)||[])[1]?.toLowerCase();
  const ext=['mp3','wav','flac','m4a','png','jpg','jpeg','webp','mp4','zip','ogg'].includes(suffix)?suffix:(type==='audio'||b.type.includes('audio/mpeg')?'mp3':b.type.includes('png')?'png':b.type.includes('jpeg')?'jpg':'bin');
  form.set(type,new File([b],'result.'+ext,{type:b.type||'application/octet-stream'}));
  return tg(env,type==='audio'?'sendAudio':type==='photo'?'sendPhoto':'sendDocument',form);
}
async function session(env,id) {
  const row=await env.MEMORY_DB.prepare('SELECT state FROM studio_sessions WHERE chat_id=?').bind(String(id)).first();
  return row?parseJSON(row.state,{step:'home'}):{step:'home'};
}
async function setSession(env,id,s) {
  await env.MEMORY_DB.prepare('INSERT INTO studio_sessions(chat_id,state,updated_at) VALUES(?,?,?) ON CONFLICT(chat_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at')
    .bind(String(id),JSON.stringify(s),epoch()).run();
}
async function putJob(env,j) {
  await env.MEMORY_DB.prepare('INSERT INTO studio_jobs(id,chat_id,provider,kind,external_id,client_slot,status,created_at,updated_at,progress_message_id) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind(j.id,String(j.chat),j.provider,j.kind,j.external,j.slot??null,'running',epoch(),epoch(),j.progress??null).run();
}
async function editJob(env,id,status,err=null) {
  await env.MEMORY_DB.prepare('UPDATE studio_jobs SET status=?,updated_at=?,last_error=? WHERE id=?').bind(status,epoch(),err,id).run();
}
async function accountInfo(env,slot) {
  const id=imageIds(env)[slot]; if(!id)throw Error('Image client identifiers not configured');
  const r=await fetch(UP+'/get_account_info',{headers:{Cookie:'client_id='+id}});
  if(!r.ok)throw Error('Image service account query failed');
  return r.json();
}
function slotFor(env,chat) {
  const n=imageIds(env).length; if(!n)throw Error('Image client IDs are not configured');
  return Number(BigInt(String(chat).replace(/\D/g,'')||'0')%BigInt(n));
}
async function upstream(env,path,slot,opts={}) {
  const id=imageIds(env)[slot]; if(!id)throw Error('Client ID not configured');
  const r=await fetch(UP+'/'+path,{...opts,headers:{...(opts.headers||{}),Cookie:'client_id='+id}});
  if(!r.ok){
    const raw=await r.text().catch(()=>'');
    const json=parseJSON(raw,{});
    const note=typeof json==='object'&&json?(json.detail||json.error||json.message||''):'';
    const detail=String(note||raw).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
    // Never echo credentials, full web pages, service cookies or untrusted HTML.
    const safe=/^[\p{L}\p{N}\s.,:()_+\-/]{4,180}$/u.test(detail)?detail:'';
    throw Error('Image service rejected the request (HTTP '+r.status+')'+(safe?': '+safe:'; check the selected model, scale, file format, and provider quota'));
  }
  const t=await r.text();
  return parseJSON(t,t);
}
async function catalog(scope='all') {
  const u=MV+'/app/algorithms?scopes=single_upload,no_upload,matchering_upload';
  const res=await fetch(u,{cf:{cacheTtl:600,cacheEverything:true}});
  if(!res.ok)throw Error('MVSEP catalog HTTP '+res.status);
  const list=await res.json();
  const data=Array.isArray(list)?list:(list.data||[]);
  const filtered=data.filter(a=>a.is_active!==0 && a.audio_widget && a.render_id);
  if(scope==='voice')return filtered.filter(a=>/tts|vibevoice|bark|speech|voice clon/i.test(a.name));
  if(scope==='audio')return filtered.filter(a=>a.audio_widget==='no_upload'&&!/tts|vibevoice|bark|speech|voice clon/i.test(a.name));
  if(scope==='separate')return filtered.filter(a=>a.audio_widget==='single_upload'&&!/tts|vibevoice|bark|speech|voice clon/i.test(a.name));
  return filtered;
}
function optFields(algo) {
  return (algo.algorithm_fields||[]).map(f=>({
    name:f.name,serverKey:f.server_key||null,label:f.text||f.name,options:parseJSON(f.options||'{}',{}),
    required:f.required===1||f.required===true, defaultKey:f.default_key??null,
    inputType:f.input_type||'text'
  })).sort((a,b)=>Number(a.name.replace(/\D/g,''))-Number(b.name.replace(/\D/g,'')));
}
const home=keys([
 [btn('🎨 Generate image','provider:menu'),btn('🔎 Upscale','i:upscale')],
 [btn('🖼 Image-upscaling.net Generator','upgen:menu'),btn('🎙 Image-site TTS','tts:menu')],
 [btn('🧽 Remove background','i:removebg'),btn('🖌 Re-Imagine','i:reimagine')],
 [btn('🗣 Voice / TTS','mv:voice:0'),btn('🎼 Audio generation','mv:audio:0')],
 [btn('🎚 Separate / Enhance','mv:separate:0'),btn('🧰 All MVSEP models','mv:all:0')],
 [btn('📋 My jobs','jobs'),btn('ℹ️ Help','help')]
]);
const HELP='CYAW Media Studio\n\n/studio — Generate or edit an image\n/imageup — image-upscaling.net image generator and styles\n/mvvoice — MVSEP TTS / voice design / cloning\n/mvaudio — MVSEP music and sounds\n/mvseparate — MVSEP vocal/music separation\n/mvsep — All live MVSEP tools\n/imagetts — Image-upscaling.net TTS\n/studiomodels — Show live model counts\n/studiojobs — Recent jobs\n/studio_cancel — Reset current menu\n\nSelect a tool, model and parameters, then send your text or media. Files must be uploaded only when the bot requests them. All jobs are private to authorized users. Quotas and credits belong to the providers.';
async function showCatalog(env,chat,scope,page=0) {
  const all=await catalog(scope), per=8, p=Math.max(0,Math.min(page,Math.ceil(all.length/per)-1));
  const cur=all.slice(p*per,p*per+per);
  const rows=cur.map(a=>[btn(a.name,'model:'+a.render_id+':'+scope)]);
  const nav=[];
  if(p>0)nav.push(btn('⬅ Previous','mv:'+scope+':'+(p-1)));
  if((p+1)*per<all.length)nav.push(btn('Next ➡','mv:'+scope+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('🏠 Home','home')]);
  return message(env,chat,'MVSEP '+scope.toUpperCase()+' | '+all.length+' live models | page '+(p+1)+'\nSelect a model:',keys(rows));
}
async function imageConfig() {
  const r=await fetch(UP+'/get_upscalers_config',{cf:{cacheTtl:900,cacheEverything:true}});
  if(!r.ok)throw Error('Image model catalog unavailable');
  return r.json();
}
async function imageMenu(env,chat) {return message(env,chat,'Choose an image tool:',home)}
async function imageUpMenu(env,chat){
 const rows=UPGEN_MODELS.map((model,i)=>[btn(model.name+' · €'+(model.priceCents/100).toFixed(2)+(model.refs?' · edit':''),'upgen:model:'+i)]);
 rows.push([btn('🏠 Home','home')]);
 return message(env,chat,'🖼 image-upscaling.net generation\n\nDaily free quota applies; expensive models may require a supporter balance. Choose a model:',keys(rows));
}
async function imageUpAspect(env,chat,s){
 const rows=[];
 for(let i=0;i<UPGEN_ASPECTS.length;i+=3)rows.push(UPGEN_ASPECTS.slice(i,i+3).map((x,j)=>btn(x,'upgen:ratio:'+(i+j))));
 rows.push([btn('🏠 Home','home')]);
 return message(env,chat,s.model+' — choose aspect ratio:',keys(rows));
}
const SITE_TTS_VOICES={
 a:['af_heart','am_michael','af_bella','af_sarah','am_adam','am_echo','af_nicole','af_sky'],
 b:['bf_emma','bf_isabella','bm_george','bm_lewis'],
 j:['jf_alpha','jf_gongitsune','jm_kumo'],
 z:['zf_xiaobei','zf_xiaoxiao','zm_yunxi','zm_yunyang'],
 e:['ef_dora','em_alex'],f:['ff_siwis'],i:['if_sara','im_nicola'],p:['pf_dora','pm_alex']
};
function siteTtsLanguage(){return keys([
 [btn('American English','tts:lang:a'),btn('British English','tts:lang:b')],
 [btn('Japanese','tts:lang:j'),btn('Mandarin','tts:lang:z')],
 [btn('Spanish','tts:lang:e'),btn('French','tts:lang:f')],
 [btn('Italian','tts:lang:i'),btn('Portuguese','tts:lang:p')],
 [btn('🏠 Home','home')]
]);}
async function siteTtsMenu(env,chat){await setSession(env,chat,{step:'tts_lang',kind:'tts'});return message(env,chat,'🎙 Image-upscaling.net TTS — choose language. Free daily quota applies; this produces speech, not music.',siteTtsLanguage());}

const imageProviders=keys([
 [btn('🏆 Best quality (automatic)', 'provider:best')],
 [btn('🆓 OVHcloud SDXL','provider:ovh'),btn('🌟 ModelScope Qwen','provider:modelscope')],
 [btn('🖼 Image-upscaling.net','upgen:menu')],
 [btn('🤗 Hugging Face FLUX','provider:hf'),btn('🆓 HF ZeroGPU Qwen','provider:hfzero')],
 [btn('☁️ Cloudflare Workers AI','i:generate')],
 [btn('🏠 Home','home')]
]);
async function pickImage(env,chat,kind) {
  if(kind==='generate') {
    await setSession(env,chat,{step:'imagemodel',kind:'generate'});
    const rows=IMAGE_MODELS.map((a,i)=>[btn(a.name,'imgmodel:'+i)]);
    rows.push([btn('🏠 Home','home')]);
    return message(env,chat,'🎨 Text-to-image — select a model:',keys(rows));
  }
  if(kind==='upscale') {
    const config=await imageConfig();
    const rows=Object.entries(config).map(([name,v])=>[btn(name+(v.premium?' • Premium':''),'upmodel:'+name)]);
    rows.push([btn('🏠 Home','home')]);
    await setSession(env,chat,{step:'upmodel',kind});
    return message(env,chat,'Choose an upscaling model. Models and supported scales come from the live API:',keys(rows));
  }
  if(kind==='removebg'){
    await setSession(env,chat,{step:'file',kind});
    return message(env,chat,'Send a photo or image document to remove the background.');
  }
  if(kind==='reimagine'){
    await setSession(env,chat,{step:'style',kind});
    return message(env,chat,'Send a style, e.g. Oil_Painting. Then send a photo. (The provider does not publish a complete style catalog in its API docs.)');
  }
}
async function startScale(env,chat,model) {
  const c=await imageConfig();
  if(!c[model])throw Error('Model no longer exists');
  const rows=Object.entries(c[model].scales||{}).map(([val,v])=>[btn(v.display_name||val,'scale:'+val)]);
  rows.push([btn('🏠 Home','home')]);
  await setSession(env,chat,{step:'scale',kind:'upscale',model,face:false,hasFx:!!c[model].fx,hasPrompt:!!c[model].prompt});
  return message(env,chat,'Model: '+model+'\n'+truncate(c[model].help,300)+'\nChoose scale:',keys(rows));
}
async function finishScale(env,chat,val) {
  const s=await session(env,chat), c=await imageConfig();
  if(!c[s.model]||!c[s.model].scales?.[val])throw Error('Invalid scale for model');
  s.scale=val;
  if(s.hasPrompt){s.step='upscale_prompt';await setSession(env,chat,s);return message(env,chat,'Optional model guidance: send a text description or /skip');}
  if(s.hasFx){s.step='face';await setSession(env,chat,s);return message(env,chat,'Enhance faces?',keys([[btn('✅ Yes','face:yes'),btn('No','face:no')]]));}
  s.step='file';await setSession(env,chat,s);
  if(s.savedMedia){const b=await getTelegramFile(env,s.savedMedia);return uploadImage(env,chat,s,b);}
  return message(env,chat,'Send the image to upscale.');
}
async function mvModel(env,chat,id,scope) {
  const all=await catalog('all'), a=all.find(x=>String(x.render_id)===String(id));
  if(!a)throw Error('Model not available in live MVSEP catalog');
  const fields=optFields(a);
  const s={step:'field',kind:'mvsep',scope,model:a.render_id,modelName:a.name,widget:a.audio_widget,fields,values:{},fieldIndex:0,format:0};
  await setSession(env,chat,s);
  await message(env,chat,'Selected: '+a.name+'\nInput: '+a.audio_widget+'\n'+fields.length+' configurable parameters.');
  return nextField(env,chat,s);
}
async function nextField(env,chat,s) {
  if(s.fieldIndex>=s.fields.length){
    s.step='format';await setSession(env,chat,s);
    const rows=[[btn('MP3 (320 kbps)','fmt:0'),btn('WAV 16-bit','fmt:1')],[btn('FLAC 16-bit','fmt:2'),btn('M4A','fmt:3')],[btn('WAV 32-bit','fmt:4'),btn('FLAC 24-bit','fmt:5')]];
    return message(env,chat,'Choose output format:',keys(rows));
  }
  const f=s.fields[s.fieldIndex], arr=Object.entries(f.options||{});
  if(arr.length) {
    s.step='field_choice';s.optionPage=0;await setSession(env,chat,s);
    return showOptions(env,chat,s);
  }
  s.step='field_text';await setSession(env,chat,s);
  return message(env,chat,'Parameter '+(s.fieldIndex+1)+'/'+s.fields.length+': '+f.label+
    (f.required?' (required)':' (optional)')+
    '\nSend the text you want generated or the voice instructions.'+
    (f.required?'':' You may /skip this field.'),
    f.required?undefined:keys([[btn('Skip','opt:skip')]]));
}
async function showOptions(env,chat,s){
  const f=s.fields[s.fieldIndex], opts=Object.entries(f.options||{}), page=s.optionPage||0;
  const rows=opts.slice(page*8,page*8+8).map(([val,title],i)=>[btn(title,'opt:'+String(page*8+i))]);
  const n=[];if(page>0)n.push(btn('⬅','opage:'+(page-1)));
  if((page+1)*8<opts.length)n.push(btn('➡','opage:'+(page+1)));
  if(n.length)rows.push(n);
  if(!f.required||f.defaultKey!==null)rows.push([btn('Use provider default','opt:skip')]);
  return message(env,chat,'Parameter '+(s.fieldIndex+1)+'/'+s.fields.length+': '+f.label+'\nChoose a supported option:',keys(rows));
}
async function advanceField(env,chat,value,skip=false) {
  const s=await session(env,chat),f=s.fields?.[s.fieldIndex];
  if(!f)throw Error('No current field');
  if(skip) {
    if(f.defaultKey!==null)s.values[f.name]=String(f.defaultKey);
    else if(f.required)return message(env,chat,'⚠️ '+f.label+' is required for this MVSEP model. Please supply a value.');
  } else {
    if(f.required&&!String(value||'').trim())return message(env,chat,'⚠️ '+f.label+' cannot be empty.');
    s.values[f.name]=String(value);
  }
  s.fieldIndex++;
  await setSession(env,chat,s);
  return nextField(env,chat,s);
}
async function readyMv(env,chat,fmt) {
  const s=await session(env,chat);s.format=Number(fmt);
  if(s.widget==='no_upload'){
    s.step='confirm';await setSession(env,chat,s);
    const prompt=s.fields.find(f=>f.inputType==='textarea'&&/prompt|text/i.test(f.label));
    return message(env,chat,'Ready: '+s.modelName+'\nNo audio upload needed. '+(prompt?'Text prompt: '+String(s.values[prompt.name]||'').length+' characters.\n':'')+'Submitting may consume MVSEP credits. Tap Generate only once.',keys([[btn('✅ Generate','mvsubmit'),btn('Cancel','home')]]));
  }
  s.step='file';await setSession(env,chat,s);
  return message(env,chat,'Send your '+(s.widget==='matchering_upload'?'target audio file (then reference audio)':'reference/input audio file')+' as audio, voice or document. (Telegram upload limits apply.)');
}
async function getTelegramFile(env,media) {
  if(!media?.file_id)throw Error('No Telegram file attached');
  if(media.file_size>LIMIT)throw Error('File too large; maximum supported by this bot is 10 MB');
  const f=await tg(env,'getFile',{file_id:media.file_id});
  const u='https://api.telegram.org/file/bot'+env.TELEGRAM_BOT_TOKEN+'/'+f.file_path;
  const r=await fetch(u);
  if(!r.ok)throw Error('Failed to download Telegram file');
  const b=await r.blob();
  if(b.size>LIMIT)throw Error('File exceeds 10 MB');
  const serverExt=(String(f.file_path||'').match(/\.(jpg|jpeg|png|webp|mp3|wav|ogg|m4a|flac|mp4)$/i)||[])[1]?.toLowerCase();
  const declared=String(media.mime_type||'').toLowerCase();
  const guessed=serverExt==='jpg'||serverExt==='jpeg'?'image/jpeg':serverExt==='png'?'image/png':
    serverExt==='webp'?'image/webp':serverExt==='ogg'?'audio/ogg':serverExt==='mp3'?'audio/mpeg':
    serverExt==='wav'?'audio/wav':serverExt==='mp4'?'video/mp4':'';
  const mime=declared||guessed||String(b.type||'application/octet-stream');
  const ext=serverExt||(mime==='image/jpeg'?'jpg':mime==='image/png'?'png':mime==='image/webp'?'webp':mime==='audio/ogg'?'ogg':'bin');
  const filename=media.file_name&&/\.[a-z0-9]{2,5}$/i.test(media.file_name)?media.file_name:'telegram-media.'+ext;
  return new File([b],truncate(filename,120),{type:mime});
}
async function submitMv(env,chat,s,file,reference) {
  if(!env.MVSEP_API_TOKEN)throw Error('MVSEP token is not configured');
  const form=new FormData();
  form.set('api_token',env.MVSEP_API_TOKEN);
  form.set('sep_type',String(s.model));
  form.set('output_format',String(s.format??0));
  form.set('is_demo','false');
  for(const [k,v] of Object.entries(s.values||{}))form.set(k,String(v));
  // MVSEP's model catalog exposes server_key (for Qwen3-TTS text is `text`).
  // The public API documents add_optN, but the live TTS worker also requires
  // the server-side named fields. Send both for no-upload generators.
  if(s.widget==='no_upload'){
    for(const f of s.fields||[]){
      if(f.serverKey&&/^[a-z][a-z0-9_]{1,48}$/i.test(f.serverKey)&&
         Object.prototype.hasOwnProperty.call(s.values||{},f.name))
        form.set(f.serverKey,String(s.values[f.name]));
    }
    const prompt=(s.fields||[]).find(f=>/text prompt|lyrics/i.test(f.label));
    if(prompt&&!String(s.values?.[prompt.name]||'').trim())throw Error('Required MVSEP text or lyrics are missing. No credits were spent.');
  }
  if(file)form.set(s.widget==='matchering_upload'?'target_audiofile':'audiofile',file);
  if(reference)form.set('reference_audiofile',reference);
  const r=await fetch(MV+'/separation/create',{method:'POST',body:form});
  const out=await r.json();
  if(!r.ok||!out.success||!out.data?.hash)throw Error('MVSEP: '+truncate(out.data?.message||out.message||'submission failed',200));
  const id=crypto.randomUUID();
  const progress=await tg(env,'sendMessage',{chat_id:chat,text:'⏳ '+s.modelName+' · accepted by MVSEP\nJob '+id.slice(0,8)+'\nI will update this message and send the files automatically.'});
  await putJob(env,{id,chat,provider:'mvsep',kind:s.modelName,external:out.data.hash,progress:progress.message_id});
  await setSession(env,chat,{step:'home'});
  return;
}
async function uploadImage(env,chat,s,file) {
  const slot=slotFor(env,chat);
  const form=new FormData();
  form.set('image',file);
  let ep='',kind=s.kind;
  if(kind==='upscale') {
    ep='upscaling_upload';form.set('model',s.model);form.set('scale',s.scale);
    if(s.face)form.set('fx','');if(s.guidance)form.set('prompt',s.guidance);
    form.set('use_webp','true');
  } else if(kind==='removebg')ep='removebg_upload';
  else if(kind==='reimagine'){ep='reImagine_upload';form.set('style',s.style||'Oil_Painting');}
  else throw Error('Invalid image operation');
  // Respect quota and do not rotate client identity to evade limits.
  const account=await accountInfo(env,slot);
  if(account.has_free_quota_left===false && !(Number(account.balance)>0))
    throw Error('No remaining image service quota for this client/IP. Add legitimate credits or try later.');
  const out=await upstream(env,ep,slot,{method:'POST',body:form});
  const external=typeof out==='string'?out:(out.req_id||out.filename||out.original_filename||'');
  if(typeof external!=='string'||external.length>500||/[<>]/.test(external))throw Error('Invalid upload result from provider');
  if(!external||/error|invalid|fail/i.test(String(external).slice(0,70)))throw Error('Image provider did not accept the upload: '+truncate(external,100));
  const id=crypto.randomUUID();
  const progress=await tg(env,'sendMessage',{chat_id:chat,text:'⏳ '+kind+' queued\nJob '+id.slice(0,8)+'\nI will update progress and deliver the result automatically.'});
  await putJob(env,{id,chat,provider:'image',kind,external:String(external),slot,progress:progress.message_id});
  await setSession(env,chat,{step:'home'});
  return;
}
async function submitTts(env,chat,s,text) {
  const slot=slotFor(env,chat);
  const account=await accountInfo(env,slot);
  if(account.has_free_quota_left===false && !(Number(account.balance)>0))throw Error('Image service daily quota exhausted.');
  const active=await env.MEMORY_DB.prepare("SELECT id FROM studio_jobs WHERE provider='image' AND kind='tts' AND client_slot=? AND status='running' LIMIT 1").bind(slot).all();
  if(active.results?.length)throw Error('One TTS job is already running for this image-provider account.');
  const before=await upstream(env,'tts_get_data',slot);
  const seen=Array.isArray(before)?before.map(x=>String(x.req_id??x.result??'')).filter(Boolean):[];
  const out=await upstream(env,'tts_submit',slot,{method:'POST',body:JSON.stringify({text,voice:s.voice||'am_michael',speed:s.speed||1}),headers:{'Content-Type':'application/json'}});
  if(out&&typeof out==='object'&&out.success===false)throw Error('Provider rejected TTS request');
  // This API returns the numeric req_id as the submit response. Persist that ID
  // for exact matching; account-wide result lists must never be matched by text alone.
  const reqId=(typeof out==='number'||typeof out==='string')?String(out).trim():
    (out&&typeof out==='object'?String(out.req_id??out.id??''):'');
  if(!/^\d{8,18}$/.test(reqId))throw Error('TTS submission response did not include a valid request ID. Check the provider account before retrying.');
  const id=crypto.randomUUID();
  const progress=await tg(env,'sendMessage',{chat_id:chat,text:'⏳ TTS submitted\nJob '+id.slice(0,8)+'\nI will deliver the audio automatically.'});
  await putJob(env,{id,chat,provider:'image',kind:'tts',external:JSON.stringify({seen,reqId,result:out,text,voice:s.voice||'am_michael',speed:Number(s.speed)||1}),slot,progress:progress.message_id});
  await setSession(env,chat,{step:'home'});
  return;
}
async function sendRecent(env,chat) {
  const r=await env.MEMORY_DB.prepare('SELECT id,kind,status,last_error FROM studio_jobs WHERE chat_id=? ORDER BY created_at DESC LIMIT 8').bind(String(chat)).all();
  const list=(r.results||[]).map(x=>x.id.slice(0,8)+' • '+truncate(x.kind,24)+' • '+x.status+(x.last_error?' • '+truncate(x.last_error,80):''));
  try{
    const more=await env.MEMORY_DB.prepare('SELECT id,model,status,error FROM imageup_generation_jobs WHERE chat_id=? ORDER BY created_at DESC LIMIT 4').bind(String(chat)).all();
    for(const j of more.results||[])list.push(j.id.slice(0,8)+' • '+j.model+' • '+j.status+(j.error?' • '+truncate(j.error,70):''));
  }catch{}
  return message(env,chat,list.length?'Your latest jobs:\n'+list.join('\n'):'No jobs yet.',keys([[btn('🔁 Refresh','jobs'),btn('🏠 Home','home')]]));
}
async function deliverResult(env,j,urls) {
  const unique=[...new Set(urls)].filter(u=>safeHost(u,'mvsep.com')||safeHost(u,'image-upscaling.net'));
  if(!unique.length)throw Error('No supported output URLs in provider result');
  let sent=0;
  for(const u of unique.slice(0,8)) {
    try {await media(env,j.chat_id,u,/\.(mp3|m4a)(\?|$)/i.test(u)?'audio':'document',{cookie:j.client_slot==null?null:'client_id='+imageIds(env)[j.client_slot]});sent++;}
    catch(err) {if(sent===0)throw err;await message(env,j.chat_id,'Additional output: '+truncate(u,500));}
  }
  if(!sent)throw Error('Could not send result');
  return;
}
function resultUrls(v) {
  const res=[];
  function walk(x,depth=0){
    if(depth>6||x==null)return;
    if(typeof x==='string'){if(safeHost(x,'mvsep.com')||safeHost(x,'image-upscaling.net'))res.push(x);}
    if(Array.isArray(x))for(const el of x)walk(el,depth+1);
    else if(typeof x==='object')for(const [k,val] of Object.entries(x))if(/^(url|link|result|download|download_url|file|files|image_url|audio_url|path)$/i.test(k)||depth>0)walk(val,depth+1);
  }
  walk(v);return res;
}
function sentReceipt(j){return 'delivered · '+duration(epoch()-j.created_at)+' wall time'}
// MVSEP documents a shared job database, but in production SG can return not_found
// for an accepted hash while DE and DE2 correctly return waiting/done. Never mark
// jobs failed on the first region's not_found response.
async function mvsepStatus(hash){
  let missing=0,failed=0;
  for(const host of [MV,...MV_FALLBACK]){
    try{
      const r=await fetch(host+'/separation/get?hash='+encodeURIComponent(hash));
      if(!r.ok){failed++;continue;}
      const data=await r.json();
      if(data.status==='not_found'){missing++;continue;}
      if(data.status&&data.status!=='not_found')return data;
      failed++;
    }catch{failed++;}
  }
  throw Error(failed?'MVSEP regional status temporarily unavailable':'MVSEP job not yet visible across '+missing+' regions');
}
async function pollJob(env,j){
  try{
    if(j.provider==='mvsep'){
      const data=await mvsepStatus(j.external_id);
      if(data.status==='failed'){await editJob(env,j.id,'failed',truncate(data.data?.message||data.status,240));await progress(env,j,'❌ '+j.kind+' · failed');await message(env,j.chat_id,'❌ MVSEP '+j.kind+' failed: '+truncate(data.data?.message||data.status,150));return;}
      if(data.status!=='done'){
        const label='⏳ '+j.kind+' · '+(data.status||'processing')+
          (data.data?.current_order!==undefined?'\nQueue position '+data.data.current_order:'')+
          (data.data?.all_chunks?'\nProcessed '+data.data.finished_chunks+'/'+data.data.all_chunks+' chunks':'');
        await progress(env,j,label);
        return;
      }
      const urls=resultUrls(data.data?.files||data.data?.result||data.data||{});
      if(!urls.length){await editJob(env,j.id,'failed','Completed without readable output URLs');return;}
      await deliverResult(env,j,urls);await editJob(env,j.id,'done');await progress(env,j,'✅ '+j.kind+' · '+sentReceipt(j)+'\n'+await providerReceipt(env,'mvsep'));
      return;
    }
    const slot=j.client_slot;
    const ep=j.kind==='upscale'?'upscaling_get_status_v2':j.kind==='removebg'?'removebg_get_status_v2':j.kind==='reimagine'?'reImagine_get_status':'tts_get_data';
    const status=await upstream(env,ep,slot);
    if(!Array.isArray(status))throw Error('Invalid provider status');
    let hit;
    if(j.kind==='reimagine')hit=status.find(x=>x.req_id===j.external_id);
    else if(j.kind==='tts'){
      const previous=parseJSON(j.external_id,{});
      const seen=new Set(previous.seen||[]);
      // tts_submit returns a numeric req_id; tts_get_data returns that same ID
      // alongside status, result URL, and metadata. Match the ID FIRST so that
      // whitespace normalization or provider-side text changes cannot strand jobs.
      // The endpoint is account-wide: never match an unrelated request by URL.
      const reqId=String(previous.reqId??previous.request_id??previous.result??'').trim();
      if(/^\d{8,18}$/.test(reqId)){
        hit=status.find(x=>x&&String(x.req_id??'')===reqId);
      }else{
        // Fallback only for older requests lacking a useful submission ID.
        hit=status.find(x=>x&&x.result&&previous.text&&
          String(x.text??'')===String(previous.text)&&
          String(x.voice??'')===String(previous.voice??'')&&
          Math.abs(Number(x.speed??1)-Number(previous.speed??1))<0.01&&
          !seen.has(String(x.req_id??x.result??'')));
      }

    }
    else hit=status.find(x=>x.original_filename===j.external_id||x.filename===j.external_id);
    if(!hit){await progress(env,j,'⏳ '+j.kind+' · waiting for provider');return;}
    if(j.kind==='tts'&&/^(failed|error|cancelled|canceled)$/i.test(String(hit.status??''))){
      const reason='Provider TTS status: '+truncate(hit.status,60);
      await editJob(env,j.id,'failed',reason);
      await progress(env,j,'❌ TTS · '+reason);
      await message(env,j.chat_id,'⚠️ Your image-upscaling.net TTS job failed: '+reason+'\nNo duplicate generation was submitted.');
      return;
    }
    const done=j.kind==='reimagine'?hit.is_completed:(j.kind==='tts'?!!hit.result:!!hit.completed);
    if(!done){await progress(env,j,'⏳ '+j.kind+' · processing');return;}
    const url=hit.result||hit.image_url;
    if(!url)throw Error('Completed without output URL');
    await deliverResult(env,j,[url]);await editJob(env,j.id,'done');await progress(env,j,'✅ '+j.kind+' · '+sentReceipt(j)+'\n'+await providerReceipt(env,'image',j.client_slot));
  }catch(err){
    const e=truncate(err.message||err,250);
    // Remain retryable, except after 12 hours.
    if(epoch()-j.created_at>43200){await editJob(env,j.id,'failed',e);await progress(env,j,'❌ '+j.kind+' expired: '+e);await message(env,j.chat_id,'⚠️ Job expired: '+j.id.slice(0,8)+'. '+e);}
    else await env.MEMORY_DB.prepare('UPDATE studio_jobs SET last_error=?,updated_at=? WHERE id=?').bind(e,epoch(),j.id).run();
  }
}
async function pollAll(env){
  const q=await env.MEMORY_DB.prepare("SELECT * FROM studio_jobs WHERE status='running' ORDER BY created_at ASC LIMIT 12").all();
  for(const j of q.results||[])await pollJob(env,j);
}
async function handleMessage(env,m) {
  const chat=m.chat?.id,usr=m.from?.id;if(!chat||!usr)return;
  const text=m.text||m.caption||'',command=text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();
  if(command==='/studiohelp')return message(env,chat,HELP,home);
  if(command==='/studio_cancel'){await setSession(env,chat,{step:'home'});return message(env,chat,'Cancelled current selection.',home);}
  if(command==='/studiojobs'||command==='/imageup_status')return sendRecent(env,chat);
  if(command==='/usage'){
    const current=await Promise.all([aiFooter(env.MEMORY_DB,String(chat)),providerReceipt(env,'mvsep'),
      providerReceipt(env,'image',slotFor(env,chat))]);
    return message(env,chat,'📊 CYAW Studio usage\n\n'+current.join('\n')+
      '\n⏱ Processing times are included in completed job receipts.\n💳 Modal actual costs: check the Modal billing dashboard.',home);
  }
  if(command==='/upscale')return pickImage(env,chat,'upscale');
  if(command==='/genimage')return message(env,chat,'🎨 Choose a provider. Best quality is first and uses free services only; paid models are opt-in.',imageProviders);
  if(command==='/imageup')return imageUpMenu(env,chat);
  if(command==='/studio'||command==='/image')return imageMenu(env,chat);
  if(command==='/removebg')return pickImage(env,chat,'removebg');
  if(command==='/reimagine')return pickImage(env,chat,'reimagine');
  if(command==='/mvvoice')return showCatalog(env,chat,'voice');
  if(command==='/mvaudio')return showCatalog(env,chat,'audio');
  if(command==='/mvseparate')return showCatalog(env,chat,'separate');
  if(command==='/mvsep')return showCatalog(env,chat,'all');
  if(command==='/studiomodels'){
    const a=await catalog('all'),im=await imageConfig();
    return message(env,chat,'Live catalogs: '+a.length+' MVSEP models, '+Object.keys(im).length+' upscalers, '+IMAGE_MODELS.length+' text-to-image models.\nUse /mvsep or /image.',home);
  }
  if(command==='/imagetts')return siteTtsMenu(env,chat);
  const s=await session(env,chat);
  if(s.step==='home')return message(env,chat,'Choose an action:',home);
  if(s.step==='tts_voice'){s.voice=truncate(text.trim(),60);if(!/^[a-zA-Z0-9_-]{2,60}$/.test(s.voice))return message(env,chat,'Invalid voice code. Try am_michael.');s.step='tts_speed';await setSession(env,chat,s);return message(env,chat,'Choose speech speed:',keys([[btn('0.8x','speed:0.8'),btn('1.0x','speed:1'),btn('1.2x','speed:1.2')]]));}
  if(s.step==='tts_text') {
    if(!text||text.length>60000)return message(env,chat,'Send between 1 and 60,000 characters.');
    s.text=text;s.step='tts_confirm';await setSession(env,chat,s);
    return message(env,chat,'🎙 '+(s.voice||'am_michael')+' · '+(s.speed||1)+'× speed\n\nText: '+truncate(text,700)+'\n\nUse the site’s free daily quota or available balance?',keys([[btn('✅ Generate speech','tts:submit'),btn('Cancel','home')]]));
  }
  if(s.step==='prompt'&&s.kind==='generate'){
    if(!text||text.length>2048)return message(env,chat,'Send a prompt of 1–2048 characters.');
    if(!env.AI)throw Error('Workers AI is not enabled');
    const model=IMAGE_MODELS.find(x=>x.id===s.model);
    if(!model)throw Error('Choose an image model first');
    const started=Date.now();
    const params={prompt:text};
    if(model.output==='base64')params.steps=model.steps;
    else {
      params.seed=Math.floor(Math.random()*1000000);
      params.num_steps=model.steps;
      if(s.width&&s.height){params.width=s.width;params.height=s.height;}
    }
    const data=await env.AI.run(model.id,params);
    let bytes,type;
    if(data?.image&&typeof data.image==='string'){
      bytes=Uint8Array.from(atob(data.image),c=>c.charCodeAt(0));type='image/jpeg';
    }else if(data instanceof ReadableStream){
      bytes=new Uint8Array(await new Response(data).arrayBuffer());type='image/png';
    }else if(data instanceof Uint8Array||data instanceof ArrayBuffer){
      bytes=data instanceof Uint8Array?data:new Uint8Array(data);type='image/png';
    }else throw Error('Cloudflare image model returned an unsupported format');
    if(!bytes.length||bytes.length>9*1024*1024)throw Error('Generated image unavailable or exceeds 9 MB');
    const sec=duration(Math.ceil((Date.now()-started)/1000));
    const form=new FormData();form.set('chat_id',String(chat));
    form.set('caption','🎨 '+model.name+' · '+sec+' processing time\nWorkers AI quota: see Cloudflare dashboard (neuron usage is not returned per request)');
    form.set('photo',new File([bytes],'generated.'+(type==='image/jpeg'?'jpg':'png'),{type}));
    await tg(env,'sendPhoto',form);await setSession(env,chat,{step:'home'});return;
  }
  if(s.step==='upgen_file' && (m.photo?.length||m.document)){
    const file=m.photo?.at(-1)||m.document;
    if(!file||!file.file_id||file.mime_type&&!/^image\/(png|jpeg|webp)/.test(file.mime_type))throw Error('Send a supported JPEG, PNG or WebP reference photo');
    s.references=[...(s.references||[]),{file_id:file.file_id,mime_type:file.mime_type||'image/jpeg',file_size:file.file_size, file_name:file.file_name}].slice(0,2);
    s.step='upgen_prompt';await setSession(env,chat,s);
    return message(env,chat,'✅ Reference image '+s.references.length+' saved. '+(s.references.length<2?'You may send a second reference photo, or ':'')+'Send your image editing prompt. I will offer to improve it before generation.');
  }
  if(s.step==='upgen_prompt' && (m.photo?.length||m.document)){
    if((s.references||[]).length>=2)throw Error('Maximum two reference images');
    const file=m.photo?.at(-1)||m.document;
    if(!file?.file_id||file.mime_type&&!/^image\/(png|jpeg|webp)/.test(file.mime_type))throw Error('Send a supported image');
    s.references=[...(s.references||[]),{file_id:file.file_id,mime_type:file.mime_type||'image/jpeg',file_size:file.file_size,file_name:file.file_name}];
    await setSession(env,chat,s);
    return message(env,chat,'✅ Second reference saved. Now send your editing prompt.');
  }
  if(s.step==='style'){if(!text||text.length>90)return message(env,chat,'Enter a style name under 90 characters.');s.style=text.trim();s.step='file';await setSession(env,chat,s);return message(env,chat,'Style: '+s.style+'\nNow send an image.');}
  if(s.step==='upscale_prompt'){if(command!=='/skip')s.guidance=text;s.step=s.hasFx?'face':'file';await setSession(env,chat,s);if(s.hasFx)return message(env,chat,'Enhance faces?',keys([[btn('Yes','face:yes'),btn('No','face:no')]]));if(s.savedMedia){const b=await getTelegramFile(env,s.savedMedia);return uploadImage(env,chat,s,b);}return message(env,chat,'Send an image to upscale.');}
  if(s.step==='field_text')return advanceField(env,chat,text,command==='/skip');
  const file=m.photo?.at(-1)||m.document||m.audio||m.voice;
  if(s.step==='file'&&file){
    const b=await getTelegramFile(env,file);
    if(s.kind==='mvsep'){
      if(s.widget==='matchering_upload'){
        s.step='file_reference';s.first_id=file.file_id;await setSession(env,chat,s);return message(env,chat,'Now send the reference audio file.');
      }
      return submitMv(env,chat,s,b);
    }
    return uploadImage(env,chat,s,b);
  }
  if(s.step==='file_reference'&&file){
    const first=await getTelegramFile(env,{file_id:s.first_id});
    const second=await getTelegramFile(env,file);
    return submitMv(env,chat,s,first,second);
  }
  return message(env,chat,'Expected input: '+(s.step.startsWith('file')?'image/audio file':'text')+'. Use /cancel to reset.');
}
async function handleCallback(env,q) {
  const chat=q.message?.chat?.id,usr=q.from?.id;if(!chat||!usr)return;
  await tg(env,'answerCallbackQuery',{callback_query_id:q.id});
  const d=String(q.data||'').replace(/^st:/,'');
  if(d==='home') {await setSession(env,chat,{step:'home'});return message(env,chat,'Welcome to CYAW Media Studio',home);}
  if(d==='help')return message(env,chat,HELP,home);
  if(d==='jobs')return sendRecent(env,chat);
  if(d==='upgen:menu')return imageUpMenu(env,chat);
  if(d.startsWith('upgen:model:')){
    const i=Number(d.slice('upgen:model:'.length)),model=UPGEN_MODELS[i];if(!model)throw Error('Invalid image model');
    const s={kind:'imageup-gen',step:'upgen_aspect',model:model.id,refs:model.refs,references:[]};await setSession(env,chat,s);
    return imageUpAspect(env,chat,s);
  }
  if(d.startsWith('upgen:ratio:')){
    const s=await session(env,chat),ratio=UPGEN_ASPECTS[Number(d.slice('upgen:ratio:'.length))];
    if(s.kind!=='imageup-gen'||!UPGEN_MODELS.some(m=>m.id===s.model)||!ratio)throw Error('Choose a generation model first');
    s.aspect=ratio;s.step=s.refs?'upgen_file':'upgen_prompt';await setSession(env,chat,s);
    return message(env,chat,s.model+' '+ratio+' selected. '+(s.refs?'Send a reference image. You can attach up to two photos.':'Send your image-generation prompt. You can ask AI to improve it before generating.'));
  }
  if(d==='tts:menu')return siteTtsMenu(env,chat);
  if(d.startsWith('tts:lang:')){
    const lang=d.slice('tts:lang:'.length),voices=SITE_TTS_VOICES[lang];if(!voices)throw Error('Unsupported TTS language');
    const s={step:'tts_voice',kind:'tts',language:lang};await setSession(env,chat,s);
    const rows=[];for(let i=0;i<voices.length;i+=2)rows.push(voices.slice(i,i+2).map(v=>btn(v,'tts:voice:'+v)));
    return message(env,chat,'Choose a speech voice:',keys(rows));
  }
  if(d.startsWith('tts:voice:')){
    const voice=d.slice('tts:voice:'.length),s=await session(env,chat);
    if(s.kind!=='tts'||!Object.values(SITE_TTS_VOICES).flat().includes(voice))throw Error('Choose a supported TTS voice');
    s.voice=voice;s.step='tts_speed';await setSession(env,chat,s);
    return message(env,chat,'Speed for '+voice+':',keys([[btn('0.8×','speed:0.8'),btn('1.0×','speed:1'),btn('1.2×','speed:1.2')]]));
  }
  if(d==='tts:submit'){
    const s=await session(env,chat);
    if(s.kind!=='tts'||s.step!=='tts_confirm'||!s.text?.trim())throw Error('Enter speech text and confirm first');
    const lock=await env.MEMORY_DB.prepare('UPDATE studio_sessions SET state=?,updated_at=? WHERE chat_id=? AND state=?').bind(JSON.stringify({...s,step:'tts_submitting'}),epoch(),String(chat),JSON.stringify(s)).run();
    if(!lock.meta?.changes)return message(env,chat,'Already submitted.');
    // On uncertain network failures, keep the submitting state to prevent a
    // second quota-consuming call. The user may intentionally cancel/reset.
    return await submitTts(env,chat,s,s.text);
  }
  if(d==='provider:menu')return message(env,chat,'🎨 Choose image generation provider. Best quality tries Qwen-Image-2.1 ZeroGPU first, or OVHcloud SDXL if unavailable. Qwen 2.1 is research-licensed: choose OVHcloud for commercial work. Paid credits are opt-in.',imageProviders);
  if(d.startsWith('provider:')){
    const provider=d.slice('provider:'.length);
    if(!['best','ovh','hf','hfzero','modelscope'].includes(provider))throw Error('Unknown image provider');
    await setSession(env,chat,{step:'provider_prompt',kind:'generate',imageProvider:provider});
    const name=provider==='best'?'Best quality (Qwen-Image-2.1 ZeroGPU → OVHcloud SDXL)':provider==='ovh'?'OVHcloud SDXL (no API key)':provider==='hf'?'Hugging Face FLUX':provider==='hfzero'?'Hugging Face ZeroGPU Qwen 2.1':'ModelScope Qwen Image';
    return message(env,chat,'Selected: '+name+'.\n\nSend your image prompt. I will offer to improve it, let you review it, and ask for confirmation before generating.');
  }
  if(d.startsWith('i:'))return pickImage(env,chat,d.slice(2));
  if(d.startsWith('imgmodel:')){
    const i=Number(d.slice('imgmodel:'.length)),model=IMAGE_MODELS[i];
    if(!model)throw Error('Unsupported image model');
    const state={step:model.output==='base64'?'prompt':'imgsize',kind:'generate',model:model.id,steps:model.steps};
    await setSession(env,chat,state);
    if(model.output==='base64')return message(env,chat,'✅ FLUX.1 Schnell selected. Send a detailed image prompt (max 2048 characters).');
    return message(env,chat,model.name+' — choose aspect ratio:',keys([
      [btn('◻ Square 768×768','imgsize:square')],
      [btn('▭ Landscape 1024×576','imgsize:landscape')],
      [btn('▯ Portrait 576×1024','imgsize:portrait')],
      [btn('🏠 Home','home')]
    ]));
  }
  if(d.startsWith('imgsize:')){
    const s=await session(env,chat);
    if(s.kind!=='generate'||!IMAGE_MODELS.some(x=>x.id===s.model))throw Error('Choose image model first');
    const sizes={square:[768,768],landscape:[1024,576],portrait:[576,1024]};
    const dimensions=sizes[d.slice('imgsize:'.length)];
    if(!dimensions)throw Error('Invalid image dimensions');
    s.width=dimensions[0];s.height=dimensions[1];s.step='prompt';
    await setSession(env,chat,s);
    return message(env,chat,'✅ '+IMAGE_MODELS.find(x=>x.id===s.model).name+' · '+s.width+'×'+s.height+
      '\nSend your prompt (1–2048 characters).');
  }
  if(d.startsWith('upmodel:'))return startScale(env,chat,d.slice(8));
  if(d.startsWith('scale:'))return finishScale(env,chat,d.slice(6));
  if(d.startsWith('face:')){const s=await session(env,chat);s.face=d.endsWith('yes');s.step='file';await setSession(env,chat,s);if(s.savedMedia){const b=await getTelegramFile(env,s.savedMedia);return uploadImage(env,chat,s,b);}return message(env,chat,'Send the image to upscale.');}
  if(d.startsWith('mv:')){const [,scope,p]=d.split(':');return showCatalog(env,chat,scope,Number(p)||0);}
  if(d.startsWith('model:')){const [,id,scope]=d.split(':');return mvModel(env,chat,id,scope);}
  if(d.startsWith('opage:')){const s=await session(env,chat);s.optionPage=Number(d.split(':')[1]);await setSession(env,chat,s);return showOptions(env,chat,s);}
  if(d.startsWith('opt:')){const s=await session(env,chat),index=Number(d.split(':')[1]);if(d==='opt:skip')return advanceField(env,chat,'',true);const opt=Object.entries(s.fields[s.fieldIndex].options||{})[index];if(!opt)throw Error('Option unavailable');return advanceField(env,chat,opt[0]);}
  if(d.startsWith('fmt:'))return readyMv(env,chat,d.slice(4));
  if(d==='mvsubmit'){
    const s=await session(env,chat);
    if(s.kind==='mvsep'&&s.step==='submitting')return message(env,chat,'⏳ MVSEP submission is already underway. Do not tap Generate again.');
    if(s.kind!=='mvsep'||s.widget!=='no_upload'||s.step!=='confirm')throw Error('Select a model and finish its parameters first');
    const invalid=s.fields.find(f=>f.required&&!String(s.values[f.name]||'').trim());
    if(invalid)return message(env,chat,'⚠️ Required MVSEP field missing: '+invalid.label+'. Please select the model again.');
    // Atomic guard against double-tap duplicate billable submissions.
    const lock=await env.MEMORY_DB.prepare('UPDATE studio_sessions SET state=?,updated_at=? WHERE chat_id=? AND state=?')
      .bind(JSON.stringify({...s,step:'submitting'}),epoch(),String(chat),JSON.stringify(s)).run();
    if(!lock.meta?.changes)return message(env,chat,'⏳ This submission was already started.');
    try{return await submitMv(env,chat,s)}
    catch(e){await setSession(env,chat,s);throw e;}
  }
  if(d.startsWith('speed:')){const s=await session(env,chat);s.speed=Number(d.slice(6));s.step='tts_text';await setSession(env,chat,s);return message(env,chat,'Send text to speak. Maximum 60,000 characters.');}
}

const STUDIO_COMMANDS=new Set(['/imageup_status','/imageup','/studio','/image','/genimage','/upscale','/removebg','/reimagine','/mvvoice','/mvaudio','/mvseparate','/mvsep','/mvall','/studiomodels','/studiojobs','/usage','/studiohelp','/studio_cancel','/imagetts']);
export const mediaStudioCommands=[
  {command:'usage',description:'Credits, quotas and AI requests'},
  {command:'studio',description:'Image and audio creation hub'},
  {command:'genimage',description:'Generate image with Workers AI'},
  {command:'imageup',description:'Image-upscaling.net text-to-image and editing'},
  {command:'imageup_status',description:'Check image-upscaling.net jobs'},
  {command:'upscale',description:'Choose upscaling model and size'},
  {command:'removebg',description:'Remove an image background'},
  {command:'reimagine',description:'Apply artistic style to an image'},
  {command:'mvvoice',description:'Choose MVSEP speech/voice model'},
  {command:'mvaudio',description:'Choose MVSEP music/sound model'},
  {command:'mvseparate',description:'Choose MVSEP separation model'},
  {command:'mvsep',description:'Browse all MVSEP models and options'},
  {command:'imagetts',description:'Image provider text-to-speech'},
  {command:'studiojobs',description:'View recent media studio jobs'}
];
export async function handleMediaStudioMessage(env,m) {
  if(!env.MEMORY_DB)return false;
  const chat=m.chat?.id;if(!chat)return false;
  const text=(m.text||m.caption||'').trim(),cmd=text.split(/\s+/)[0].split('@')[0].toLowerCase();
  let active=STUDIO_COMMANDS.has(cmd);
  if(!active && !text.startsWith('/')){
    const current=await session(env,chat);
    active=!!current && current.step!=='home';
  }
  if(!active)return false;
  try{await handleMessage(env,m);}
  catch(err){console.error('Studio error',err?.name||'unknown');await message(env,chat,'⚠️ '+truncate(err?.message||'The provider rejected this request',270));}
  return true;
}
export async function handleMediaStudioCallback(env,q){
  try{await handleCallback(env,q);}
  catch(err){
    console.error('Studio callback error',err?.name||'unknown');
    const id=q.message?.chat?.id;
    if(id)await message(env,id,'⚠️ '+truncate(err?.message||'Choose another option',270));
  }
}
export async function pollMediaStudio(env) {if(!env.MEMORY_DB||!env.TELEGRAM_BOT_TOKEN)return;await pollAll(env);}

// Natural language agent entry points. Reuse the exact existing studio submit/confirm logic.
export async function startNaturalVoice(env,chat,text,style='custom') {
  const models=await catalog('all');
  const target=models.find(x=>Number(x.render_id)===(style==='design'?119:118));
  if(!target)throw Error('MVSEP Qwen3 speech model is unavailable');
  const fields=optFields(target),values={};
  for(const f of fields){
    if(/text prompt/i.test(f.label))values[f.name]=text;
    else if(/speaker/i.test(f.label))values[f.name]='aiden';
    else if(/language/i.test(f.label))values[f.name]='auto';
    else if(/voice description/i.test(f.label))values[f.name]='Clear natural voice with expressive but controlled delivery';
    else if(f.defaultKey!==null)values[f.name]=f.defaultKey;
  }
  const incomplete=fields.filter(f=>f.required&&!String(values[f.name]||'').trim());
  if(incomplete.length)throw Error('Missing MVSEP required field: '+incomplete.map(x=>x.label).join(', '));
  const state={step:'confirm',kind:'mvsep',scope:'voice',model:target.render_id,modelName:target.name,widget:target.audio_widget,fields,values,format:1};
  await setSession(env,chat,state);
  return message(env,chat,'🗣 Prepared '+target.name+'\n\nText: '+truncate(text,900)+'\n\nSpeaker: '+(style==='design'?'Voice Design':'Aiden')+' · Language: Auto · WAV 16-bit\n\nReview before submitting. MVSEP may charge credits. You can adjust the voice via /mvvoice.',keys([[btn('✅ Generate audio','mvsubmit'),btn('Cancel','home')]]));
}
export async function startNaturalEdit(env,chat,kind,photo,details='') {
  const name=kind==='removebg'?'removebg':kind==='upscale'?'upscale':'reimagine';
  if(!photo){await pickImage(env,chat,name);return;}
  if(name==='removebg'){await setSession(env,chat,{step:'file',kind:name});return handleMessage(env,{chat:{id:chat},from:{id:chat},photo:[photo]});}
  if(name==='reimagine'){
    await setSession(env,chat,{step:'file',kind:name,style:/oil painting/i.test(details)?'Oil_Painting':'Oil_Painting'});
    return handleMessage(env,{chat:{id:chat},from:{id:chat},photo:[photo]});
  }
  await pickImage(env,chat,'upscale');
  const s=await session(env,chat);s.savedMedia=photo;await setSession(env,chat,s);
  return message(env,chat,'📷 Your image is saved for this upscaling request. Choose a model and scale; you do not need to resend it.');
}

export async function startNaturalAudio(env,chat,text){
 const models=await catalog('all'),a=models.find(x=>Number(x.render_id)===62);
 if(!a)throw Error('MVSEP Stable Audio model is unavailable');
 const fields=optFields(a),values={};
 for(const f of fields){
   if(/text prompt/i.test(f.label))values[f.name]=text;
   else if(/length/i.test(f.label))values[f.name]='10';
   else if(f.defaultKey!==null)values[f.name]=String(f.defaultKey);
 }
 const invalid=fields.find(f=>f.required&&!String(values[f.name]||'').trim());
 if(invalid)throw Error('Missing sound-generation field: '+invalid.label);
 await setSession(env,chat,{step:'confirm',kind:'mvsep',scope:'audio',model:a.render_id,modelName:a.name,widget:a.audio_widget,fields,values,format:1});
 return message(env,chat,'🎼 I selected Stable Audio Open Gen 1.0.\n\nPrompt: '+truncate(text,1100)+'\nLength: 10 seconds · WAV 16-bit\n\nGenerate? MVSEP credits may apply.',keys([[btn('✅ Generate audio','mvsubmit'),btn('Cancel','home')]]));
}

export async function startNaturalImageSiteTts(env,chat,text){
 if(!text||text.length>60000)throw Error('TTS text must contain 1–60000 characters');
 const state={step:'tts_confirm',kind:'tts',voice:'am_michael',speed:1,text};
 await setSession(env,chat,state);
 return message(env,chat,'🎙 image-upscaling.net TTS\nVoice: am_michael · Speed: 1.0×\n\nText: '+truncate(text,900)+'\n\nConfirm generation using your image-provider daily free quota or balance. To change the voice, use /imagetts.',keys([[btn('✅ Generate speech','tts:submit'),btn('Cancel','home')]]));
}
