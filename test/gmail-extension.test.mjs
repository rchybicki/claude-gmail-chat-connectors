import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHmac, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
const source=readFileSync(new URL('../gmail/extension/background.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const account='jan.kowalski@randstad.com',token=randomBytes(32).toString('hex'),port=3456,session='5b0e6f2c-8a1d-4c3e-9f7a-2d4b6c8e0a1f';
const sign=text=>createHmac('sha256',Buffer.from(token,'hex')).update(text).digest('hex');
// The port gets each result sealed with AES-256-GCM (IV, ciphertext, tag); only the key opens it.
const responseKey=Buffer.from(hkdfSync('sha256',Buffer.from(token,'hex'),Buffer.alloc(0),'response',32));
const sealedResponse=async sent=>Buffer.from(await sent.find(s=>s.url.endsWith('/response')).body.arrayBuffer());
const opened=async sent=>{
  const sealed=await sealedResponse(sent),open=createDecipheriv('aes-256-gcm',responseKey,sealed.subarray(0,12),{authTagLength:16});
  open.setAuthTag(sealed.subarray(-16));
  return JSON.parse(Buffer.concat([open.update(sealed.subarray(12,-16)),open.final()]));
};
// Runs the extension against a server that answers the first poll with `answer(nonce)`.
async function bridge(answer,calendarPage,settings={},gmailTabs=[{id:1}]) {
  const sent=[],pageCalls=[],tabs=[];let polls=0,done;
  const finished=new Promise(r=>done=r);
  const fetch=async(url,options={})=>{
    if(url==='fixture-config')return {json:async()=>({account,token,port,...settings})};
    sent.push({url,headers:options.headers,body:options.body});
    if(url.endsWith('/session'))return {ok:true,json:async()=>({session})};
    if(url.endsWith('/poll')){
      if(++polls>1){setTimeout(done,10);throw new Error('stop');}
      setTimeout(done,1000); // A refused request ends the loop without another poll.
      return {ok:true,json:async()=>answer(options.headers['X-Nonce'])};
    }
    return {ok:true,json:async()=>({ok:true})};
  };
  const chrome={runtime:{getURL:()=>'fixture-config',getManifest:()=>({version:'1.0.0'}),onStartup:{addListener(){}},onInstalled:{addListener(){}}},
    alarms:{create(){},onAlarm:{addListener(){}}},
    tabs:{query:async()=>gmailTabs,create:async({url,windowId})=>{tabs.push('open '+url+' in '+windowId);return {id:8};},remove:async id=>{tabs.push('close '+id);}},
    windows:{create:async({url,state,focused})=>{tabs.push('window '+state+' '+focused+' '+url);return {id:9,state,tabs:[{id:7}]};}},
    scripting:{executeScript:async({args:[args]})=>{pageCalls.push(args.action);return [{result:args.action==='identity'?{account,baseUrl:'https://mail.google.com/mail/u/0/'}:calendarPage(args,pageCalls.length)}];}}};
  const context={fetch,chrome,crypto:globalThis.crypto,TextEncoder,AbortSignal,URL,Blob,setTimeout,gmailPageOperation(){},extractReadThread(){},prepareDraft(){},calendarPageOperation(){}};
  vm.createContext(context);vm.runInContext(source,context);
  await finished;
  return {sent,pageCalls,tabs};
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
test('a correctly signed request runs, and only the key opens its result',async()=>{
  const {sent,pageCalls}=await bridge(nonce=>{const payload=JSON.stringify(request);return {payload,signature:sign('request\n'+nonce+'\n'+payload)};});
  assert.deepEqual(pageCalls,['identity']);
  const poll=sent.find(s=>s.url.endsWith('/poll'));
  assert.equal(poll.headers['X-Signature'],sign('poll\n'+session+'\n'+poll.headers['X-Nonce']),'the poll is signed for the session of this server run');
  assert.ok(!(await sealedResponse(sent)).includes(account),'a program that holds the port cannot read the result');
  assert.deepEqual(await opened(sent),{id:'r1',data:{account,baseUrl:'https://mail.google.com/mail/u/0/',extensionVersion:'1.0.0'}});
  assert.ok(!JSON.stringify(sent).includes(token));
});
const signed=request=>nonce=>{const payload=JSON.stringify(request);return {payload,signature:sign('request\n'+nonce+'\n'+payload)};};
test('calendar requests use a background Calendar tab for the configured account and close it',async()=>{
  const {sent,pageCalls,tabs}=await bridge(signed({id:'c1',action:'calendar_list'}),(args,n)=>{
    assert.equal(args.expectedAccount,account);
    return n<2?{ready:false}:{account,calendars:[]};
  });
  assert.deepEqual(pageCalls,['calendar_list','calendar_list'],'loading is retried');
  assert.deepEqual(tabs,['window minimized false https://calendar.google.com/calendar/u/0/r?authuser='+encodeURIComponent(account),'close 7']);
  assert.deepEqual(await opened(sent),{id:'c1',data:{account,calendars:[]}});
});
test('a calendar page error is returned once, without retries, and the tab is closed',async()=>{
  const {sent,pageCalls,tabs}=await bridge(signed({id:'c2',action:'calendar_event',eventId:'abc'}),()=>({error:'Calendar account identity missing or mismatched'}));
  assert.deepEqual(pageCalls,['calendar_event']);
  assert.equal(tabs.at(-1),'close 7');
  assert.equal((await opened(sent)).error,'Calendar account identity missing or mismatched');
});
test('send and calendar create are refused unless setup turned them on',async()=>{
  for(const request of [{id:'w1',action:'send',to:'a@b.com',subject:'x',body:'y'},{id:'w2',action:'calendar_create',title:'x',start:'2026-10-14',end:'2026-10-15'}]) {
    const {sent,pageCalls,tabs}=await bridge(signed(request),()=>assert.fail('no calendar page'));
    assert.deepEqual(pageCalls,[]);assert.deepEqual(tabs,[]);
    assert.equal((await opened(sent)).error,'Action not allowed');
  }
  const {pageCalls}=await bridge(signed({id:'w3',action:'calendar_create',title:'x',start:'2026-10-14',end:'2026-10-15'}),()=>({account,status:'created'}),{allowCalendarWrite:true});
  assert.deepEqual(pageCalls,['calendar_create']);
});
test('without an open Gmail tab, the account is checked in a tab of a minimized window, which is closed',async()=>{
  const {sent,pageCalls,tabs}=await bridge(signed({id:'i1',action:'identity'}),null,{},[]);
  assert.deepEqual(pageCalls,['identity']);
  assert.deepEqual(tabs,['window minimized false https://mail.google.com/mail/u/?authuser='+encodeURIComponent(account),'close 7']);
  assert.equal((await opened(sent)).data.account,account);
});
test('send refuses when the subject search finds anything, also another subject, and opens no composer',async()=>{
  const request={id:'s1',action:'send',to:'a@randstad.com',subject:'Planning',body:'x'};
  const {sent,pageCalls,tabs}=await bridge(signed(request),args=>({account,visibleCount:50,emails:[{subject:'Planning 0'}]}),{allowSend:true});
  assert.deepEqual(pageCalls,['identity','search']);
  assert.match((await opened(sent)).error,/already uses this subject.*Nothing was sent/);
  assert.equal(tabs.at(-1),'close 7');
});
