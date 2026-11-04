const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict'),path=require('path');
const code=fs.readFileSync(path.resolve(__dirname,'../deploy/hf2-gpuquota-wan-production-overlay.js'),'utf8');
vm.runInThisContext(code+'\nObject.assign(globalThis,{hfWanSelectSeconds,hfWanQueue,hfWanSubmit,hfWanIntercept,hfWanVideoUrl});');
const estimates=[[10,300,10],[10,270,10],[10,260,8],[10,230,7],[10,220,7],[10,210,6],[10,150,5],[10,149,0],[6,270,6],[5,300,5],[8,150,5]];
for (const [input,quota,expected] of estimates)assert.equal(hfWanSelectSeconds(input,quota),expected,JSON.stringify({input,quota}));
let quota=300, sent=[], rows=[], gradioBodies=[], activeVideo=null, inserted=0;
const db={prepare:q=>({bind:(...a)=>({
 run:async()=>{
  if(q.startsWith('INSERT OR IGNORE')){if(rows.find(x=>x.message_id===a[2]))return {meta:{changes:0}};rows.push({id:a[0],chat_id:a[1],message_id:a[2],video_id:a[3],photo_id:a[4],duration_s:a[5],stage:'queued',created_at:Math.floor(Date.now()/1000)});inserted++;return {meta:{changes:1}}}
  if(q.includes("SET duration_s=")){activeVideo.duration_s=a[0];return {meta:{changes:1}}}
  if(q.includes("stage='preparing'")){activeVideo.stage='preparing';return {meta:{changes:1}}}
  if(q.includes("stage='running'")){activeVideo.stage='running';return {meta:{changes:1}}}
  return {meta:{changes:1}};
 },all:async()=>({results:[]})
 }),run:async()=>({meta:{changes:1}}),all:async()=>({results:[]})})};
global.fetch=async (url,opt={})=>{
 url=String(url);
 if(url.endsWith('/api/spaces/zero-gpu/quota'))return Response.json({base:300,current:quota,resetsAt:'2026-11-05T00:00:00Z'});
 if(url.includes('/sendMessage')){sent.push(JSON.parse(opt.body).text);return Response.json({ok:true})}
 if(url.includes('/getFile?file_id=')){const id=new URL(url).searchParams.get('file_id');return Response.json({ok:true,result:{file_path:id==='video'?'videos/input.mp4':'photos/ref.jpg',file_size:1024}})}
 if(url.includes('/file/bot'))return new Response(new Uint8Array(2048),{status:200,headers:{'content-type':url.includes('photos/')?'image/jpeg':'video/mp4'}})
 if(url.endsWith('/gradio_api/upload'))return Response.json(['/tmp/gradio/file'+(sent.length?sent.length:0)]);
 if(url.endsWith('/gradio_api/call/animate_scene')){gradioBodies.push(JSON.parse(opt.body));return Response.json({event_id:'12345678'})}
 throw Error('Unexpected mock request '+url);
};
const env={MEMORY_DB:db,TELEGRAM_BOT_TOKEN:'dummy',HUGGINGFACE2_API_TOKEN:'hf_dummy',TELEGRAM_WEBHOOK_SECRET:'secret'};
(async()=>{
 const msg={message_id:7,video:{file_id:'video',file_size:800,duration:10},reply_to_message:{photo:[{file_id:'photo',file_size:900}]}};
 await hfWanQueue(env,msg,'44');await hfWanQueue(env,msg,'44');
 assert.equal(rows.length,1);assert.equal(rows[0].duration_s,10);assert.match(sent[0],/10 seconds/);
 quota=230;activeVideo=rows[0];await hfWanSubmit(env,activeVideo);
 assert.equal(activeVideo.duration_s,7);assert.equal(gradioBodies.length,1);assert.equal(gradioBodies[0].data[1],7);
 assert.match(sent.at(-1),/7 seconds/);
 quota=149;const n=rows.length;await hfWanQueue(env,{...msg,message_id:8},'44');assert.equal(rows.length,n);assert.match(sent.at(-1),/blocked/);
 quota=300;await hfWanQueue(env,{...msg,message_id:9,video:{...msg.video,duration:4}},'44');assert.equal(rows.length,n);assert.match(sent.at(-1),/at least 5 seconds/);
 await hfWanQueue(env,{...msg,message_id:10,video:{...msg.video,duration:6}},'44');assert.equal(rows.at(-1).duration_s,6);
 await hfWanQueue(env,{...msg,message_id:11,video:{...msg.video,duration:5}},'44');assert.equal(rows.at(-1).duration_s,5);
 await hfWanQueue(env,{...msg,message_id:12,video:{...msg.video,duration:undefined}},'44');assert.equal(rows.at(-1).duration_s,5);
 console.log('PASS: 11 duration/quota cases, dedup, queue, downstream Gradio duration, quota downgrade, input validation; queued='+inserted+' generated='+gradioBodies.length);
})().catch(e=>{console.error(e.stack);process.exit(1)});
