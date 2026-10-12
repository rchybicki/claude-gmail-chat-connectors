import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const expectedAccount='jan.kowalski@randstad.com';
// Isolated copy with its own token and port: never talks to a live bridge.
const dir=mkdtempSync(join(tmpdir(),'randstad-gmail-test-'));
cpSync(new URL('../gmail',import.meta.url),join(dir,'gmail'),{recursive:true,filter:src=>!src.endsWith('bridge-local.json')});
cpSync(new URL('../node_modules',import.meta.url),join(dir,'node_modules'),{recursive:true});
const token=randomBytes(32).toString('hex'),port=20000+Math.floor(Math.random()*20000),base='http://127.0.0.1:'+port;
writeFileSync(join(dir,'gmail','extension','bridge-local.json'),JSON.stringify({account:expectedAccount,token,port}));
test.after(()=>rmSync(dir,{recursive:true,force:true}));
// Plays the extension's side of the signed bridge protocol.
const sign=text=>createHmac('sha256',Buffer.from(token,'hex')).update(text).digest('hex');
const poll=async(nonce=randomUUID(),signature=sign('poll\n'+nonce),extra={})=>fetch(base+'/poll',{headers:{'X-Nonce':nonce,'X-Signature':signature,...extra}});
async function nextRequest(nonce=randomUUID(),waiting=poll(nonce)){
  const {payload,signature}=await (await waiting).json();
  assert.equal(signature,sign('request\n'+nonce+'\n'+payload),'server signs each request for this poll');
  return JSON.parse(payload);
}
const respond=(body,signature=sign('response\n'+JSON.stringify(body)))=>fetch(base+'/response',{method:'POST',headers:{'Content-Type':'application/json','X-Signature':signature},body:JSON.stringify(body)});
test('MCP discovery, bridge authentication, routing and error propagation',async()=>{
  const client=new Client({name:'local-trial-test',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[join(dir,'gmail','server.mjs')],stderr:'pipe'});
  try {
    await client.connect(transport);
    const list=await client.listTools();assert.deepEqual(list.tools.map(t=>t.name),['account_identity','search_emails','read_email','read_email_and_mark_read','archive_email','create_email_draft','list_calendars','list_events','get_event']);
    assert.equal((await fetch(base+'/poll')).status,403);
    assert.equal((await fetch(base+'/poll',{headers:{Authorization:'Bearer '+token}})).status,403,'the old bearer form is refused');
    assert.equal((await poll(randomUUID(),'0'.repeat(64))).status,403);
    assert.equal((await poll(undefined,undefined,{Origin:'https://evil.example'})).status,403);
    const reused=randomUUID(),first=poll(reused);await new Promise(r=>setTimeout(r,200));
    assert.equal((await poll(reused)).status,403,'a nonce works once');
    assert.equal((await fetch(base+'/other')).status,404);
    assert.equal((await client.callTool({name:'send_email',arguments:{from:'other@example.com'}})).isError,true);
    for(const args of [{to:'a@b.com\r\nBcc: x@y.com',subject:'test',body:'test'},{to:'a@b.com',subject:'x" OR in:anywhere',body:'test'},{to:'a@b.com',subject:'test',body:'test',send:true}])assert.equal((await client.callTool({name:'create_email_draft',arguments:args})).isError,true);
    assert.equal((await client.callTool({name:'search_emails',arguments:{query:'test',accountEmail:'other@example.com'}})).isError,true);
    for(const args of [{query:'in:inbox test',emailId:'123456789abcdef'},{query:'label:Spam',emailId:'123456789abcdef'},{query:'test',emailId:'wrong'},{query:'test',emailId:'123456789abcdef',accountEmail:'other@example.com'}])
      assert.equal((await client.callTool({name:'archive_email',arguments:args})).isError,true);
    const archive=client.callTool({name:'archive_email',arguments:{query:'subject:test',emailId:'123456789abcdef'}});
    const archiveRequest=await nextRequest(reused,first);
    assert.equal(archiveRequest.action,'archive');assert.equal(archiveRequest.emailId,'123456789abcdef');
    assert.equal((await respond({id:archiveRequest.id,error:'forged'},'0'.repeat(64))).status,403,'unsigned responses are refused');
    await respond({id:archiveRequest.id,error:'Archive result could not be verified; inspect Gmail before retrying'});
    assert.equal((await archive).isError,true);
    const call=client.callTool({name:'account_identity',arguments:{}});
    const request=await nextRequest();
    assert.equal(request.action,'identity');
    assert.equal((await respond({id:request.id,data:{account:'other@example.com'}})).status,400);
    await respond({id:request.id,error:'Identity check failed'});
    assert.equal((await call).isError,true);
    for(const args of [{timeMin:'2026-10-12',timeMax:'2026-10-13T00:00:00Z'},{timeMin:'2026-10-12T00:00:00Z'},{timeMin:'2026-10-12T00:00:00Z',timeMax:'2026-10-13T00:00:00Z',limit:251},{timeMin:'2026-10-12T00:00:00Z',timeMax:'2026-10-13T00:00:00Z',calendarId:'a b'},{timeMin:'2026-10-12T00:00:00Z',timeMax:'2026-10-13T00:00:00Z',showDeleted:true},{timeMin:'2026-02-30T00:00:00Z',timeMax:'2026-03-02T00:00:00Z'},{timeMin:'2026-10-12T00:00Z',timeMax:'2026-10-13T00:00:00Z'},{timeMin:'2026-10-13T00:00:00Z',timeMax:'2026-10-12T00:00:00Z'}])
      assert.equal((await client.callTool({name:'list_events',arguments:args})).isError,true);
    for(const args of [{eventId:'../other'},{eventId:['abc']},{eventId:123},{eventId:'abc',accountEmail:'other@example.com'}])assert.equal((await client.callTool({name:'get_event',arguments:args})).isError,true);
    const events=client.callTool({name:'list_events',arguments:{timeMin:'2026-10-12T00:00:00+02:00',timeMax:'2026-10-13T00:00:00+02:00',limit:100}});
    const request3=await nextRequest();
    assert.equal(request3.action,'calendar_events');assert.equal(request3.limit,100);
    assert.equal((await respond({id:request3.id,data:{account:'other@example.com',events:[]}})).status,400,'another account is refused');
    await respond({id:request3.id,data:{account:expectedAccount,events:[]}});
    assert.equal((await events).isError,undefined);
    const search=client.callTool({name:'search_emails',arguments:{query:'test',limit:1}});
    const request2=await nextRequest();
    assert.equal(request2.action,'search');assert.equal(request2.query,'test');
    await respond({id:request2.id,data:{account:expectedAccount,emails:[]}});
    assert.equal((await search).isError,undefined);
  } finally {await client.close();}
});
test('invalid local configuration stops the server before it listens',()=>{
  for(const config of [{token:'short'},{token,allowSend:'yes'},{token,allowCalendarWrite:1}]) {
    writeFileSync(join(dir,'gmail','extension','bridge-local.json'),JSON.stringify({account:expectedAccount,port,...config}));
    const run=spawnSync(process.execPath,[join(dir,'gmail','server.mjs')],{input:'',encoding:'utf8',timeout:10000});
    assert.notEqual(run.status,0);assert.match(run.stderr,/Invalid local configuration/);
  }
});
test('a second copy keeps running while another app owns the port, then takes it over',async()=>{
  writeFileSync(join(dir,'gmail','extension','bridge-local.json'),JSON.stringify({account:expectedAccount,token,port}));
  const blocker=createServer().listen(port,'127.0.0.1');
  await new Promise(r=>blocker.once('listening',r));
  const client=new Client({name:'second-copy',version:'1.0.0'});
  try {
    const transport=new StdioClientTransport({command:process.execPath,args:[join(dir,'gmail','server.mjs')],stderr:'pipe'});
    let stderr='';transport.stderr.on('data',d=>stderr+=d);
    await client.connect(transport);
    for(let i=0;i<12;i++){
      const busy=await client.callTool({name:'account_identity',arguments:{}});
      assert.equal(busy.isError,true);assert.match(busy.content[0].text,/in use.*another Claude app/);
    }
    assert.doesNotMatch(stderr,/MaxListeners/,'failed attempts leave no listeners behind');
    await new Promise(r=>blocker.close(r));
    const call=client.callTool({name:'account_identity',arguments:{}});
    const request=await nextRequest();
    assert.equal(request.action,'identity');
    await respond({id:request.id,data:{account:expectedAccount}});
    assert.equal((await call).isError,undefined);
  } finally {await client.close();blocker.close();}
});
test('send and calendar create exist only when setup turned them on, and are checked and routed',async()=>{
  writeFileSync(join(dir,'gmail','extension','bridge-local.json'),JSON.stringify({account:expectedAccount,token,port,allowSend:true,allowCalendarWrite:true}));
  const client=new Client({name:'write-options',version:'1.0.0'});
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,args:[join(dir,'gmail','server.mjs')],stderr:'pipe'}));
    const names=(await client.listTools()).tools.map(t=>t.name);
    assert.ok(names.includes('send_email')&&names.includes('create_event'));
    for(const args of [{to:'a@b.com',subject:'x',body:'y',cc:'c@d.com'},{to:'a@b.com, c@d.com',subject:'x',body:'y'},{to:'a@b.com',subject:'x"',body:'y'}])
      assert.equal((await client.callTool({name:'send_email',arguments:args})).isError,true);
    const day={title:'Planning',start:'2026-10-14',end:'2026-10-15'};
    for(const args of [{...day,end:'2026-10-14'},{...day,start:'2026-10-14T09:00:00+02:00'},{...day,start:'2026-02-30',end:'2026-03-01'},{...day,title:' '},{...day,attendees:'a@b.com'},{...day,attendees:['a@b.com','a@b.com']},{...day,attendees:['not an email']},{...day,eventId:'mine'},{...day,description:7}])
      assert.equal((await client.callTool({name:'create_event',arguments:args})).isError,true);
    const create=client.callTool({name:'create_event',arguments:{...day,attendees:['a@randstad.com']}});
    const request=await nextRequest();
    assert.equal(request.action,'calendar_create');assert.match(request.eventId,/^[0-9a-f]{32}$/);assert.deepEqual(request.attendees,['a@randstad.com']);
    await respond({id:request.id,data:{account:expectedAccount,status:'created'}});
    assert.equal((await create).isError,undefined);
    const send=client.callTool({name:'send_email',arguments:{to:'a@randstad.com',subject:'Hello',body:'Text'}});
    const request2=await nextRequest();
    assert.equal(request2.action,'send');assert.equal(request2.to,'a@randstad.com');
    await respond({id:request2.id,error:'Send not confirmed'});
    assert.equal((await send).isError,true);
  } finally {await client.close();}
});
