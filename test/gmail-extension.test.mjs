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
// toolbar title at start, the last focused window, `openNotice`, which runs before each notice tab opens, and
// `lookup(n)`, which runs after notice lookup n has seen the open notices and before it returns them.
async function bridge(answers,calendarPage,settings={},gmailTabs=[{id:1}],signedIn=()=>true,browser={}) {
  answers=[answers].flat();
  const sent=[],pageCalls=[],tabs=[],noticeTabs=browser.hiddenNotice?[{tabId:99,windowId:3,active:false}]:[];let polls=0,done,timer,badge='',title=browser.title??'Gmail for Claude',clicked,messaged,noticeId=100,lookups=0;
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
    const tabId=noticeId++;noticeTabs.push({tabId,windowId,active:true});return tabId;
  };
  const chrome={runtime:{getURL:path=>path==='bridge-local.json'?'fixture-config':'chrome-extension://ext/'+path,getManifest:()=>({version:'1.0.0',action:{default_title:'Gmail for Claude'}}),
      getContexts:async({contextTypes,documentUrls})=>{
        if(contextTypes+''!=='TAB'||documentUrls+''!==noticeUrl)return [];
        const open=noticeTabs.map(({tabId,windowId})=>({tabId,windowId}));await browser.lookup?.(++lookups);return open;},onStartup:{addListener(){}},onInstalled:{addListener(){}},onMessage:{addListener(f){messaged=f;}}},
    alarms:{create(){},onAlarm:{addListener(){}}},
    action:{setBadgeText:async({text})=>{badge=text;},setBadgeBackgroundColor:async()=>{},getTitle:async()=>title,setTitle:async t=>{title=t.title;},onClicked:{addListener(f){clicked=f;}}},
    tabs:{query:async()=>gmailTabs,create:async({url,windowId})=>{const id=await opensNotice(url,windowId);tabs.push('open '+url+' in '+windowId);return {id:id??8};},
      update:async(id,{active})=>{
        tabs.push('activate '+id+' '+active);
        const shown=noticeTabs.find(t=>t.tabId===id&&!t.active&&active);
        if(shown){shown.active=true;setTimeout(()=>messaged('recheck',{url:noticeUrl}));}},remove:async id=>{tabs.push('close '+id);noticeTabs.splice(0,noticeTabs.length,...noticeTabs.filter(t=>t.tabId!==id));}},
    windows:{create:async({url,state,focused})=>{const id=await opensNotice(url,9);tabs.push('window '+state+' '+focused+' '+url);return {id:9,state,tabs:[{id:id??7}]};},
      getLastFocused:async()=>browser.lastWindow??{id:3,state:'normal'},
      get:async id=>({id,state:'normal',tabs:noticeTabs.filter(t=>t.windowId===id).map(t=>({id:t.tabId,active:t.active}))}),update:async(id,{focused})=>{tabs.push('focus '+id+' '+focused);}},
    scripting:{executeScript:async({args:[args]})=>{pageCalls.push(args.action);return [{result:args.action==='identity'?(await signedIn())&&{account,baseUrl:'https://mail.google.com/mail/u/0/'}:calendarPage(args,pageCalls.length)}];}}};
  const context={fetch,chrome,crypto:globalThis.crypto,TextEncoder,AbortSignal,URL,Blob,setTimeout:f=>setTimeout(f),gmailPageOperation(){},extractReadThread(){},prepareDraft(){},calendarPageOperation(){}};
  vm.createContext(context);vm.runInContext(source,context);
  await finished;
  return {sent,pageCalls,tabs,badge:()=>badge,title:()=>title,click:()=>clicked(),message:(m,url=noticeUrl)=>messaged(m,{url}),openNotices:()=>noticeTabs.length,closeNotices:()=>{noticeTabs.length=0;}};
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
  assert.equal(tabs.at(-1),'close 100','success closes the notice');
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
  const before=tabs.length;
  await click();
  assert.deepEqual(tabs.slice(before,before+2),['activate 100 true','focus 3 true'],'a click focuses the open notice');
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
test('a click on the icon checks the signed-out services again, and when they work the mark clears and the notice closes',async()=>{
  const {tabs,pageCalls,click,badge,title,openNotices}=await bridge([],()=>({account,calendars:[]}),{},[{id:1}],()=>true,{title:'Gmail for Claude. Sign in needed: Gmail, Calendar'});
  await click();await settle();
  assert.deepEqual(pageCalls,['identity','calendar_list']);
  assert.equal(title(),'Gmail for Claude');
  assert.equal(badge(),'');
  assert.equal(openNotices(),0,'the notice is closed, so it does not claim Gmail is signed out');
});
test('the notice asks for a check when it is shown again; after a sign-in the mark clears and the notice closes',async()=>{
  let signedIn=false;
  const {tabs,message,badge,title,openNotices}=await bridge(signed({id:'g1',action:'identity'}),null,{},[],()=>signedIn);
  await settle();
  assert.deepEqual(notices(tabs),[notice]);
  signedIn=true;
  message('recheck','https://mail.google.com/');await settle();
  assert.equal(title(),'Gmail for Claude. Sign in needed: Gmail','only the notice page can ask for a check');
  signedIn=false;
  message('recheck');await settle();
  assert.equal(openNotices(),1,'still signed out: the notice stays');
  assert.equal(title(),'Gmail for Claude. Sign in needed: Gmail');
  signedIn=true;
  message('recheck');await settle();
  assert.equal(openNotices(),0);
  assert.equal(badge(),'');
  assert.equal(title(),'Gmail for Claude');
});
const latch=()=>{let release;const wait=new Promise(r=>release=r);return {wait,release};};
function slowCheck(n,state) {
  const reached=latch(),held=latch();let calls=0;
  return {reached:reached.wait,release:held.release,signedIn:async()=>{
    const up=state.up;
    if(++calls===n){reached.release();await held.wait;}
    return up;
  }};
}
test('a Claude request that started before a sign-in and fails after a successful check does not bring the mark back',async()=>{
  const state={up:false},slow=slowCheck(40,state);
  const {sent,message,badge,title,openNotices}=await bridge(signed({id:'g1',action:'identity'}),null,{},[],slow.signedIn,{title:'Gmail for Claude. Sign in needed: Gmail'});
  await slow.reached;
  state.up=true;
  message('recheck');await settle();
  slow.release();await settle();
  assert.deepEqual(await opened(sent),{id:'g1',error:gmailSignInError},'the request still fails, as its own check did');
  assert.equal(badge(),'','the check that started later decides');
  assert.equal(title(),'Gmail for Claude');
  assert.equal(openNotices(),0);
});
test('a check that started before a sign-in and fails after a successful Claude request does not bring the mark back',async()=>{
  const state={up:false},slow=slowCheck(40,state),arrive=latch();
  const answer=async nonce=>{await arrive.wait;return signed({id:'g1',action:'identity'})(nonce);};
  const {sent,click,badge,title,openNotices}=await bridge(answer,null,{},[],slow.signedIn,{title:'Gmail for Claude. Sign in needed: Gmail'});
  const clicking=click();
  await slow.reached;
  state.up=true;
  arrive.release();await settle();
  slow.release();await clicking;await settle();
  assert.equal((await opened(sent)).data.account,account);
  assert.equal(badge(),'');
  assert.equal(title(),'Gmail for Claude');
  assert.equal(openNotices(),0,'the notice from the click closes and no new one opens');
});
test('a check asked for while another check runs is not lost',async()=>{
  const state={up:false},slow=slowCheck(40,state);
  const {click,message,badge,openNotices}=await bridge([],null,{},[],slow.signedIn,{title:'Gmail for Claude. Sign in needed: Gmail'});
  const clicking=click();
  await slow.reached;
  state.up=true;
  message('recheck');message('recheck');
  slow.release();await clicking;await settle();
  assert.equal(badge(),'');
  assert.equal(openNotices(),0);
});
test('a notice that is closing after Gmail recovers stays for a Calendar failure that comes during the close',async()=>{
  let gmailUp=false;const close=latch();
  const answers=[signed({id:'g1',action:'identity'}),nonce=>{gmailUp=true;return signed({id:'g2',action:'identity'})(nonce);},
    signed({id:'c1',action:'calendar_list'}),async nonce=>{close.release();await settle();return signed({id:'c2',action:'calendar_list'})(nonce);}];
  const {sent,tabs,badge,title,openNotices}=await bridge(answers,()=>mismatch,{},[],()=>gmailUp,{lookup:n=>n===2&&close.wait});
  await settle();
  assert.equal((await opened(sent,1)).data.account,account);
  for(const i of [2,3]) assert.equal((await opened(sent,i)).error,'Calendar account identity missing or mismatched');
  assert.equal(badge(),'!');
  assert.equal(title(),'Gmail for Claude. Sign in needed: Calendar');
  assert.equal(openNotices(),1,'the notice stays open for Calendar');
  assert.deepEqual(notices(tabs),[notice]);
});
test('one click on a hidden notice runs one check, and a Claude request during the check answers without waiting for it',async()=>{
  const state={up:false},slow=slowCheck(1,state),arrive=latch();
  const answer=async nonce=>{await arrive.wait;return signed({id:'c1',action:'calendar_list'})(nonce);};
  const {sent,tabs,click}=await bridge(answer,()=>({account,calendars:[]}),{},[],slow.signedIn,{title:'Gmail for Claude. Sign in needed: Gmail',hiddenNotice:true});
  const clicking=click();
  await slow.reached;
  arrive.release();await settle();
  assert.equal(sent.filter(s=>s.url.endsWith('/response')).length,1,'Claude has its answer while the check still runs');
  assert.deepEqual(await opened(sent),{id:'c1',data:{account,calendars:[]}});
  slow.release();await clicking;await new Promise(r=>setTimeout(r,200));
  assert.equal(tabs.filter(t=>/^(open|window) .*mail\.google\.com/.test(t)).length,1,'the click and the notice coming into view share one Gmail check');
});
function noticePage(config) {
  const elements={},listeners={},messages=[];
  const document={visibilityState:'hidden',getElementById:id=>elements[id]??={id,remove(){delete elements[id];}},addEventListener:(type,f)=>{listeners[type]=f;}};
  const context={document,fetch:async()=>{if(!config)throw new Error('missing');return {json:async()=>config};},chrome:{runtime:{getURL:p=>'chrome-extension://ext/'+p,sendMessage:async m=>{messages.push(m);}}},URLSearchParams,encodeURIComponent};
  vm.createContext(context);
  const source=readFileSync(new URL('../gmail/extension/notice.js',import.meta.url),'utf8');
  return {done:vm.runInContext('(async()=>{'+source+'\n})()',context),elements,document,listeners,messages};
}
test('the notice Sign in button starts a Google sign-in for the configured account, not the account Chrome uses first',async()=>{
  const page=noticePage({account});
  await page.done;
  const link=new URL(page.elements.signin.href);
  assert.equal(link.origin+link.pathname,'https://accounts.google.com/AddSession');
  assert.equal(link.searchParams.get('Email'),account);
  assert.equal(link.searchParams.get('continue'),'https://mail.google.com/mail/u/?authuser='+encodeURIComponent(account));
  assert.equal(page.elements.account.textContent,account);
});
test('the notice asks the extension to check again each time it comes back into view',async()=>{
  const page=noticePage(null);
  await page.done;
  assert.equal(page.elements.signin,undefined,'without the setup file there is no Sign in button');
  page.listeners.visibilitychange();
  assert.deepEqual(page.messages,[],'a hidden notice asks for nothing');
  page.document.visibilityState='visible';page.listeners.visibilitychange();
  assert.deepEqual(page.messages,['recheck']);
});
test('the notice text does not name one service, because either Gmail or Calendar can be the signed-out one',()=>{
  const html=readFileSync(new URL('../gmail/extension/notice.html',import.meta.url),'utf8');
  assert.doesNotMatch(html,/cannot reach Gmail/);
  assert.match(html,/id="signin"[^>]*target="_blank"/,'the sign-in opens in a new tab, so the notice stays and checks again when the user comes back');
});
