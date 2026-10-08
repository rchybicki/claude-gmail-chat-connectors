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
    const list=await client.listTools();assert.deepEqual(list.tools.map(t=>t.name),['account_identity','search_emails','read_email','read_email_and_mark_read','archive_email','create_email_draft']);
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
    const search=client.callTool({name:'search_emails',arguments:{query:'test',limit:1}});
    const request2=await nextRequest();
    assert.equal(request2.action,'search');assert.equal(request2.query,'test');
    await respond({id:request2.id,data:{account:expectedAccount,emails:[]}});
    assert.equal((await search).isError,undefined);
  } finally {await client.close();}
});
test('invalid local configuration stops the server before it listens',()=>{
  writeFileSync(join(dir,'gmail','extension','bridge-local.json'),JSON.stringify({account:expectedAccount,token:'short',port}));
  const run=spawnSync(process.execPath,[join(dir,'gmail','server.mjs')],{input:'',encoding:'utf8',timeout:10000});
  assert.notEqual(run.status,0);assert.match(run.stderr,/Invalid local configuration/);
});
test('a second copy keeps running while another app owns the port, then takes it over',async()=>{
  writeFileSync(join(dir,'gmail','extension','bridge-local.json'),JSON.stringify({account:expectedAccount,token,port}));
  const blocker=createServer().listen(port,'127.0.0.1');
  await new Promise(r=>blocker.once('listening',r));
  const client=new Client({name:'second-copy',version:'1.0.0'});
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,args:[join(dir,'gmail','server.mjs')],stderr:'pipe'}));
    const busy=await client.callTool({name:'account_identity',arguments:{}});
    assert.equal(busy.isError,true);assert.match(busy.content[0].text,/in use.*another Claude app/);
    await new Promise(r=>blocker.close(r));
    const call=client.callTool({name:'account_identity',arguments:{}});
    const request=await nextRequest();
    assert.equal(request.action,'identity');
    await respond({id:request.id,data:{account:expectedAccount}});
    assert.equal((await call).isError,undefined);
  } finally {await client.close();blocker.close();}
});
