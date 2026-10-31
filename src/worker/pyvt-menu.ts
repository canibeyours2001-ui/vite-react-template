/** Private Telegram inline menu for pyVideoTrans language, dubbing engine and voice. */
type DB={prepare(query:string):{bind(...v:(string|number)[]):{
 run():Promise<{meta:{changes:number}}>;all<T>():Promise<{results:T[]}>
}}}
export type DubMenuEnv={MEMORY_DB:DB;TELEGRAM_BOT_TOKEN:string}
export type DubCallback={id:string;data?:string;from:{id:number};
 message?:{chat:{id:number;type?:string};message_id:number}}
type Selection={chat_id:string;source_lang:string;target_lang:string;engine:string;
 voice:string;voice_slot:number;stage:string;updated_at:number}
type Button={text:string;callback_data:string}
const edgeVoices:Record<string,{name:string;code:string}[]>={
 en:[
  {name:'Aria • woman (US)',code:'en-US-AriaNeural'},
  {name:'Guy • man (US)',code:'en-US-GuyNeural'},
  {name:'Christopher • man (US)',code:'en-US-ChristopherNeural'}
 ],
 my:[
  {name:'Nilar • woman (Burmese)',code:'my-MM-NilarNeural'},
  {name:'Thiha • man (Burmese)',code:'my-MM-ThihaNeural'}
 ]
}
export async function ensureDubMenu(db:DB):Promise<void>{
 await db.prepare(
  'CREATE TABLE IF NOT EXISTS pyvt_dub_selections ('+
  'chat_id TEXT PRIMARY KEY,source_lang TEXT NOT NULL DEFAULT "en",'+
  'target_lang TEXT NOT NULL DEFAULT "my",engine TEXT NOT NULL DEFAULT "edge",'+
  'voice TEXT NOT NULL DEFAULT "my-MM-NilarNeural",'+
  'voice_slot INTEGER NOT NULL DEFAULT 0,stage TEXT NOT NULL DEFAULT "target",'+
  'updated_at INTEGER NOT NULL DEFAULT (unixepoch()))'
 ).bind().run()
}
async function send(env:DubMenuEnv,method:'sendMessage'|'answerCallbackQuery',
 payload:Record<string,unknown>){
 const res=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/'+method,{
  method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)})
 const data=await res.json().catch(()=>({})) as {ok?:boolean}
 if(!res.ok||!data.ok)throw Error('Telegram '+method+' failed')
}
const buttons=(rows:Button[][])=>({inline_keyboard:rows})
export async function startDubMenu(env:DubMenuEnv,chat:string):Promise<void>{
 await ensureDubMenu(env.MEMORY_DB)
 await env.MEMORY_DB.prepare(
  'INSERT INTO pyvt_dub_selections(chat_id,stage,source_lang,target_lang,engine,voice,voice_slot) '+
  "VALUES(?,'target','en','my','edge','my-MM-NilarNeural',0) "+
  "ON CONFLICT(chat_id) DO UPDATE SET stage='target',updated_at=unixepoch()"
 ).bind(chat).run()
 await send(env,'sendMessage',{chat_id:chat,
  text:'🎬 pyVideoTrans dubbing\nStep 1/3 — Choose the language you want in the final video.',
  reply_markup:buttons([
   [{text:'🇬🇧 English',callback_data:'pd:lang:en'}],
   [{text:'🇲🇲 Burmese (မြန်မာ)',callback_data:'pd:lang:my'}]
  ])})
}
export async function selectedDubCommand(env:DubMenuEnv,chat:string):Promise<string|null>{
 await ensureDubMenu(env.MEMORY_DB)
 const r=await env.MEMORY_DB.prepare(
  "SELECT source_lang,target_lang,engine,voice,voice_slot,stage FROM pyvt_dub_selections WHERE chat_id=?"
 ).bind(chat).all<Selection>()
 const s=r.results[0]
 if(!s||s.stage!=='ready')return null
 // Literal command generated only from validated and private D1 menu selections.
 if(!['en','my'].includes(s.source_lang)||!['en','my'].includes(s.target_lang)||
  !['vox','edge'].includes(s.engine))return null
 if(s.engine==='vox'){
  if(s.voice_slot<0||s.voice_slot>5)return null
  return '/dub vox '+s.source_lang+' '+s.target_lang+(s.voice_slot?' '+s.voice_slot:'')
 }
 const allowed=(edgeVoices[s.target_lang]||[]).some(v=>v.code===s.voice)
 if(!allowed)return null
 return '/dub edge '+s.source_lang+' '+s.target_lang+' '+s.voice
}
export async function dubMenuCallback(env:DubMenuEnv,cb:DubCallback):Promise<void>{
 const chat=String(cb.message?.chat.id??'')
 try{
  if(!chat||String(cb.from.id)!==chat||!cb.data?.startsWith('pd:'))return
  await ensureDubMenu(env.MEMORY_DB)
  const current=(await env.MEMORY_DB.prepare(
   'SELECT chat_id,source_lang,target_lang,engine,voice,voice_slot,stage,updated_at FROM pyvt_dub_selections WHERE chat_id=?'
  ).bind(chat).all<Selection>()).results[0]
  if(!current)throw Error('Selection expired. Restart /dub.')
  const [_,action,value]=cb.data.split(':')
  if(action==='lang'&&current.stage==='target'&&['en','my'].includes(value)){
   const source=value==='en'?'my':'en'
   await env.MEMORY_DB.prepare(
    "UPDATE pyvt_dub_selections SET source_lang=?,target_lang=?,stage='engine',updated_at=unixepoch() "+
    "WHERE chat_id=? AND stage='target'"
   ).bind(source,value,chat).run()
   await send(env,'sendMessage',{chat_id:chat,
    text:'Step 2/3 — '+(source==='my'?'Burmese':'English')+' → '+(value==='my'?'Burmese':'English')+
     '\nChoose the dubbing engine.',
    reply_markup:buttons([
     [{text:'🔊 Microsoft Edge TTS',callback_data:'pd:engine:edge'}],
     [{text:'🎙️ VoxCPM2 (Kaggle GPU)',callback_data:'pd:engine:vox'}]
    ])})
   return
  }
  if(action==='engine'&&current.stage==='engine'&&['edge','vox'].includes(value)){
   await env.MEMORY_DB.prepare(
    "UPDATE pyvt_dub_selections SET engine=?,stage='voice',updated_at=unixepoch() "+
    "WHERE chat_id=? AND stage='engine'"
   ).bind(value,chat).run()
   if(value==='edge'){
    const voices=edgeVoices[current.target_lang]||[]
    await send(env,'sendMessage',{chat_id:chat,
     text:'Step 3/3 — Choose the Microsoft '+(current.target_lang==='my'?'Burmese':'English')+' voice.',
     reply_markup:buttons(voices.map((v,i)=>[{text:v.name,callback_data:'pd:voice:e'+i}]))})
   }else{
    const v=await env.MEMORY_DB.prepare(
     'SELECT slot,name FROM vox_saved_voices WHERE chat_id=? ORDER BY slot'
    ).bind(chat).all<{slot:number;name:string}>()
    const rows:Button[][]=[[{text:'New/default voice',callback_data:'pd:voice:v0'}]]
    for(const saved of v.results){
     if(Number.isInteger(saved.slot)&&saved.slot>=1&&saved.slot<=5){
      rows.push([{text:'Saved '+saved.slot+' • '+saved.name.slice(0,35),
       callback_data:'pd:voice:v'+saved.slot}])
     }
    }
    await send(env,'sendMessage',{chat_id:chat,
     text:'Step 3/3 — Choose a VoxCPM2 voice. Your saved voices from /voxvoices are available here.',
     reply_markup:buttons(rows)})
   }
   return
  }
  if(action==='voice'&&current.stage==='voice'&&/^[ev][0-9]$/.test(value)){
   let voice='',slot=0,label=''
   if(current.engine==='edge'&&value.startsWith('e')){
    const index=Number(value[1]);const entry=(edgeVoices[current.target_lang]||[])[index]
    if(!entry)throw Error('Invalid voice choice')
    voice=entry.code;label=entry.name
   }else if(current.engine==='vox'&&value.startsWith('v')){
    slot=Number(value[1])
    if(slot>5)throw Error('Invalid voice slot')
    if(slot){
     const found=await env.MEMORY_DB.prepare(
      'SELECT name FROM vox_saved_voices WHERE chat_id=? AND slot=?'
     ).bind(chat,slot).all<{name:string}>()
     if(!found.results[0])throw Error('That saved voice slot is unavailable')
     label='Saved voice '+slot+' • '+found.results[0].name
    }else label='New/default VoxCPM2 voice'
    voice='Narrator'
   }else throw Error('Voice engine does not match')
   await env.MEMORY_DB.prepare(
    "UPDATE pyvt_dub_selections SET voice=?,voice_slot=?,stage='ready',updated_at=unixepoch() "+
    "WHERE chat_id=? AND stage='voice'"
   ).bind(voice,slot,chat).run()
   const src=current.source_lang==='my'?'Burmese':'English'
   const trg=current.target_lang==='my'?'Burmese':'English'
   await send(env,'sendMessage',{chat_id:chat,text:
    '✅ Selection saved!\n'+src+' → '+trg+
    '\nEngine: '+(current.engine==='edge'?'Microsoft Edge TTS':'VoxCPM2')+
    '\nVoice: '+label+
    '\n\nSend a video up to 20 MB to use these settings, or reply to one with /dub.'+
    '\nVideo processing is still in compatibility testing, so no Kaggle GPU run will start until it is enabled.'+
    '\nSend /dub to change the language or voice.'})
   return
  }
  await send(env,'sendMessage',{chat_id:chat,
   text:'This selection is outdated. Send /dub to choose language, engine and voice again.'})
 }catch(e){
  console.error('pyVideoTrans menu failed',e instanceof Error?e.name:'unknown')
  if(chat)await send(env,'sendMessage',{chat_id:chat,
   text:'Unable to save that dubbing choice. Send /dub to restart the menu.'}).catch(()=>undefined)
 }finally{
  await send(env,'answerCallbackQuery',{callback_query_id:cb.id}).catch(()=>undefined)
 }
}