/** Owner-only Telegram dubbing wizard. Detect original speech automatically.
 * Target -> TTS engine -> (Gemini model) -> voice -> ready. No hidden defaults.
 */
type DB={prepare(query:string):{bind(...v:(string|number)[]):{
 run():Promise<{meta:{changes:number}}>;all<T>():Promise<{results:T[]}>
}}}
export type DubMenuEnv={MEMORY_DB:DB;TELEGRAM_BOT_TOKEN:string}
export type DubCallback={id:string;data?:string;from:{id:number};
 message?:{chat:{id:number;type?:string};message_id:number}}
type Selection={chat_id:string;source_lang:string;target_lang:string;engine:string;
 voice:string;voice_slot:number;translation_provider:string;remove_subtitles:number;stage:string;updated_at:number}
type Button={text:string;callback_data:string}
const edgeVoices:Record<string,{name:string;code:string}[]>={
 en:[
  {name:'Aria • female (US)',code:'en-US-AriaNeural'},
  {name:'Guy • male (US)',code:'en-US-GuyNeural'},
  {name:'Christopher • male (US)',code:'en-US-ChristopherNeural'}
 ],
 my:[
  {name:'Nilar • female (Myanmar)',code:'my-MM-NilarNeural'},
  {name:'Thiha • male (Myanmar)',code:'my-MM-ThihaNeural'}
 ]
}
const kokoroVoices=[
 {name:'Heart · warm female US',code:'af_heart'},
 {name:'Bella · expressive female US',code:'af_bella'},
 {name:'Nicole · clear female US',code:'af_nicole'},
 {name:'Sarah · polished female US',code:'af_sarah'},
 {name:'Michael · natural male US',code:'am_michael'},
 {name:'Adam · deep male US',code:'am_adam'},
 {name:'Emma · female UK',code:'bf_emma'},
 {name:'Isabella · female UK',code:'bf_isabella'},
 {name:'George · male UK',code:'bm_george'},
 {name:'Lewis · male UK',code:'bm_lewis'}
]
const geminiVoices=[
 {name:'Kore • firm',code:'Kore'},
 {name:'Aoede • breezy',code:'Aoede'},
 {name:'Puck • upbeat',code:'Puck'},
 {name:'Charon • informative',code:'Charon'},
 {name:'Leda • youthful',code:'Leda'},
 {name:'Fenrir • energetic',code:'Fenrir'},
 {name:'Zephyr • bright',code:'Zephyr'},
 {name:'Orus • firm',code:'Orus'}
]
const buttons=(rows:Button[][])=>({inline_keyboard:rows})
async function send(env:DubMenuEnv,method:'sendMessage'|'answerCallbackQuery',data:Record<string,unknown>){
 const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/'+method,{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(15000)
 })
 const obj=await r.json().catch(()=>({})) as {ok?:boolean}
 if(!r.ok||!obj.ok)throw new Error('Telegram '+method+' failed')
}
export async function ensureDubMenu(db:DB):Promise<void>{
 await db.prepare('CREATE TABLE IF NOT EXISTS pyvt_dub_selections ('+
  'chat_id TEXT PRIMARY KEY,source_lang TEXT NOT NULL DEFAULT "auto",'+
  'target_lang TEXT NOT NULL DEFAULT "my",engine TEXT NOT NULL DEFAULT "edge",'+
  'voice TEXT NOT NULL DEFAULT "my-MM-NilarNeural",'+
  'voice_slot INTEGER NOT NULL DEFAULT 0,translation_provider TEXT NOT NULL DEFAULT "freellm",stage TEXT NOT NULL DEFAULT "target",'+
  'updated_at INTEGER NOT NULL DEFAULT (unixepoch()))').bind().run()
 await db.prepare('ALTER TABLE pyvt_dub_selections ADD COLUMN translation_provider TEXT NOT NULL DEFAULT "freellm"').bind().run().catch(()=>undefined)
 await db.prepare('ALTER TABLE pyvt_dub_selections ADD COLUMN remove_subtitles INTEGER NOT NULL DEFAULT 1 CHECK(remove_subtitles IN (0,1))').bind().run().catch(()=>undefined)
}
async function removeMenu(env:DubMenuEnv,chat:string,target:'en'|'my'){
 await send(env,'sendMessage',{chat_id:chat,
  text:'Step 2 — '+(target==='my'?'Burmese':'English')+' dubbing: remove the original subtitles embedded in the video?\n\n✅ Yes — AI removal (slower, best for Chinese hard subtitles).\n⚡ No — skip AI removal (faster, original picture unchanged).',
  reply_markup:buttons([
   [{text:'✅ Yes — remove original subtitles',callback_data:'pd:remove:yes'}],
   [{text:'⚡ No — keep original picture',callback_data:'pd:remove:no'}]
  ])})
}
async function translatorMenu(env:DubMenuEnv,chat:string){
 await send(env,'sendMessage',{chat_id:chat,
  text:'Step 2 — Choose Burmese subtitle translation provider. Original language will be detected automatically.',
  reply_markup:buttons([
   [{text:'🆓 FreeLLM (your API key)',callback_data:'pd:translator:freellm'}],
   [{text:'✨ Gemini (your API key)',callback_data:'pd:translator:gemini'}],
   [{text:'🌐 Google Translate free (unofficial)',callback_data:'pd:translator:google'}]
  ])
 })
}
async function engineMenu(env:DubMenuEnv,chat:string,target:'en'|'my'){
 await send(env,'sendMessage',{chat_id:chat,
  text:'🎙 Target: '+(target==='my'?'Burmese':'English')+
   '\nOriginal speech will be detected automatically.\n\nStep 2 — Choose the TTS engine:',
  reply_markup:buttons([
   [{text:'🔊 Microsoft Edge TTS (CPU)',callback_data:'pd:engine:edge'}],
   [{text:'🎤 VoxCPM2 (Kaggle GPU)',callback_data:'pd:engine:vox'}],
   [{text:'✨ Gemini TTS (API)',callback_data:'pd:engine:gemini'}],
   ...(target==='en'?[[{text:'🗣 Kokoro TTS (open source)',callback_data:'pd:engine:kokoro'}]]:[])
  ])
 })
}
export async function startDubMenu(env:DubMenuEnv,chat:string,target?:'en'|'my'):Promise<void>{
 await ensureDubMenu(env.MEMORY_DB)
 const stage=target?'remove':'target'
 await env.MEMORY_DB.prepare(
  'INSERT INTO pyvt_dub_selections(chat_id,stage,source_lang,target_lang,engine,voice,voice_slot,translation_provider) '+
  "VALUES(?,?,'auto',?,'edge','',0,'freellm') "+
  "ON CONFLICT(chat_id) DO UPDATE SET stage=excluded.stage,source_lang='auto',"+
  'target_lang=excluded.target_lang,translation_provider=\'freellm\',remove_subtitles=1,voice=\'\',voice_slot=0,updated_at=unixepoch()'
 ).bind(chat,stage,target||'my').run()
 if(target){await removeMenu(env,chat,target);return}
 await send(env,'sendMessage',{chat_id:chat,
  text:'🎬 Dub my video\nChoose only the TARGET language; original speech is detected automatically.',
  reply_markup:buttons([
   [{text:'🇲🇲 Burmese',callback_data:'pd:lang:my'}],
   [{text:'🇬🇧 English',callback_data:'pd:lang:en'}]
  ])})
}
export async function selectedDubCommand(env:DubMenuEnv,chat:string):Promise<string|null>{
 await ensureDubMenu(env.MEMORY_DB)
 const r=await env.MEMORY_DB.prepare(
  'SELECT source_lang,target_lang,engine,voice,voice_slot,translation_provider,remove_subtitles,stage FROM pyvt_dub_selections WHERE chat_id=?'
 ).bind(chat).all<Selection>()
 const s=r.results[0]
 if(!s||s.stage!=='ready'||s.source_lang!=='auto'||!['en','my'].includes(s.target_lang))return null
 const mode=s.remove_subtitles===0?' keep':' remove'
 if(s.engine==='vox'){
  if(!Number.isInteger(s.voice_slot)||s.voice_slot<0||s.voice_slot>5)return null
  return '/dub vox auto '+s.target_lang+' '+s.voice_slot+' '+s.translation_provider+mode
 }
 if(s.engine==='edge'){
  if(!(edgeVoices[s.target_lang]||[]).some(v=>v.code===s.voice))return null
  return '/dub edge auto '+s.target_lang+' '+s.voice+' '+s.translation_provider+mode
 }
 if(s.engine==='gemini'){
  const [model,voice]=s.voice.split('-')
  if(!['flash','lite'].includes(model)||!geminiVoices.some(v=>v.code===voice)||
   (s.target_lang==='my'&&model!=='flash'))return null
  return '/dub gemini auto '+s.target_lang+' '+s.voice+' '+s.translation_provider+mode
 }
 if(s.engine==='kokoro'&&s.target_lang==='en'&&kokoroVoices.some(v=>v.code===s.voice))
  return '/dub kokoro auto en '+s.voice+' '+s.translation_provider+mode
 return null
}
export async function dubMenuCallback(env:DubMenuEnv,cb:DubCallback):Promise<boolean|void>{
 const chat=String(cb.message?.chat.id||'')
 try{
  if(!chat||String(cb.from.id)!==chat||!cb.data?.startsWith('pd:'))return
  await ensureDubMenu(env.MEMORY_DB)
  const current=(await env.MEMORY_DB.prepare(
   'SELECT chat_id,source_lang,target_lang,engine,voice,voice_slot,translation_provider,remove_subtitles,stage,updated_at FROM pyvt_dub_selections WHERE chat_id=?'
  ).bind(chat).all<Selection>()).results[0]
  if(!current)throw new Error('Selection expired')
  const [_,action,value]=cb.data.split(':')
  if(action==='lang'&&current.stage==='target'&&(value==='my'||value==='en')){
   await env.MEMORY_DB.prepare(
    "UPDATE pyvt_dub_selections SET target_lang=?,source_lang='auto',stage=?,translation_provider='freellm',updated_at=unixepoch() "+
    "WHERE chat_id=? AND stage='target'"
   ).bind(value,'remove',chat).run()
   await removeMenu(env,chat,value)
   return
  }
  if(action==='remove'&&current.stage==='remove'&&['yes','no'].includes(value)){
   const stage=current.target_lang==='my'?'translator':'engine'
   await env.MEMORY_DB.prepare(
    "UPDATE pyvt_dub_selections SET remove_subtitles=?,stage=?,updated_at=unixepoch() WHERE chat_id=? AND stage='remove'"
   ).bind(value==='yes'?1:0,stage,chat).run()
   if(current.target_lang==='my')await translatorMenu(env,chat)
   else await engineMenu(env,chat,'en')
   return
  }
  if(action==='translator'&&current.stage==='translator'&&['freellm','gemini','google'].includes(value)){
   await env.MEMORY_DB.prepare(
    "UPDATE pyvt_dub_selections SET translation_provider=?,stage='engine',updated_at=unixepoch() WHERE chat_id=? AND stage='translator'"
   ).bind(value,chat).run()
   await engineMenu(env,chat,'my')
   return
  }
  if(action==='engine'&&current.stage==='engine'&&['edge','vox','gemini','kokoro'].includes(value)&&
   (value!=='kokoro'||current.target_lang==='en')){
   const stage=value==='gemini'?'model':'voice'
   await env.MEMORY_DB.prepare(
    "UPDATE pyvt_dub_selections SET engine=?,voice='',voice_slot=0,stage=?,updated_at=unixepoch() "+
    "WHERE chat_id=? AND stage='engine'"
   ).bind(value,stage,chat).run()
   if(value==='gemini'){
    const options:Button[][]=[
     [{text:'Gemini 3.8 Flash TTS • multilingual',callback_data:'pd:model:flash'}]
    ]
    if(current.target_lang==='en')options.push([
     {text:'Gemini 3.8 Flash-Lite • English',callback_data:'pd:model:lite'}
    ])
    await send(env,'sendMessage',{chat_id:chat,text:'Step 3 — Choose a Gemini TTS model.\nBurmese requires 3.8 Flash TTS.',
     reply_markup:buttons(options)})
    return
   }
   if(value==='kokoro'){
    await send(env,'sendMessage',{chat_id:chat,text:'Step 3 — Choose Kokoro voice / model:',
     reply_markup:buttons(kokoroVoices.map((v,i)=>[{text:v.name,callback_data:'pd:voice:k'+i}]))})
    return
   }
   if(value==='edge'){
    const voices=edgeVoices[current.target_lang]||[]
    await send(env,'sendMessage',{chat_id:chat,
     text:'Step 3 — Choose an Edge TTS voice:',
     reply_markup:buttons(voices.map((v,i)=>[{text:v.name,callback_data:'pd:voice:e'+i}]))})
    return
   }
   const saved=await env.MEMORY_DB.prepare(
    'SELECT slot,name FROM vox_saved_voices WHERE chat_id=? ORDER BY slot'
   ).bind(chat).all<{slot:number;name:string}>()
   const rows:Button[][]=[[{text:'Default narrator',callback_data:'pd:voice:v0'}]]
   for(const v of saved.results)if(Number.isInteger(v.slot)&&v.slot>=1&&v.slot<=5)
    rows.push([{text:'Voice '+v.slot+' • '+v.name.slice(0,30),callback_data:'pd:voice:v'+v.slot}])
   await send(env,'sendMessage',{chat_id:chat,text:'Step 3 — Choose a VoxCPM2 voice or saved voice clone:',
    reply_markup:buttons(rows)})
   return
  }
  if(action==='model'&&current.stage==='model'&&
   (value==='flash'||(value==='lite'&&current.target_lang==='en'))){
   await env.MEMORY_DB.prepare(
    "UPDATE pyvt_dub_selections SET voice=?,stage='voice',updated_at=unixepoch() WHERE chat_id=? AND stage='model'"
   ).bind(value+'-',chat).run()
   await send(env,'sendMessage',{chat_id:chat,text:'Step 4 — Choose a Gemini voice:',
    reply_markup:buttons(geminiVoices.map((v,i)=>[{text:v.name,callback_data:'pd:voice:g'+i}]))})
   return
  }
  if(action==='voice'&&current.stage==='voice'&&/^[evgk][0-9]$/.test(value)){
   let voice='',slot=0,label=''
   if(current.engine==='edge'&&value[0]==='e'){
    const v=(edgeVoices[current.target_lang]||[])[Number(value[1])]
    if(!v)throw new Error('Invalid Edge voice')
    voice=v.code;label=v.name
   }else if(current.engine==='kokoro'&&value[0]==='k'&&current.target_lang==='en'){
    const v=kokoroVoices[Number(value[1])]
    if(!v)throw new Error('Invalid Kokoro voice')
    voice=v.code;label=v.name
   }else if(current.engine==='vox'&&value[0]==='v'){
    slot=Number(value[1])
    if(slot>5)throw new Error('Invalid voice slot')
    if(slot){
     const existing=await env.MEMORY_DB.prepare(
      'SELECT name FROM vox_saved_voices WHERE chat_id=? AND slot=?'
     ).bind(chat,slot).all<{name:string}>()
     if(!existing.results[0])throw new Error('Saved voice unavailable')
     label='Saved voice '+slot+' • '+existing.results[0].name
    }else label='Default VoxCPM2 narrator'
    voice='Narrator'
   }else if(current.engine==='gemini'&&value[0]==='g'){
    const v=geminiVoices[Number(value[1])]
    const prefix=current.voice
    if(!v||!['flash-','lite-'].includes(prefix)||current.target_lang==='my'&&prefix!=='flash-')
     throw new Error('Invalid Gemini model/voice')
    voice=prefix+v.code
    label=v.name+' • '+(prefix==='flash-'?'Gemini 3.8 Flash':'Gemini 3.8 Flash-Lite')
   }else throw new Error('Engine/voice mismatch')
   await env.MEMORY_DB.prepare(
    "UPDATE pyvt_dub_selections SET voice=?,voice_slot=?,stage='ready',updated_at=unixepoch() "+
    "WHERE chat_id=? AND stage='voice'"
   ).bind(voice,slot,chat).run()
   await send(env,'sendMessage',{chat_id:chat,text:
    '✅ Target: '+(current.target_lang==='my'?'Burmese':'English')+
    '\n🎧 Source: auto-detected'+
    '\n🎙 Engine: '+(current.engine==='edge'?'Microsoft Edge':current.engine==='vox'?'VoxCPM2':current.engine==='kokoro'?'Kokoro':'Gemini TTS')+
    '\n🔊 Voice/model: '+label+
    '\n🧹 Original subtitles: '+(current.remove_subtitles===1?'Remove':'Keep')+
    '\n🌐 Translation: '+(current.translation_provider==='freellm'?'FreeLLM':current.translation_provider==='google'?'Google free':'Gemini')+
    '\n\nSend a video up to 20 MB, or use /dub_upload for larger files. Your recent video is reused automatically.'
   })
   return true
  }
  await send(env,'sendMessage',{chat_id:chat,text:'That choice expired. Send /dub to restart.'})
 }catch(e){
  console.error('pyvt wizard',e instanceof Error?e.message:'unknown')
  if(chat)await send(env,'sendMessage',{chat_id:chat,
   text:'Dubbing selection could not be saved. Please send /dub again.'}).catch(()=>undefined)
 }finally{
  await send(env,'answerCallbackQuery',{callback_query_id:cb.id}).catch(()=>undefined)
 }
}
