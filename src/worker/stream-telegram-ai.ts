import {freeLlmRequest,type FreeLlmEnv} from './free-llm'
import {countAi} from './usage-receipts'
/** Live Telegram answer updates over FreeLLM OpenAI-compatible streaming SSE. Never exposes model tokens or secrets. */
type Msg={role:'system'|'user'|'assistant';content:string}
type AiEnv=FreeLlmEnv&{TELEGRAM_BOT_TOKEN:string;MEMORY_DB:import('./usage-receipts').UsageDb;AI: {run:(model:string,params:Record<string,unknown>)=>Promise<unknown>}}
type Out={ok?:boolean;result?:{message_id?:number};description?:string}
async function tgCall(env:AiEnv,method:string,payload:Record<string,unknown>):Promise<Out>{
 const response=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/'+method,{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),
  signal:AbortSignal.timeout(15000)
 })
 if(!response.ok)throw Error('Telegram request '+response.status)
 return await response.json() as Out
}
export async function streamAIToTelegram(env:AiEnv,chatId:string,replyMessage:number,messages:Msg[],modelId:string):Promise<string>{
 // Count FreeLLM text completions separately from Workers AI Neuron usage.
 await countAi(env.MEMORY_DB,chatId)
 const opening=await tgCall(env,'sendMessage',{chat_id:chatId,text:'🤖 Thinking…',reply_parameters:{message_id:replyMessage}})
 const msgId=opening.result?.message_id
 if(!opening.ok||!msgId)throw Error('Telegram could not start streaming reply')
 let full='',buf='',lastSent='',lastEdit=Date.now(),sawDone=false
 const edit=async(force=false)=>{
  if(!full||full===lastSent||(!force&&Date.now()-lastEdit<950))return
  let text=full.slice(0,3850)+(force?'':' ▌')
  try{
   const resp=await tgCall(env,'editMessageText',{chat_id:chatId,message_id:msgId,text})
   if(resp.ok){lastSent=full;lastEdit=Date.now()}
  }catch{/* Telegram may reject rapid edits; continue reading model output. */}
 }
 const payload={messages,max_tokens:1000,temperature:0.4,stream:true}
 const model=modelId
 try{
  const response=await freeLlmRequest(env,messages,{...payload,model})
  if(!response.body)throw Error('FreeLLM did not return a response stream')
  const reader=response.body.getReader(), decoder=new TextDecoder()
  for(;;){
   const {done,value}=await reader.read()
   if(done)break
   buf+=decoder.decode(value,{stream:true}).replace(/\r/g,'')
   let sep=-1
   while((sep=buf.indexOf('\n\n'))!==-1){
    const part=buf.slice(0,sep);buf=buf.slice(sep+2)
    for(const line of part.split('\n')){
     if(!line.startsWith('data:'))continue
     const data=line.slice(5).trim()
     if(data==='[DONE]'){sawDone=true;break}
     try{
      const parsed=JSON.parse(data) as {response?:string;error?:string}
      const chunk=typeof parsed.response==='string'?parsed.response:
       typeof (parsed as {choices?:{delta?:{content?:string}}[]}).choices?.[0]?.delta?.content==='string'?
       (parsed as {choices:{delta:{content:string}}[]}).choices[0].delta.content:''
      if(chunk){
       // Workers AI emits response chunks, not HTTP token echoes.
       full+=chunk
      }
     }catch{/* Ignore non-JSON heartbeat events */}
    }
   }
   await edit()
   if(full.length>3900){await reader.cancel().catch(()=>{});break}
  }
  full=(full.trim()||'I did not receive a complete answer from FreeLLM.')
  full=full.slice(0,3800)
  await edit(true)
  if(!sawDone&&full.startsWith('I did not receive'))console.error('FreeLLM returned no text chunks')
  return full.slice(0,3850)
 }catch(error){
  const name=error instanceof Error?error.name:'unknown'
  console.error('FreeLLM streaming failed:',name)
  full=(full.trim()||'The AI service could not complete this answer. Please retry.')+' \n\n⚠️ Stream ended unexpectedly.'
  await edit(true)
  return full.slice(0,3850)
 }
}
