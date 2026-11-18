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
// Waits run at once. `signedIn()` decides whether the Gmail identity check finds the account. `browser` sets the
// toolbar title at start, the last focused window, and `openNotice`, which runs before each notice tab opens.
async function bridge(answers,calendarPage,settings={},gmailTabs=[{id:1}],signedIn=()=>true,browser={}) {
  answers=[answers].flat();
  const sent=[],pageCalls=[],tabs=[],noticeTabs=[];let polls=0,done,timer,badge='',title=browser.title??'Gmail for Claude',clicked,noticeId=100;
  const noticeUrl='chrome-extension://ext/notice.html';
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
  const opensNotice=async(url,windowId)=>{
    if(url!==noticeUrl)return;
    await browser.openNotice?.(windowId);
    const tabId=noticeId++;noticeTabs.push({tabId,windowId});return tabId;
  };
  const chrome={runtime:{getURL:path=>path==='bridge-local.json'?'fixture-config':'chrome-extension://ext/'+path,getManifest:()=>({version:'1.0.0',action:{default_title:'Gmail for Claude'}}),
      getContexts:async({contextTypes,documentUrls})=>contextTypes+''==='TAB'&&documentUrls+''===noticeUrl?noticeTabs.map(t=>({...t})):[],onStartup:{addListener(){}},onInstalled:{addListener(){}}},
    alarms:{create(){},onAlarm:{addListener(){}}},
    action:{setBadgeText:async({text})=>{badge=text;},setBadgeBackgroundColor:async()=>{},getTitle:async()=>title,setTitle:async t=>{title=t.title;},onClicked:{addListener(f){clicked=f;}}},
    tabs:{query:async()=>gmailTabs,create:async({url,windowId})=>{const id=await opensNotice(url,windowId);tabs.push('open '+url+' in '+windowId);return {id:id??8};},
      update:async(id,{active})=>{tabs.push('activate '+id+' '+active);},remove:async id=>{tabs.push('close '+id);}},
    windows:{create:async({url,state,focused})=>{const id=await opensNotice(url,9);tabs.push('window '+state+' '+focused+' '+url);return {id:9,state,tabs:[{id:id??7}]};},
      getLastFocused:async()=>browser.lastWindow??{id:3,state:'normal'},update:async(id,{focused})=>{tabs.push('focus '+id+' '+focused);}},
    scripting:{executeScript:async({args:[args]})=>{pageCalls.push(args.action);return [{result:args.action==='identity'?signedIn()&&{account,baseUrl:'https://mail.google.com/mail/u/0/'}:calendarPage(args,pageCalls.length)}];}}};
  const context={fetch,chrome,crypto:globalThis.crypto,TextEncoder,AbortSignal,URL,Blob,setTimeout:f=>setTimeout(f),gmailPageOperation(){},extractReadThread(){},prepareDraft(){},calendarPageOperation(){}};
  vm.createContext(context);vm.runInContext(source,context);
  await finished;
  return {sent,pageCalls,tabs,badge:()=>badge,title:()=>title,click:()=>clicked(),closeNotices:()=>{noticeTabs.length=0;}};
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
const notices=tabs=>tabs.filter(t=>/^(open|window) .*notice\.html/.test(t));
const settle=()=>new Promise(r=>setTimeout(r,20));
const gmailSignInError='Sign in to Gmail with the configured account in this Chrome profile';
const mismatch={error:'Calendar account identity missing or mismatched',signedOut:true};
// Each answer records the icon badge as the request arrives.
const watched=(badges,requests)=>requests.map(request=>(nonce,badge)=>{badges.push(badge);return signed(request)(nonce);});
test('a Gmail sign-in failure marks the icon and opens one notice for many failures; the next success clears the mark',async()=>{
  const badges=[];
  const answers=watched(badges,['g1','g2','g3','g4'].map(id=>({id,action:'identity'})));
  const {sent,tabs,badge,title}=await bridge(answers,null,{},[],()=>badges.length===4);
  await settle();
  for(const i of [0,1,2]) assert.deepEqual(await opened(sent,i),{id:'g'+(i+1),error:gmailSignInError},'Claude gets the same error as before');
  assert.deepEqual(badges,['','!','!','!'],'the first failure marks the icon');
  assert.deepEqual(notices(tabs),[notice],'repeated failures open one notice');
  assert.equal(tabs[tabs.indexOf(notice)+1],'focus 3 true','the notice opens in the user window, which comes to the front');
  assert.equal((await opened(sent,3)).data.account,account);
  assert.equal(badge(),'','success clears the mark');
  assert.equal(title(),'Gmail for Claude');
});
test('only a Calendar page readiness timeout or another account counts as signed out; a Calendar HTTP 401 or API timeout does not',async()=>{
  const badges=[];
  const pages={c1:{error:'Calendar API: HTTP 401'},c2:{error:'Calendar API: signal timed out'},c3:{ready:false},c4:mismatch,c5:{account,calendars:[]}};
  const {sent,tabs,badge}=await bridge(watched(badges,['c1','c2','c3','c4','c5'].map(id=>({id,action:'calendar_list'}))),args=>pages[args.id]);
  await settle();
  assert.deepEqual(await opened(sent,0),{id:'c1',error:'Calendar API: HTTP 401'});
  assert.deepEqual(await opened(sent,1),{id:'c2',error:'Calendar API: signal timed out'});
  assert.deepEqual(await opened(sent,2),{id:'c3',error:'Open Google Calendar with the configured account in this Chrome profile'});
  assert.deepEqual(await opened(sent,3),{id:'c4',error:'Calendar account identity missing or mismatched'});
  assert.deepEqual(badges,['','','','!','!'],'the API errors leave the icon alone');
  assert.deepEqual(notices(tabs),[notice]);
  assert.deepEqual(await opened(sent,4),{id:'c5',data:{account,calendars:[]}});
  assert.equal(badge(),'');
});
test('a success of one service keeps the other signed out, and alternating results open one notice',async()=>{
  const badges=[];
  const gmailFirst=watched(badges,[{id:'g1',action:'identity'},{id:'c1',action:'calendar_list'},{id:'g2',action:'identity'},{id:'c2',action:'calendar_list'},{id:'g3',action:'identity'}]);
  const run=await bridge(gmailFirst,()=>({account,calendars:[]}),{},[],()=>false);
  await settle();
  for(const i of [0,2,4]) assert.equal((await opened(run.sent,i)).error,gmailSignInError);
  for(const i of [1,3]) assert.deepEqual((await opened(run.sent,i)).data,{account,calendars:[]},'Calendar works while Gmail is signed out');
  assert.deepEqual(badges,['','!','!','!','!'],'a Calendar success does not hide a signed-out Gmail');
  assert.deepEqual(notices(run.tabs),[notice]);
  assert.equal(run.title(),'Gmail for Claude. Sign in needed: Gmail');
  badges.length=0;
  const calendarFirst=watched(badges,[{id:'c1',action:'calendar_list'},{id:'g1',action:'identity'},{id:'c2',action:'calendar_list'},{id:'g2',action:'identity'}]);
  const back=await bridge(calendarFirst,()=>mismatch);
  await settle();
  for(const i of [0,2]) assert.equal((await opened(back.sent,i)).error,'Calendar account identity missing or mismatched');
  for(const i of [1,3]) assert.equal((await opened(back.sent,i)).data.account,account);
  assert.deepEqual(badges,['','!','!','!']);
  assert.deepEqual(notices(back.tabs),[notice]);
  assert.equal(back.badge(),'!');
  assert.equal(back.title(),'Gmail for Claude. Sign in needed: Calendar');
});
test('Claude gets the error before the notice opens, and the text is unchanged',async()=>{
  let release;const stall=new Promise(r=>release=r);
  const {sent,tabs}=await bridge(signed({id:'c1',action:'calendar_list'}),()=>mismatch,{},[{id:1}],()=>true,{openNotice:()=>stall});
  assert.deepEqual(await opened(sent),{id:'c1',error:'Calendar account identity missing or mismatched'},'the response went back while the notice tab was still opening');
  assert.deepEqual(notices(tabs),[]);
  release();await settle();
  assert.deepEqual(notices(tabs),[notice]);
});
test('the icon focuses an open notice, opens it again after it is closed, and a click during the automatic open adds no tab',async()=>{
  const failed=await bridge(signed({id:'e1',action:'calendar_event',eventId:'abc'}),()=>({error:'Calendar API: HTTP 404'}));
  await failed.click();
  assert.equal(failed.badge(),'');
  assert.deepEqual(notices(failed.tabs),[],'other errors and a click while signed in open nothing');
  let release;const stall=new Promise(r=>release=r);
  const {tabs,click,closeNotices}=await bridge(signed({id:'g1',action:'identity'}),null,{},[],()=>false,{openNotice:()=>stall});
  const pending=click();
  release();await pending;await settle();
  assert.deepEqual(notices(tabs),[notice],'the click shares the automatic open');
  await click();
  assert.deepEqual(tabs.slice(-2),['activate 100 true','focus 3 true'],'a click focuses the open notice');
  assert.equal(notices(tabs).length,1);
  closeNotices();
  await click();
  assert.equal(notices(tabs).length,2,'a click opens the notice again after it was closed');
});
test('the notice falls back to a new focused window when the user window closes first or is minimized',async()=>{
  const closed=await bridge(signed({id:'g1',action:'identity'}),null,{},[],()=>false,{openNotice:windowId=>{if(windowId===3)throw new Error('No window with id: 3.');}});
  await settle();
  assert.deepEqual(notices(closed.tabs),['window undefined true chrome-extension://ext/notice.html']);
  // After a worker restart the title still holds the state and the work window is known only as minimized.
  const restarted=await bridge([],null,{},[{id:1}],()=>true,{title:'Gmail for Claude. Sign in needed: Gmail',lastWindow:{id:9,state:'minimized'}});
  await restarted.click();
  assert.deepEqual(notices(restarted.tabs),['window undefined true chrome-extension://ext/notice.html']);
});
test('a notice that fails to open opens on the next failure',async()=>{
  let attempts=0;
  const {sent,tabs}=await bridge(['g1','g2'].map(id=>signed({id,action:'identity'})),null,{},[],()=>false,{openNotice:()=>{if(++attempts<=2)throw new Error('Chrome refused');}});
  await settle();
  assert.equal(attempts,3,'the first failure tried the user window and a new window');
  assert.deepEqual(notices(tabs),[notice]);
  assert.equal((await opened(sent,1)).error,gmailSignInError);
});
