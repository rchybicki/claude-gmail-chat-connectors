import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../gmail/extension/page.js',import.meta.url),'utf8').replaceAll('export function','function');
const account='jan.kowalski@randstad.com',id='123456789abcdef';
function fixture({label=account,count=1,checked='false',extraSelection=false,buttonCount=1,unread=false}={}) {
  let archived=0,opened=0,selected=checked;
  const checkbox={getAttribute:()=>selected,click(){selected='true';}};
  const row={getClientRects:()=>[{}],classList:{contains:s=>s===(unread?'zE':'yO')},querySelector(s){return s==='[role="checkbox"]'?checkbox:s==='[data-legacy-thread-id]'?{getAttribute:()=>id,click(){opened++;}}:null;}};
  let pressed=false;
  const button={getClientRects:()=>[{}],closest:()=>null,getAttribute:s=>s==='aria-label'?'Archive':null,click(){assert.fail('bare click does not activate Gmail toolbar');},dispatchEvent(e){if(e.type==='mousedown'){assert.equal(e.buttons,1);pressed=true;}if(e.type==='mouseup'){assert.equal(pressed,true);assert.equal(e.buttons,0);archived++;pressed=false;}}};
  const main={querySelectorAll(s){return s==='[role="button"]'?Array(buttonCount).fill(button):[...(selected==='true'?[checkbox]:[]),...(extraSelection?[{}]:[])];}};
  const context={window:{},MouseEvent:class {constructor(type,options){this.type=type;Object.assign(this,options);}},document:{querySelectorAll:s=>s==='tr.zA'?Array(count).fill(row):[{getAttribute:()=> 'Google Account: '+label}],querySelector:()=>main},location:{hash:'#search/in%3Ainbox%20(test)'},args:{expectedAccount:account,emailId:id,query:'in:inbox (test)'},result:null};
  vm.createContext(context);vm.runInContext(source,context);
  return {run(action){context.args.action=action;return vm.runInContext('gmailPageOperation(args)',context);},state:()=>({archived,opened,selected}),context};
}
test('archive selects exactly one read or unread thread without opening it',()=>{
  for(const unread of [false,true]) {
    const f=fixture({unread});assert.equal(f.run('archive_select').selected,id);
    assert.equal(f.run('archive_click').archiveRequested,id);
    assert.deepEqual(f.state(),{archived:1,opened:0,selected:'true'});
  }
});
test('archive refuses identity mismatch, wrong ID, multiple rows or selections and ambiguous controls',()=>{
  for(const opts of [{label:'other@example.com'},{label:account+' other@example.com'},{count:2},{checked:'true'}]) {
    const f=fixture(opts);assert.throws(()=>f.run('archive_select'));assert.equal(f.state().archived,0);
  }
  const wrong=fixture();wrong.context.args.emailId='abcdef123456789';assert.throws(()=>wrong.run('archive_select'),/not in/);
  for(const opts of [{extraSelection:true},{buttonCount:0},{buttonCount:2}]) {
    const f=fixture(opts);f.run('archive_select');assert.throws(()=>f.run('archive_click'));assert.equal(f.state().archived,0);
  }
  const notSelected=fixture();assert.throws(()=>notSelected.run('archive_click'),/selection/);
});

const background=readFileSync(new URL('../gmail/extension/background.js',import.meta.url),'utf8')
  .replace(/^import .*;\n/gm,'').split('async function poll()')[0];
function bridgeFixture({matches=1,failClick=false,failFreshTab=false,persisted=true,selectionDelay=0,acknowledged=true}={}) {
  let clicks=0,created=0,closed=0,searches=0,readiness=0,freshChecks=0;
  const context={URL,fetch:async()=>({json:async()=>({account})}),setTimeout:fn=>fn(),gmailPageOperation(){},extractReadThread(){},prepareDraft(){},chrome:{runtime:{getURL:()=> 'fixture-only'},
    tabs:{query:async()=>[{id:1}],create:async()=>{created++;if(failFreshTab&&created===2)throw Error('navigation failed');return {id:created+1};},remove:async()=>{closed++;}},
    scripting:{executeScript:async({target,args:[args]})=>{
      if(args.action==='identity')return [{result:{account,baseUrl:'https://mail.google.com/mail/u/3/'}}];
      if(args.action==='search'){
        assert.equal(args.query,'in:inbox (subject:test)');searches++;
        if(target.tabId===3)freshChecks++;
        const count=target.tabId===2?matches:persisted?0:1;
        return [{result:{account,visibleCount:count,emails:Array(count).fill({id})}}];
      }
      if(args.action==='archive_status')return [{result:{acknowledged}}];
      if(args.action==='archive_select')return [{result:{selected:id}}];
      if(args.action==='archive_ready')return [{result:{ready:++readiness>selectionDelay}}];
      if(args.action==='archive_click'){clicks++;if(failClick)throw Error('page response lost');return [{result:{archiveRequested:id,wasUnread:true}}];}
      assert.fail('Unexpected action '+args.action);
    }}
  }};
  vm.createContext(context);vm.runInContext(background,context);
  return {run:()=>vm.runInContext(`run({action:'archive',query:'subject:test',emailId:'${id}'})`,context),state:()=>({clicks,created,closed,readiness,freshChecks})};
}
test('archive verifies a fresh document, refuses broad searches, and never replays an uncertain click',async()=>{
  const good=bridgeFixture({selectionDelay:3});assert.equal((await good.run()).status,'archived');
  assert.deepEqual(good.state(),{clicks:1,created:2,closed:2,readiness:4,freshChecks:1});
  for(const matches of [0,2]){const f=bridgeFixture({matches});await assert.rejects(f.run(),/exactly/);assert.equal(f.state().clicks,0);}
  for(const options of [{failClick:true},{failFreshTab:true},{persisted:false},{acknowledged:false}]) {
    const f=bridgeFixture(options);await assert.rejects(f.run(),/may already be archived/);assert.equal(f.state().clicks,1);
    if(options.persisted===false)assert.equal(f.state().freshChecks,20);
  }
  const slow=bridgeFixture({selectionDelay:20});await assert.rejects(slow.run(),/no Archive click was attempted/);assert.equal(slow.state().clicks,0);
});
