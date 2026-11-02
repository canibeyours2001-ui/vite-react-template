/** Cloudflare Workers AI model selection for the existing Telegram bot.
 * The model choice is saved per private chat, never in query strings or source credentials.
 */
export type D1 = {prepare:(sql:string)=>{bind:(...args:(number|string)[])=>{run:()=>Promise<unknown>,all:<T>()=>Promise<{results:T[]}>}}}
export type AiChoiceEnv={MEMORY_DB:D1;TELEGRAM_BOT_TOKEN:string}
export const AI_MODELS=[
 {name:'Llama 3.3 70B · quality',id:'@cf/meta/llama-3.3-70b-instruct-fp8-fast'},
 {name:'Llama 3.1 8B · quick',id:'@cf/meta/llama-3.1-8b-instruct-fp8'},
 {name:'GPT-OSS 20B · reasoning',id:'@cf/openai/gpt-oss-20b'}
] as const
const DEFAULT_MODEL=AI_MODELS[0].id
export async function initModels(db:D1){
 await db.prepare('CREATE TABLE IF NOT EXISTS studio_ai_models (chat_id TEXT PRIMARY KEY, model_id TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))').bind().run()
}
export async function getAiModel(env:AiChoiceEnv,chat:string){
 await initModels(env.MEMORY_DB)
 const rows=await env.MEMORY_DB.prepare('SELECT model_id FROM studio_ai_models WHERE chat_id=?').bind(chat).all<{model_id:string}>()
 const value=rows.results[0]?.model_id
 return AI_MODELS.find(m=>m.id===value)?.id||DEFAULT_MODEL
}
async function send(env:AiChoiceEnv,chat:string,method:string,data:Record<string,unknown>){ void chat;
 const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/'+method,{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(10000)
 })
 if(!r.ok)throw Error('Telegram menu failed '+r.status)
 const out=await r.json() as {ok?:boolean}
 if(!out.ok)throw Error('Telegram rejected AI model menu')
}
export async function handleAiModelCommand(env:AiChoiceEnv,chat:string){
 const current=await getAiModel(env,chat)
 await send(env,chat,'sendMessage',{
  chat_id:chat,text:'🤖 Choose your AI chat model.\\n\\nCurrent: '+(AI_MODELS.find(m=>m.id===current)?.name||'Default')+
    '\\n\\nYour selection is saved. All normal messages and /ask use your chosen model. Model usage may incur Cloudflare AI charges.',
  reply_markup:{inline_keyboard:AI_MODELS.map((m,i)=>[{text:(m.id===current?'✅ ':'')+m.name,callback_data:'am:'+i}])}
 })
}
export async function handleAiModelCallback(env:AiChoiceEnv,chat:string,cb:{id:string;data?:string}){
 const index=Number((cb.data||'').slice(3))
 if(!Number.isInteger(index)||!AI_MODELS[index])return
 await initModels(env.MEMORY_DB)
 const model=AI_MODELS[index]
 await env.MEMORY_DB.prepare('INSERT INTO studio_ai_models(chat_id,model_id) VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET model_id=excluded.model_id,updated_at=unixepoch()').bind(chat,model.id).run()
 await send(env,chat,'answerCallbackQuery',{callback_query_id:cb.id,text:'Selected '+model.name})
 await send(env,chat,'sendMessage',{chat_id:chat,text:'✅ AI model: '+model.name+'\\nSend a normal message or /ask YOUR QUESTION to start streaming.'})
}
