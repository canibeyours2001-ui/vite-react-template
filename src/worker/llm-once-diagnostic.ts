/** One-time operational self-check after the FreeLLM binding repair.
 * Stores only a response category in D1. The API credential and model
 * output are NEVER retained.
 */
import {freeLlmRequest,type FreeLlmEnv} from './free-llm'
type DB={prepare(sql:string):{bind(...v:(string|number)[]):{
 run():Promise<{meta:{changes:number}}>
}}}
type Env=FreeLlmEnv&{MEMORY_DB:DB}
export async function runFreeLlmRecoveryCheck(env:Env):Promise<void>{
 await env.MEMORY_DB.prepare('CREATE TABLE IF NOT EXISTS studio_llm_diagnostics ('+
  'name TEXT PRIMARY KEY,status TEXT NOT NULL,detail TEXT NOT NULL DEFAULT "",'+
  'checked_at INTEGER NOT NULL DEFAULT (unixepoch()))').bind().run()
 const tag='freellm-binding-2026-11-03'
 const claim=await env.MEMORY_DB.prepare(
  "INSERT OR IGNORE INTO studio_llm_diagnostics(name,status) VALUES(?,'checking')"
 ).bind(tag).run()
 if(claim.meta.changes!==1)return
 let status='failed',detail='unknown'
 try{
  const result=await freeLlmRequest(env,[{role:'user',content:'Return exactly OK.'}],
   {model:'auto',max_tokens:12,stream:false,temperature:0})
  const body=await result.json() as {choices?:Array<{message?:{content?:string}}>}
  if(body.choices?.[0]?.message?.content?.trim()){
   status='ok';detail='Non-stream chat completion returned usable content'
  }else detail='Response lacked a completion message'
 }catch(e){
  const name=e instanceof Error?e.name:'UnknownError'
  const message=e instanceof Error?e.message:'unknown failure'
  // No URLs, API keys, message content, headers, or request body in diagnostics.
  const code=message.match(/HTTP \d{3}/)?.[0]||''
  detail=code||name
  console.error('FreeLLM recovery probe:',detail)
 }
 await env.MEMORY_DB.prepare(
  'UPDATE studio_llm_diagnostics SET status=?,detail=?,checked_at=unixepoch() WHERE name=?'
 ).bind(status,detail,tag).run()
}
