import assert from 'node:assert/strict';
import { qwenImageCommand, pollQwenImage21 } from '../src/worker/qwen-image21-kaggle.ts';

function envFor(flag='0', token=undefined) {
  const calls=[];
  const db={
    prepare(sql) {
      calls.push(sql);
      return {
        bind(...args) {
          return {
            async run() { return {meta:{changes:1}}; },
            async all() { return {results:[]}; }
          };
        }
      };
    }
  };
  return { env:{MEMORY_DB:db,TELEGRAM_BOT_TOKEN:'unused-test-bot-token',
                 QWEN_KAGGLE_ENABLED:flag,KAGGLE_API_TOKEN:token}, calls };
}
async function main() {
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
  console.log('PASS: 7 command cases, feature gate prevents insert/submit, idle polling safe');
}
await main();
