import assert from 'node:assert/strict';
import { qwenImageCommand, qwenBatchCommand, pollQwenImage21, normalizePrompt } from '../src/worker/qwen-image21-kaggle.ts';

function envFor(flag='0', token=undefined) {
  const calls=[];
  const bindings=[];
  const db={
    prepare(sql) {
      calls.push(sql);
      return {
        bind(...args) {
          bindings.push({sql,args});
          return {
            async run() { return {meta:{changes:1}}; },
            async all() { return {results:[]}; }
          };
        }
      };
    }
  };
  return { env:{MEMORY_DB:db,TELEGRAM_BOT_TOKEN:'unused-test-bot-token',
                 QWEN_KAGGLE_ENABLED:flag,KAGGLE_API_TOKEN:token}, calls, bindings };
}

function schedulerEnv(activeJob=null, queuedJob=null) {
  const statements=[];
  const job=queuedJob||activeJob||{
    id:1,chat_id:'5293769874',message_id:1352,
    prompt:'A cinematic red fox in a snowy pine forest',
    width:1024,height:1024,seed:12345,status:'submitting',
    version_number:null,created_at:1795409882,error_message:null
  };
  const db={
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              statements.push({sql,args});
              return {meta:{changes:1}};
            },
            async all() {
              statements.push({sql,args});
              if(sql.includes('FROM qwen_image21_jobs WHERE status IN')) {
                return {results:activeJob?[activeJob]:[]};
              }
              if(sql.includes("FROM qwen_image21_jobs WHERE status='submitting'")) {
                return {results:[job]};
              }
              return {results:[]};
            }
          };
        }
      };
    }
  };
  return {
    env:{MEMORY_DB:db,TELEGRAM_BOT_TOKEN:'unused-test-bot-token',
      QWEN_KAGGLE_ENABLED:'1',KAGGLE_API_TOKEN:'test-kaggle-token'},
    statements
  };
}

