import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const expectedAccount='jan.kowalski@randstad.com';
const source=readFileSync(new URL('../gmail/extension/calendar.js',import.meta.url),'utf8').replace('export async function','async function');
// Runs the page operation against a fake Calendar API; `api(path,key,params)` returns [status, body].
async function run(args, api, {cookie='SAPISID=abc/def; other=1', html='<script>"AIzaSyA00000000000000000000000000000000-0" "AIzaSyB11111111111111111111111111111111_1"</script>', pathname='/calendar/u/3/r'}={}) {
  const calls=[];
  const fetch=async(url,options)=>{
    const u=new URL(url);calls.push({path:u.pathname.replace('/calendar/v3/',''),params:Object.fromEntries(u.searchParams),headers:options.headers,credentials:options.credentials,method:options.method,body:options.body&&JSON.parse(options.body)});
    const [status,body]=api(calls.at(-1).path,u.searchParams.get('key'),calls.at(-1).params);
    return {ok:status===200,status,json:async()=>{if(body instanceof Error)throw body;return body;}};
  };
  const context={document:{cookie,documentElement:{innerHTML:html}},location:{pathname,origin:'https://calendar.google.com'},fetch,crypto:globalThis.crypto,TextEncoder,URLSearchParams,AbortSignal,args:{expectedAccount,...args}};
  vm.createContext(context);
  const result=await vm.runInContext(source+'\ncalendarPageOperation(args);',context);
  return {result:JSON.parse(JSON.stringify(result)),calls};
}
const primary=path=>path==='calendars/primary'?[200,{id:expectedAccount}]:null;
test('waits while the page has no session, account index or key, and calls nothing',async()=>{
  for(const page of [{cookie:'other=1'},{html:'<p></p>'},{pathname:'/calendar/r'}]) {
    const {result,calls}=await run({action:'calendar_list'},()=>assert.fail('no call'),page);
    assert.deepEqual(result,{ready:false});assert.equal(calls.length,0);
  }
});
test('another signed-in account is refused before any calendar data is read',async()=>{
  const {result,calls}=await run({action:'calendar_events',timeMin:'a',timeMax:'b'},path=>path==='calendars/primary'?[200,{id:'other@example.com'}]:assert.fail('no data call'));
  assert.match(result.error,/identity/);assert.equal(calls.length,1);
});
test('a key blocked for Calendar falls back to the next; session headers are sent',async()=>{
  const {result,calls}=await run({action:'calendar_events',timeMin:'2026-10-12T00:00:00Z',timeMax:'2026-10-13T00:00:00Z',query:'sync',limit:5},(path,key)=>
    key.startsWith('AIzaSyA')?[403,{error:{message:'Requests to this API calendar method are blocked.'}}]:primary(path)||[200,{items:[{id:'e1',summary:'Phoenix sync',attendees:[{email:expectedAccount,self:true,responseStatus:'accepted'},{email:'x@randstad.com'}],description:'secret agenda'}]}]);
  assert.deepEqual(result.events,[{id:'e1',summary:'Phoenix sync',organizer:undefined,myResponse:'accepted',attendeeCount:2,status:undefined,start:undefined,end:undefined,location:undefined,meetLink:undefined,recurringEventId:undefined}].map(e=>JSON.parse(JSON.stringify(e))));
  const list=calls.at(-1);
  assert.equal(list.path,'calendars/primary/events');
  assert.deepEqual({...list.params,key:undefined},{singleEvents:'true',orderBy:'startTime',timeMin:'2026-10-12T00:00:00Z',timeMax:'2026-10-13T00:00:00Z',maxResults:'5',q:'sync',key:undefined});
  assert.match(list.headers.Authorization,/^SAPISIDHASH \d+_[0-9a-f]{40}$/);assert.equal(list.headers['X-Goog-AuthUser'],'3');assert.equal(list.credentials,'include');
});
test('not found stops without trying other keys; IDs are path-encoded',async()=>{
  const {result,calls}=await run({action:'calendar_event',calendarId:'en.dutch#holiday@group.v.calendar.google.com',eventId:'abc_20261012'},path=>primary(path)||[404,{error:{message:'Not Found'}}]);
  assert.equal(result.error,'Calendar API: Not Found');
  assert.deepEqual(calls.slice(1).map(c=>c.path),['calendars/en.dutch%23holiday%40group.v.calendar.google.com/events/abc_20261012']);
});
test('unknown actions are refused',async()=>{
  assert.deepEqual((await run({action:'calendar_insert'},()=>assert.fail('no call'))).result,{error:'Action not allowed'});
});
test('an unreadable successful response is an error, not an empty calendar',async()=>{
  const {result}=await run({action:'calendar_events',timeMin:'a',timeMax:'b'},path=>primary(path)||[200,new SyntaxError('Unexpected end of JSON input')]);
  assert.match(result.error,/JSON/);
});
test('short and empty pages are followed up to the limit; more reports what is left',async()=>{
  const pages={'':[200,{items:[{id:'e1'}],nextPageToken:'p2'}],p2:[200,{items:[],nextPageToken:'p3'}],p3:[200,{items:[{id:'e2'},{id:'e3'}],nextPageToken:'p4'}]};
  const {result,calls}=await run({action:'calendar_events',timeMin:'a',timeMax:'b',limit:3},(path,key,params)=>primary(path)||(key.startsWith('AIzaSyA')?pages[params.pageToken||'']:assert.fail('first key works')));
  assert.deepEqual(result.events.map(e=>e.id),['e1','e2','e3']);assert.equal(result.more,true);
  assert.deepEqual(calls.slice(1).map(c=>[c.params.pageToken,c.params.maxResults]),[[undefined,'3'],['p2','2'],['p3','2']]);
});
test('create posts one event with a fixed ID; guests are invited only when there are guests',async()=>{
  const created={id:'0f0e',summary:'Planning',start:{date:'2026-10-14'},end:{date:'2026-10-15'},htmlLink:'https://calendar.google.com/event?eid=x'};
  const {result,calls}=await run({action:'calendar_create',eventId:'0f0e',title:'Planning',start:'2026-10-14',end:'2026-10-15'},path=>primary(path)||[200,created]);
  assert.equal(result.status,'created');assert.equal(result.event.link,created.htmlLink);
  const post=calls.at(-1);
  assert.equal(post.method,'POST');assert.equal(post.path,'calendars/primary/events');assert.equal(post.params.sendUpdates,'none');
  assert.deepEqual(post.body,{id:'0f0e',summary:'Planning',start:{date:'2026-10-14'},end:{date:'2026-10-15'}});
  assert.equal(post.headers['Content-Type'],'application/json');assert.match(post.headers.Authorization,/^SAPISIDHASH /);
  const timed=await run({action:'calendar_create',eventId:'0f0f',title:'Sync',start:'2026-10-14T09:00:00+02:00',end:'2026-10-14T09:30:00+02:00',attendees:['a@randstad.com']},path=>primary(path)||[200,created]);
  assert.equal(timed.calls.at(-1).params.sendUpdates,'all');
  assert.deepEqual(timed.calls.at(-1).body.attendees,[{email:'a@randstad.com'}]);assert.deepEqual(timed.calls.at(-1).body.start,{dateTime:'2026-10-14T09:00:00+02:00'});
});
test('create is refused for another account and reports an existing ID as an error',async()=>{
  const other=await run({action:'calendar_create',eventId:'0f0e',title:'x',start:'2026-10-14',end:'2026-10-15'},path=>path==='calendars/primary'?[200,{id:'other@example.com'}]:assert.fail('no create'));
  assert.match(other.result.error,/identity/);
  const {result}=await run({action:'calendar_create',eventId:'0f0e',title:'x',start:'2026-10-14',end:'2026-10-15'},path=>primary(path)||[409,{error:{message:'The requested identifier already exists.'}}]);
  assert.equal(result.error,'Calendar API: The requested identifier already exists.');
});
