import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const expectedAccount='jan.kowalski@randstad.com';
const pageSource=readFileSync(new URL('../gmail/extension/page.js',import.meta.url),'utf8').replaceAll('export function','function');
function pageTest(labels, action='identity', rows=[]) {
  let clicked=false;
  const context={document:{querySelectorAll(selector){return selector==='tr.zA'?rows:labels.map(label=>({getAttribute:()=>label}));}},location:{origin:'https://mail.google.com',pathname:'/mail/u/2/',hash:'#search/test'},args:{action,expectedAccount,query:'test',emailId:'123456789abcdef'},result:null};
  vm.createContext(context);vm.runInContext(pageSource+'\nresult=gmailPageOperation(args);',context);
  return context.result;
}
test('account label required; no sender, subject or absent-account fallback',()=>{
  for(const labels of [[],['Google Account: '+expectedAccount+' (other@example.com)'],['other@example.com'],['Google Account: other@example.com'],['Subject mentions '+expectedAccount],['Google Account: '+expectedAccount,'Google Account: other@example.com']]) assert.throws(()=>pageTest(labels),/identity/);
  for(const prefix of ['Google Account: ','Konto Google: ']) assert.equal(pageTest([prefix+expectedAccount]).account,expectedAccount);
});
test('message extraction rejects ambiguous account labels before accessing bodies',()=>{
  const context={document:{querySelector:()=>({getAttribute:()=> 'Google Account: '+expectedAccount+' (other@example.com)'}),querySelectorAll:()=>assert.fail('must not read bodies')},args:{expectedAccount,emailId:'123456789abcdef'}};
  vm.createContext(context);assert.throws(()=>vm.runInContext(pageSource+'\nextractReadThread(args);',context),/identity/);
});
test('Gmail canonical spaces decode without changing literal plus signs',()=>{
  for (const [hash,query] of [['#search/in%3Ainbox+is%3Aread','in:inbox is:read'],['#search/from%3Auser%2Btag%40example.com','from:user+tag@example.com']]) {
    const context={document:{querySelectorAll:s=>s==='tr.zA'?[]:[{getAttribute:()=> 'Google Account: '+expectedAccount}],querySelector:()=>({innerText:'No conversations found'})},location:{hash},args:{action:'search',expectedAccount,query},result:null};
    vm.createContext(context);vm.runInContext(pageSource+'\nresult=gmailPageOperation(args);',context);
    assert.equal(context.result.query,query);assert.equal(context.result.emails.length,0);
    context.args.query='different query';assert.throws(()=>vm.runInContext('gmailPageOperation(args)',context),/not ready/);
  }
});
test('unsupported actions and unread/unknown rows fail without clicking',()=>{
  assert.throws(()=>pageTest(['Google Account: '+expectedAccount],'send'),/not allowed/);
  for(const classes of [new Set(['zE']),new Set()]) {
    const row={getClientRects:()=>[{}],classList:{contains:s=>classes.has(s)},querySelector:s=>s==='[data-legacy-thread-id]'?{getAttribute:()=> '123456789abcdef',click:()=>assert.fail('must not click')}:null};
    assert.throws(()=>pageTest(['Google Account: '+expectedAccount],'read',[row]),/Unread or unknown/);
  }
});
test('only the explicit mark-read action opens an unread row',()=>{
  let clicked=0;
  const row={getClientRects:()=>[{}],classList:{contains:s=>s==='zE'},querySelector:s=>s==='[data-legacy-thread-id]'?{getAttribute:()=> '123456789abcdef',click:()=>clicked++}:null};
  assert.throws(()=>pageTest(['Google Account: '+expectedAccount],'read',[row]),/Unread or unknown/);
  assert.equal(clicked,0);
  assert.equal(pageTest(['Google Account: '+expectedAccount],'read_and_mark_read',[row]).wasUnread,true);
  assert.equal(clicked,1);
  row.classList.contains=()=>false;
  assert.throws(()=>pageTest(['Google Account: '+expectedAccount],'read_and_mark_read',[row]),/Unread or unknown/);
  assert.equal(clicked,1);
});
