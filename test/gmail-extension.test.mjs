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
const sealedResponse=async(sent,i=0)=>Buffer.from(await sent.filter(s=>s.url.endsWith('/response'))[i].body.arrayBuffer());
const opened=async(sent,i=0)=>{
  const sealed=await sealedResponse(sent,i),open=createDecipheriv('aes-256-gcm',responseKey,sealed.subarray(0,12),{authTagLength:16});
  open.setAuthTag(sealed.subarray(-16));
  return JSON.parse(Buffer.concat([open.update(sealed.subarray(12,-16)),open.final()]));
};
// Runs the extension against a server that answers poll n with `answers[n](nonce,badge)`; a single answer serves one poll.
// Waits run at once. `signedIn()` decides whether the Gmail identity check finds the account.
async function bridge(answers,calendarPage,settings={},gmailTabs=[{id:1}],signedIn=()=>true) {
  answers=[answers].flat();
  const sent=[],pageCalls=[],tabs=[];let polls=0,done,timer,badge='',clicked;
  const finished=new Promise(r=>done=r);
  const fetch=async(url,options={})=>{
    if(url==='fixture-config')return {json:async()=>({account,token,port,...settings})};
    sent.push({url,headers:options.headers,body:options.body});
    if(url.endsWith('/session'))return {ok:true,json:async()=>({session})};
    if(url.endsWith('/poll')){
      clearTimeout(timer);
      if(++polls>answers.length){timer=setTimeout(done,10);throw new Error('stop');}
      timer=setTimeout(done,1000); // A refused request ends the loop without another poll.
      return {ok:true,json:async()=>answers[polls-1](options.headers['X-Nonce'],badge)};
    }
    return {ok:true,json:async()=>({ok:true})};
  };
  const chrome={runtime:{getURL:path=>path==='bridge-local.json'?'fixture-config':'chrome-extension://ext/'+path,getManifest:()=>({version:'1.0.0'}),onStartup:{addListener(){}},onInstalled:{addListener(){}}},
    alarms:{create(){},onAlarm:{addListener(){}}},
    action:{getBadgeText:async()=>badge,setBadgeText:async({text})=>{badge=text;},setBadgeBackgroundColor:async()=>{},onClicked:{addListener(f){clicked=f;}}},
    tabs:{query:async()=>gmailTabs,create:async({url,windowId})=>{tabs.push('open '+url+' in '+windowId);return {id:8};},remove:async id=>{tabs.push('close '+id);}},
    windows:{create:async({url,state,focused})=>{tabs.push('window '+state+' '+focused+' '+url);return {id:9,state,tabs:[{id:7}]};},
      getLastFocused:async()=>({id:3}),update:async(id,{focused})=>{tabs.push('focus '+id+' '+focused);}},
    scripting:{executeScript:async({args:[args]})=>{pageCalls.push(args.action);return [{result:args.action==='identity'?signedIn()&&{account,baseUrl:'https://mail.google.com/mail/u/0/'}:calendarPage(args,pageCalls.length)}];}}};
  const context={fetch,chrome,crypto:globalThis.crypto,TextEncoder,AbortSignal,URL,Blob,setTimeout:f=>setTimeout(f),gmailPageOperation(){},extractReadThread(){},prepareDraft(){},calendarPageOperation(){}};
  vm.createContext(context);vm.runInContext(source,context);
  await finished;
  return {sent,pageCalls,tabs,badge:()=>badge,click:()=>clicked()};
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
const notice='open chrome-extension://ext/notice.html in 3';
// Each answer records the icon badge as the request arrives.
const watched=(badges,requests)=>requests.map(request=>(nonce,badge)=>{badges.push(badge);return signed(request)(nonce);});
test('a Gmail sign-in failure marks the icon and opens one notice for many failures; the next success clears the mark',async()=>{
  const badges=[];
  const answers=watched(badges,['g1','g2','g3','g4'].map(id=>({id,action:'identity'})));
  const {sent,tabs,badge}=await bridge(answers,null,{},[],()=>badges.length===4);
  for(const i of [0,1,2]) assert.deepEqual(await opened(sent,i),{id:'g'+(i+1),error:'Sign in to Gmail with the configured account in this Chrome profile'},'Claude gets the same error as before');
  assert.deepEqual(badges,['','!','!','!'],'the first failure marks the icon');
  assert.equal(tabs.filter(t=>t===notice).length,1,'repeated failures open one notice');
  assert.equal(tabs[tabs.indexOf(notice)+1],'focus 3 true','the notice opens in the user window, which comes to the front');
  assert.equal((await opened(sent,3)).data.account,account);
  assert.equal(badge(),'','success clears the mark');
});
test('a Calendar sign-in failure, by timeout or by another account, does the same',async()=>{
  const badges=[];
  const pages={c1:{ready:false},c2:{error:'Calendar account identity missing or mismatched',signedOut:true},c3:{account,calendars:[]}};
  const {sent,tabs,badge,click}=await bridge(watched(badges,['c1','c2','c3'].map(id=>({id,action:'calendar_list'}))),args=>pages[args.id]);
  assert.deepEqual(await opened(sent,0),{id:'c1',error:'Open Google Calendar with the configured account in this Chrome profile'});
  assert.deepEqual(await opened(sent,1),{id:'c2',error:'Calendar account identity missing or mismatched'});
  assert.deepEqual(badges,['','!','!']);
  assert.equal(tabs.filter(t=>t===notice).length,1);
  assert.deepEqual(await opened(sent,2),{id:'c3',data:{account,calendars:[]}});
  assert.equal(badge(),'');
  await click();
  assert.equal(tabs.filter(t=>t===notice).length,1,'the icon opens no notice while Claude reaches the account');
});
test('other errors leave the icon alone, and the icon reopens the notice while signed out',async()=>{
  const failed=await bridge(signed({id:'e1',action:'calendar_event',eventId:'abc'}),()=>({error:'Calendar API: HTTP 404'}));
  assert.equal(failed.badge(),'');
  assert.ok(!failed.tabs.includes(notice));
  const {tabs,click}=await bridge(signed({id:'g1',action:'identity'}),null,{},[],()=>false);
  await click();
  assert.equal(tabs.filter(t=>t===notice).length,2);
});
