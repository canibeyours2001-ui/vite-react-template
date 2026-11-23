import assert from 'node:assert/strict';
import { qwenImageCommand, pollQwenImage21, normalizePrompt } from '../src/worker/qwen-image21-kaggle.ts';

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
async function main() {
  assert.equal(normalizePrompt('A {argument name="nationality" default="Japanese"} girl with {argument name="hair style" default="long black hair"}'), 'A Japanese girl with long black hair');
  const {env,calls}=envFor();
  const sent=[];
  const send=async t => {sent.push(t);};
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
  console.log('PASS: disabled gate, enabled D1 queue, prompt template expansion, size parsing, status/help and validation');
}
await main();
