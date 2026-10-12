import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../gmail/extension/draft.js',import.meta.url),'utf8').replace('export async function','async function');
const account='jan.kowalski@randstad.com';
function fixture({label=account,existing=false,missing=false,saved=null,args={}}={}) {
  let opened=existing,closed=false,composeClicks=0,presses=[];
  const input=()=>({value:'',focus(){},blur(){},dispatchEvent(){}});
  const recipient=input(),subject=input(),body={...input(),textContent:'',replaceChildren(el){assert.equal(el.style.whiteSpace,'pre-wrap');this.textContent=el.textContent;},get innerText(){return this.textContent;}};
  const close={click(){closed=true;}};
  const sendButton={textContent:' Send ',getClientRects:()=>[],click(){presses.push('click');closed=true;}};
  const dialog={getClientRects:()=>[{}],get isConnected(){return !closed;},querySelector(s){return {'input[name="subjectbox"]':subject,'input[name="from"]':{value:account},'input[aria-label="To recipients"]':recipient,'[contenteditable="true"][aria-label="Message Body"]':missing?null:body,'[aria-label="Save & close"]':close}[s]||null;},querySelectorAll(s){if(s==='[role="button"]')return [sendButton];assert.equal(s,'[email]');return [{getAttribute:()=>recipient.value}];}};
  if(saved){recipient.value=saved.to;subject.value=saved.subject;body.textContent=saved.body;}
  const row={getAttribute:()=> 'abc123',getClientRects:()=>[{}],click(){opened=true;}};
  const compose={textContent:'Compose',getClientRects:()=>[{}],click(){opened=true;composeClicks++;}};
  const send={textContent:'Send',getClientRects:()=>[{}],click(){assert.fail('must never send');}};
  const context={document:{createElement(){return {style:{},textContent:''};},querySelectorAll(s){return {'#gb [aria-label]':[{getAttribute:()=> 'Google Account: '+label}],'[role="dialog"]':opened&&!closed?[dialog]:[],'[role="button"]':[compose,send],'tr.zA [data-legacy-thread-id]':[row]}[s]||[];}},Event:class {},KeyboardEvent:class {},setTimeout:fn=>fn(),args:{expectedAccount:account,to:'colleague@example.com',subject:'Draft test',body:'Literal <b>text</b>\nSecond line',...args},result:null};
  vm.createContext(context);
  return {run:()=>vm.runInContext(source+'\nresult=prepareDraft(args);',context),state:()=>({closed,composeClicks,presses,subject:subject.value,body:body.textContent,to:recipient.value})};
}
test('draft creation uses plain text and closes only the new composer without sending',async()=>{
  const f=fixture();const r=await f.run();assert.equal(r.sent,false);assert.equal(r.status,'save_requested');
  assert.deepEqual(f.state(),{closed:true,composeClicks:1,presses:[],subject:'Draft test',body:'Literal <b>text</b>\nSecond line',to:'colleague@example.com'});
});
test('wrong or ambiguous account, existing composer and missing fields fail closed',async()=>{
  for(const label of ['other@example.com',account+' (other@example.com)']) {
    const f=fixture({label});await assert.rejects(f.run(),/identity/);assert.equal(f.state().composeClicks,0);
  }
  const existing=fixture({existing:true});await assert.rejects(existing.run(),/Existing composer/);assert.equal(existing.state().composeClicks,0);
  const missing=fixture({missing:true});await assert.rejects(missing.run(),/Unsupported composer/);assert.equal(missing.state().subject,'');assert.equal(missing.state().closed,false);
});
const draft={to:'colleague@example.com',subject:'Draft test',body:'Literal <b>text</b>\nSecond line'};
test('send presses Send once in a new message, only after its fields match',async()=>{
  const f=fixture({args:{send:true}});
  assert.equal((await f.run()).status,'send_requested');
  assert.deepEqual(f.state().presses,['click']);assert.equal(f.state().composeClicks,1);
  const wrong=fixture({label:'other@example.com',args:{send:true}});
  await assert.rejects(wrong.run(),/identity/);assert.deepEqual(wrong.state().presses,[]);
  const reopened=fixture({saved:draft,args:{verifyOnly:true,emailId:'abc123',send:true}});
  await assert.rejects(reopened.run(),/only in a new message/);assert.deepEqual(reopened.state().presses,[]);
});
