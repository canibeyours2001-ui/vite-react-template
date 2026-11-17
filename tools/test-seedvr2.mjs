import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';

const raw=fs.readFileSync(new URL('../src/worker/seedvr2-kaggle.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(raw,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const mod={exports:{}};
vm.runInNewContext(compiled,{module:mod,exports:mod.exports,fetch:()=>{throw Error('Network forbidden in unit test')},Response,URL,AbortSignal,crypto:globalThis.crypto,console,Date,Math,JSON,TextEncoder,Uint8Array,ArrayBuffer,FormData,Blob});
const {vsrCommand,vsrSignedFile,pollSeedVsr}=mod.exports;
let calls=[];
const DB={
 prepare(query){
   calls.push(query);
   return {bind(...values){return {
     async run(){return {meta:{changes:1}}},
     async all(){return {results:query.startsWith('SELECT enabled')?[{enabled:0}]:[]}}
   }}}
 }
};
const env={MEMORY_DB:DB,TELEGRAM_BOT_TOKEN:'local-unit-test',TELEGRAM_WEBHOOK_SECRET:'test-only',KAGGLE_API_TOKEN:'fake'};
const output=[];
const send=async s=>output.push(s);
assert.equal(await vsrCommand(env,{message_id:1},'123','/vsr_help',send),true);
assert.match(output.pop(),/10 seconds/);
assert.equal(await vsrCommand(env,{message_id:2},'123','/vsr 1080',send),true);
assert.match(output.pop(),/Reply to an MP4/);
assert.equal(await vsrCommand(env,{message_id:3,video:{file_id:'fake',file_size:50000}},'123','/vsr 1080',send),true);
assert.match(output.pop(),/disabled until/);
assert.equal(calls.some(q=>q.startsWith('INSERT OR IGNORE INTO seedvr2_jobs')),false,'no GPU queue when disabled');
const invalid = await vsrSignedFile(env,new Request('https://example.com/telegram/webhook?vsrfile=1&expire=1&sig=bad'));
assert.equal(invalid.status,404);
await pollSeedVsr(env);
assert.equal(calls.some(q=>q.includes("SET status='submitting'")),false);
assert.ok(raw.includes('kernelType:\'script\''),'Kaggle script mode present');
assert.ok(raw.includes("isPrivate:true"),'private kernel');
const match=raw.match(/const KERNEL_SCRIPT = ("(?:[^"\\]|\\.)*");/);
assert.ok(match,'Embedded Python should be a JSON string');
const py=JSON.parse(match[1]);
const url='https://vite-react-template.canibeyours2001.workers.dev/telegram/webhook?vsrfile=1&expire=9999999999&sig='+'a'.repeat(64);
const task=JSON.stringify({url,resolution:1080});
const rendered=py.replace('__TASK_JSON__',task.replace(/\\/g,'\\\\').replace(/'/g,"\\'"));
assert.ok(rendered.includes('"resolution":1080'));
assert.ok(!rendered.includes('__TASK_JSON__'));
const check=spawnSync('python3',['-c','import sys,ast;ast.parse(sys.stdin.read()); print("python-ok")'],{input:rendered,encoding:'utf8'});
assert.equal(check.status,0,check.stderr);
console.log('PASS /vsr help, disabled gating, signed URL rejection, disabled poll, private Kaggle configuration, Python syntax');