async function main() {
  assert.equal(normalizePrompt('A {argument name="nationality" default="Japanese"} girl with {argument name="hair style" default="long black hair"}'),
    'A Japanese girl with long black hair');

  const {env,calls}=envFor();
  const sent=[];
  const send=async t=>{sent.push(t);};
  assert.equal(await qwenImageCommand(env,'user',1,'/qwenimage_help',send),true);
  assert.match(sent.pop(),/prohibits commercial use/i);
  assert.equal(await qwenImageCommand(env,'user',2,'/qwenimage_status',send),true);
  assert.match(sent.pop(),/No Qwen research jobs yet/);
  assert.equal(await qwenImageCommand(env,'user',3,'/qwenimage a photorealistic capybara',send),true);
  assert.match(sent.pop(),/submissions are locked/i);
  assert.equal(await qwenImageCommand(env,'user',4,'/qwenimage',send),true);
  assert.match(sent.pop(),/Provide an image prompt/i);
  assert.equal(await qwenImageCommand(env,'user',5,'/vsr 720',send),false);
  assert.equal(await qwenImageCommand(env,'user',6,'/qwenimage --size=768 cinematic landscape',send),true);
  assert.match(sent.pop(),/locked/i);
  assert.equal(await qwenImageCommand(env,'user',7,'/qwenimage a'.repeat(1600),send),true);
  assert.match(sent.pop(),/between 3 and 1400/i);
  await pollQwenImage21(env);
  assert.equal(calls.filter(s=>s.includes('INSERT INTO')).length,0);

  const enabled=envFor('1','test-kaggle-token');
  const enabledSent=[];
  assert.equal(await qwenImageCommand(enabled.env,'user',8,
    '/qwenimage --size=768 A {argument name="nationality" default="Japanese"} adult portrait',
    async t=>enabledSent.push(t)),true);
  assert.match(enabledSent[0],/queued on Kaggle/);
  const insert=enabled.bindings.find(x=>x.sql.includes('INSERT OR IGNORE INTO qwen_image21_jobs'));
  assert.ok(insert);
  assert.equal(insert.args[2],'A Japanese adult portrait');
  assert.equal(insert.args[3],768);
  assert.equal(insert.args[4],768);


  const batchEnabled=envFor('1','test-kaggle-token');
  const batchSent=[];
  assert.equal(await qwenBatchCommand(batchEnabled.env,'user',9,
    '/qwenbatch --size=768\n1. A cinematic adult portrait in warm sunlight\n2. A photorealistic red sports car in the rain',
    async t=>batchSent.push(t)),true);
  assert.match(batchSent[0],/queued: 2 images at 768×768/);
  const batchInsert=batchEnabled.bindings.find(x=>x.sql.includes('INSERT OR IGNORE INTO qwen_image21_jobs'));
  assert.ok(batchInsert);
  assert.match(batchInsert.args[2],/^__QWEN_IMAGE21_BATCH_V1__:/);
  assert.deepEqual(JSON.parse(batchInsert.args[2].slice('__QWEN_IMAGE21_BATCH_V1__:'.length)),[
    'A cinematic adult portrait in warm sunlight','A photorealistic red sports car in the rain']);
  assert.equal(batchInsert.args[3],768);
  assert.equal(batchInsert.args[4],768);

  const batchHelp=[];
  assert.equal(await qwenBatchCommand(env,'user',10,'/qwenbatch_help',async t=>batchHelp.push(t)),true);
  assert.match(batchHelp[0],/2–4 prompts/);
  const batchBad=[];
  assert.equal(await qwenBatchCommand(batchEnabled.env,'user',11,
    '/qwenbatch only one prompt',async t=>batchBad.push(t)),true);
  assert.match(batchBad[0],/Provide 2–4 prompts/);

  // Regression test: a D1-local queued job must be submitted, not mistaken
  // for a Kaggle job that already has a version number.
  const queued=schedulerEnv();
  const originalFetch=globalThis.fetch;
  let pushes=0;
  try {
    globalThis.fetch=async (input,init={})=>{
      const url=String(input);
      assert.match(url,/api\.kaggle\.com\/v1\/kernels\/push$/);
      pushes++;
      assert.equal(init.method,'POST');
      const payload=JSON.parse(init.body);
      assert.equal(payload.machineShape,'NvidiaTeslaT4');
      assert.equal(payload.enableGpu,true);
      assert.equal(payload.isPrivate,true);
      assert.match(payload.text,/A cinematic red fox in a snowy pine forest/);
      return new Response(JSON.stringify({versionNumber:42}),{status:200,
        headers:{'content-type':'application/json'}});
    };
    await pollQwenImage21(queued.env);
  } finally {
    globalThis.fetch=originalFetch;
  }
  assert.equal(pushes,1,'queued D1 job should be pushed to Kaggle exactly once');
  assert.ok(queued.statements.some(x=>
    x.sql.includes("SET status='submitted',version_number=?")&&
    x.args[0]===42&&x.args[1]===1));
  const activeQuery=queued.statements.find(x=>
    x.sql.includes('FROM qwen_image21_jobs WHERE status IN'));
  assert.ok(activeQuery);
  assert.doesNotMatch(activeQuery.sql,/'queued'/,
    'local queued jobs must not be selected as already-submitted jobs');

  // Kaggle's own queue is a distinct state and remains GPU-occupying.
  const remoteQueued=schedulerEnv({
    id:1,chat_id:'5293769874',message_id:1352,
    prompt:'A cinematic red fox in a snowy pine forest',
    width:1024,height:1024,seed:12345,status:'submitted',
    version_number:42,created_at:1795409882,error_message:null
  });
  try {
    globalThis.fetch=async input=>{
      assert.match(String(input),/kernels\/status/);
      return new Response(JSON.stringify({status:'QUEUED'}),{status:200,
        headers:{'content-type':'application/json'}});
    };
    await pollQwenImage21(remoteQueued.env);
  } finally {
    globalThis.fetch=originalFetch;
  }
  assert.ok(remoteQueued.statements.some(x=>
    x.sql.includes("SET status='kaggle-queued'")),
    'Kaggle queue state must not be confused with the local D1 queue');


  // A batch uses the same D1 queue row, but submits a list of task payloads
  // so one Kaggle session can keep ComfyUI and model weights loaded.
  const batchPrompts=[
    'A cinematic adult portrait in warm sunlight',
    'A photorealistic red sports car in the rain'
  ];
  const batchQueued=schedulerEnv(null,{
    id:2,chat_id:'5293769874',message_id:1353,
    prompt:'__QWEN_IMAGE21_BATCH_V1__:'+JSON.stringify(batchPrompts),
    width:768,height:768,seed:12345,status:'submitting',
    version_number:null,created_at:1795409882,error_message:null
  });
  try {
    globalThis.fetch=async (input,init={})=>{
      const url=String(input);
      assert.match(url,/api\.kaggle\.com\/v1\/kernels\/push$/);
      const payload=JSON.parse(init.body);
      assert.match(payload.text,/QWEN_TASKS_JSON/);
      assert.match(payload.text,/A cinematic adult portrait in warm sunlight/);
      assert.match(payload.text,/A photorealistic red sports car in the rain/);
      assert.doesNotMatch(payload.text,/QWEN_TASK_JSON/);
      return new Response(JSON.stringify({versionNumber:43}),{status:200,
        headers:{'content-type':'application/json'}});
    };
    await pollQwenImage21(batchQueued.env);
  } finally {
    globalThis.fetch=originalFetch;
  }
  assert.ok(batchQueued.statements.some(x=>
    x.sql.includes("SET status='submitted',version_number=?")&&
    x.args[0]===43&&x.args[1]===2));

  // Completed batches download and validate each PNG, then deliver one Telegram album.
  const batchActive=schedulerEnv({
    id:3,chat_id:'5293769874',message_id:1354,
    prompt:'__QWEN_IMAGE21_BATCH_V1__:'+JSON.stringify(batchPrompts),
    width:768,height:768,seed:12345,status:'submitted',
    version_number:44,created_at:1795409882,error_message:null
  });
  const png=new Uint8Array(4096);
  png.set([137,80,78,71,13,10,26,10]);
  const view=new DataView(png.buffer);
  view.setUint32(16,768);
  view.setUint32(20,768);
  let albumCount=0;
  try {
    globalThis.fetch=async (input,init={})=>{
      const url=String(input);
      if(url.includes('/kernels/status')){
        return new Response(JSON.stringify({status:'COMPLETE'}),{status:200,
          headers:{'content-type':'application/json'}});
      }
      if(url.includes('/kernels/output')){
        return new Response(JSON.stringify({files:[
          {fileName:'qwen_image21_01.png',url:'https://storage.googleapis.com/qwen-test/one.png'},
          {fileName:'qwen_image21_02.png',url:'https://storage.googleapis.com/qwen-test/two.png'}
        ]}),{status:200,headers:{'content-type':'application/json'}});
      }
      if(url.startsWith('https://storage.googleapis.com/')){
        return new Response(png,{status:200,headers:{'content-length':'4096','content-type':'image/png'}});
      }
      if(url.includes('/sendMediaGroup')){
        albumCount++;
        const form=init.body;
        const media=JSON.parse(form.get('media'));
        assert.equal(media.length,2);
        assert.equal(form.get('image1').size,4096);
        assert.equal(form.get('image2').size,4096);
        return new Response(JSON.stringify({ok:true,result:[{},{}]}),{status:200,
          headers:{'content-type':'application/json'}});
      }
      throw new Error('Unexpected fetch in batch delivery test: '+url);
    };
    await pollQwenImage21(batchActive.env);
  } finally {
    globalThis.fetch=originalFetch;
  }
  assert.equal(albumCount,1);
  assert.ok(batchActive.statements.some(x=>
    x.sql.includes("SET status='done'")&&x.args[0]===3));

  console.log('PASS: command validation, D1 enqueue, prompt normalization, Kaggle submission, GPU queue state batch submission, Telegram album delivery and deadlock regression');
}
await main();
