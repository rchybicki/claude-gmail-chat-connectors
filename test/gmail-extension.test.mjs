import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
const source=readFileSync(new URL('../gmail/extension/background.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const account='jan.kowalski@randstad.com',token=randomBytes(32).toString('hex'),port=3456;
const sign=text=>createHmac('sha256',Buffer.from(token,'hex')).update(text).digest('hex');
// Runs the extension against a server that answers the first poll with `answer(nonce)`.
async function bridge(answer) {
  const sent=[],pageCalls=[];let polls=0,done;
  const finished=new Promise(r=>done=r);
  const fetch=async(url,options={})=>{
    if(url==='fixture-config')return {json:async()=>({account,token,port})};
    sent.push({url,headers:options.headers,body:options.body});
    if(url.endsWith('/poll')){
      if(++polls>1){setTimeout(done,10);throw new Error('stop');}
      setTimeout(done,1000); // A refused request ends the loop without another poll.
      return {ok:true,json:async()=>answer(options.headers['X-Nonce'])};
    }
    return {ok:true,json:async()=>({ok:true})};
  };
  const chrome={runtime:{getURL:()=>'fixture-config',getManifest:()=>({version:'1.0.0'}),onStartup:{addListener(){}},onInstalled:{addListener(){}}},
    alarms:{create(){},onAlarm:{addListener(){}}},
    tabs:{query:async()=>[{id:1}]},
    scripting:{executeScript:async({args:[args]})=>{pageCalls.push(args.action);return [{result:{account,baseUrl:'https://mail.google.com/mail/u/0/'}}];}}};
  const context={fetch,chrome,crypto:globalThis.crypto,TextEncoder,AbortSignal,URL,setTimeout,gmailPageOperation(){},extractReadThread(){},prepareDraft(){}};
  vm.createContext(context);vm.runInContext(source,context);
  await finished;
  return {sent,pageCalls};
}
const request={id:'r1',action:'identity'};
test('a server without the key gets no key and cannot run mailbox actions',async()=>{
  for(const signature of [undefined,'0'.repeat(64),sign('request\nother-nonce\n'+JSON.stringify(request))]) {
    const {sent,pageCalls}=await bridge(()=>({payload:JSON.stringify(request),signature}));
    assert.deepEqual(pageCalls,[]);
    assert.ok(sent.every(s=>!s.url.endsWith('/response')));
    assert.ok(!JSON.stringify(sent).includes(token),'the key itself is never sent');
  }
});
test('a correctly signed request runs and its response is signed',async()=>{
  const {sent,pageCalls}=await bridge(nonce=>{const payload=JSON.stringify(request);return {payload,signature:sign('request\n'+nonce+'\n'+payload)};});
  assert.deepEqual(pageCalls,['identity']);
  const poll=sent.find(s=>s.url.endsWith('/poll'));
  assert.equal(poll.headers['X-Signature'],sign('poll\n'+poll.headers['X-Nonce']));
  const response=sent.find(s=>s.url.endsWith('/response'));
  assert.equal(response.headers['X-Signature'],sign('response\n'+response.body));
  assert.equal(JSON.parse(response.body).data.account,account);
  assert.ok(!JSON.stringify(sent).includes(token));
});
