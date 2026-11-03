/**
 * Compact provider receipts. No invented cost, GPU runtime or credit counts.
 * Image quota is per provider-reported client. MVSEP premium_minutes are credits.
 * AI call count is informational only. Cloudflare enforces the actual Workers AI quota.
 */
export type UsageDb={prepare(sql:string):{bind(...v:(string|number)[]):{
 run:()=>Promise<unknown>;all:<T>()=>Promise<{results:T[]}>
}}}
export type UsageEnv={MEMORY_DB:UsageDb;MVSEP_API_TOKEN?:string;IMAGE_CLIENT_IDS?:string}
const MV='https://sg.mvsep.com/api'
const UP='https://image-upscaling.net'
export function duration(seconds:number){
 const s=Math.max(0,Math.floor(seconds))
 return s>=3600?Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m':
  s>=60?Math.floor(s/60)+'m '+(s%60)+'s':s+'s'
}
export function meter(used:number,limit:number){
 const share=Math.max(0,Math.min(1,used/limit))
 const width=10,fill=Math.round(share*width)
 return '▰'.repeat(fill)+'▱'.repeat(width-fill)+' '+Math.round(share*100)+'%'
}
async function getJson(url:string,headers?:Record<string,string>){
 const r=await fetch(url,{headers,signal:AbortSignal.timeout(10000)})
 if(!r.ok)throw Error('Provider status unavailable')
 return await r.json() as Record<string,unknown>
}
export async function providerReceipt(env:UsageEnv,provider:'mvsep'|'image'|'modal'|'kaggle',slot?:number){
 if(provider==='modal')return '💳 Modal: final billed cost unavailable from job response; view workspace usage'
 if(provider==='kaggle')return '🖥 Kaggle: GPU/session quota remaining is not exposed by this job API'
 if(provider==='mvsep'){
  if(!env.MVSEP_API_TOKEN)return '💳 MVSEP: account key unavailable'
  try{
   const u=MV+'/app/user?api_token='+encodeURIComponent(env.MVSEP_API_TOKEN)
   const j=await getJson(u)
   const d=j.data as Record<string,unknown>|undefined
   const credits=Number(d?.premium_minutes)
   return Number.isFinite(credits)?'💳 MVSEP: '+credits.toLocaleString('en-US')+' paid credits remaining · free jobs: provider does not report a numeric balance':
    '💳 MVSEP: credits not reported'
  }catch{return '💳 MVSEP: credit balance unavailable'}
 }
 const ids=(env.IMAGE_CLIENT_IDS||'').split(',').map(x=>x.trim()).filter(x=>/^[a-zA-Z0-9]{32}$/.test(x))
 if(!ids.length||slot==null||!ids[slot])return '💳 Image provider: quota unavailable'
 try{
  const j=await getJson(UP+'/get_account_info',{Cookie:'client_id='+ids[slot]})
  const free=Number(j.quota_free),used=Number(j.quota_used),balance=Number(j.balance)
  const valid=Number.isFinite(free)&&Number.isFinite(used)
  return '💳 Image quota: '+(valid?Math.max(0,free-used)+' of '+free+' free requests left':'unknown')+
   (Number.isFinite(balance)?' · balance '+balance:'')
 }catch{return '💳 Image provider: quota unavailable'}
}
export async function initUsage(db:UsageDb){
 await db.prepare("CREATE TABLE IF NOT EXISTS studio_ai_daily (chat_id TEXT NOT NULL,utc_date TEXT NOT NULL,requests INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(chat_id,utc_date))").bind().run()
}
const day=()=>new Date().toISOString().slice(0,10)
export async function aiUsage(db:UsageDb,chat:string){
 await initUsage(db)
 const r=await db.prepare('SELECT requests FROM studio_ai_daily WHERE chat_id=? AND utc_date=?').bind(chat,day()).all<{requests:number}>()
 return r.results[0]?.requests||0
}
export async function countAi(db:UsageDb,chat:string){
 await initUsage(db)
 await db.prepare("INSERT INTO studio_ai_daily(chat_id,utc_date,requests) VALUES(?,?,1) ON CONFLICT(chat_id,utc_date) DO UPDATE SET requests=requests+1")
  .bind(chat,day()).run()
 return aiUsage(db,chat)
}
export async function aiFooter(db:UsageDb,chat:string){
 const used=await aiUsage(db,chat)
 return '🤖 Bot AI calls today: '+used.toLocaleString('en-US')+' (no local daily cap) · Cloudflare Neurons: view Workers AI dashboard; resets at 00:00 UTC'
}
