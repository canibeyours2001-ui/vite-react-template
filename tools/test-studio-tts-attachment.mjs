import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../src/worker/media-studio.ts',import.meta.url),'utf8');
const start=source.indexOf('async function media(');
const end=source.indexOf('async function session(',start);
assert(start>=0&&end>start,'media() source not found');
const getMedia=new Function('safeHost','tg','fetch','File','FormData','Blob','URL','Uint8Array',
  source.slice(start,end)+'\nreturn media;');
const safeHost=(raw,host)=>{const u=new URL(raw);return u.protocol==='https:'&&(u.hostname===host||u.hostname.endsWith('.'+host));};
const wav=new Uint8Array(48);wav.set(Buffer.from('RIFF'),0);wav.set(Buffer.from('WAVE'),8);
const mp3=new Uint8Array(Buffer.concat([Buffer.from('ID3'),Buffer.alloc(50)]));
const cases=[
  {bytes:wav,expectedMethod:'sendDocument',expectedName:'result.wav',expectedType:'audio/wav'},
  {bytes:mp3,expectedMethod:'sendAudio',expectedName:'result.mp3',expectedType:'audio/mpeg'}
];
for(const c of cases){
  let call;
  const fetch=async()=>({ok:true,blob:async()=>new Blob([c.bytes],{type:'application/octet-stream'})});
  const tg=async(_env,method,form)=>{call={method,file:form.get(method==='sendAudio'?'audio':'document')};};
  const media=getMedia(safeHost,tg,fetch,File,FormData,Blob,URL,Uint8Array);
  await media({},'123','https://image-upscaling.net/tts/output','audio',{requireAudio:true});
  assert.equal(call.method,c.expectedMethod);
  assert.equal(call.file.name,c.expectedName);
  assert.equal(call.file.type,c.expectedType);
}
{
  let called=false;
  const fetch=async()=>({ok:true,blob:async()=>new Blob([JSON.stringify({error:'invalid'})],{type:'application/octet-stream'})});
  const tg=async()=>{called=true;};
  const media=getMedia(safeHost,tg,fetch,File,FormData,Blob,URL,Uint8Array);
  await assert.rejects(()=>media({},'123','https://image-upscaling.net/tts/output','audio',{requireAudio:true}),/recognized audio header/);
  assert.equal(called,false,'Unknown binary must not be delivered as audio');
}
console.log('3 TTS attachment regression tests passed');
