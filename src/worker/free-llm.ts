/** OpenAI-compatible FreeLLM relay for all text-only tasks.
 * Never use Workers AI for chat, planning, intent classification or rewriting.
 * Server execution must remain implemented by explicitly allowlisted code paths.
 */
export type TextMessage={role:'system'|'user'|'assistant';content:string}
export type FreeLlmEnv={FREE_LLM_API_KEY?:string;FREE_LLM_BASE_URL?:string}
function endpoint(env:FreeLlmEnv):string{
 if(!env.FREE_LLM_API_KEY)throw new Error('FreeLLM API key is not configured')
 const base=env.FREE_LLM_BASE_URL||''
 const u=new URL(base)
 if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)
  throw new Error('Invalid FreeLLM base URL')
 const path=u.pathname.replace(/\/+$/,'')
 if(!['/v1',''].includes(path))throw new Error('FreeLLM base URL must be a /v1 endpoint')
 return u.origin+path+'/chat/completions'
}
export async function freeLlmRequest(env:FreeLlmEnv,messages:TextMessage[],opts?:{max_tokens?:number;temperature?:number;stream?:boolean;model?:string}):Promise<Response>{
 const resp=await fetch(endpoint(env),{
  method:'POST',
  headers:{'authorization':'Bearer '+env.FREE_LLM_API_KEY,'content-type':'application/json','accept':opts?.stream?'text/event-stream':'application/json'},
  body:JSON.stringify({model:opts?.model||'auto',messages,max_tokens:opts?.max_tokens||650,temperature:opts?.temperature??0.35,stream:opts?.stream||false}),
  signal:AbortSignal.timeout(opts?.stream?100000:45000)
 })
 if(!resp.ok){console.error('FreeLLM HTTP',resp.status);throw new Error('FreeLLM request failed (HTTP '+resp.status+')')}
 return resp
}
export async function completeFreeLlm(env:FreeLlmEnv,messages:TextMessage[],opts?:{max_tokens?:number;temperature?:number;model?:string}):Promise<string>{
 const response=await freeLlmRequest(env,messages,{...opts,stream:false})
 const data=await response.json() as {choices?:Array<{message?:{content?:string}}>}
 const result=data.choices?.[0]?.message?.content?.trim()
 if(!result)throw new Error('FreeLLM returned empty text')
 return result
}
