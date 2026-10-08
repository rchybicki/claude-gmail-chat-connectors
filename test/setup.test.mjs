import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Isolated copy and home folder: never touches the real Claude configuration.
const dir=realpathSync(mkdtempSync(join(tmpdir(),'randstad-setup-test-'))),home=join(dir,'home'),app=join(dir,'app');
cpSync(new URL('..',import.meta.url),app,{recursive:true,filter:src=>!/(\.git|bridge-local\.json|token\.json|oauth-client\.json)$/.test(src)});
const claudeConfig=join(home,'Library','Application Support','Claude','claude_desktop_config.json');
const bridge=join(app,'gmail','extension','bridge-local.json');
const setup=(...args)=>spawnSync(process.execPath,[join(app,'setup.mjs'),...args],{encoding:'utf8',env:{...process.env,HOME:home,PATH:join(dir,'bin')},timeout:20000});
mkdirSync(join(dir,'bin'));writeFileSync(join(dir,'bin','node'),'');
test.after(()=>rmSync(dir,{recursive:true,force:true}));
test('gmail setup writes a private key file and keeps other Claude servers',{skip:process.platform==='win32'},()=>{
  mkdirSync(join(claudeConfig,'..'),{recursive:true});
  writeFileSync(claudeConfig,JSON.stringify({mcpServers:{other:{command:'x'}},preferences:{a:1}}));
  assert.equal(setup('gmail','Jan.Kowalski@randstad.com').status,0);
  const key=JSON.parse(readFileSync(bridge,'utf8'));
  assert.equal(key.account,'jan.kowalski@randstad.com');assert.match(key.token,/^[a-f0-9]{64}$/);assert.equal(key.port,3456);
  assert.equal(statSync(bridge).mode&0o777,0o600);
  const config=JSON.parse(readFileSync(claudeConfig,'utf8'));
  assert.deepEqual(config.mcpServers.other,{command:'x'});assert.deepEqual(config.preferences,{a:1});
  assert.deepEqual(config.mcpServers['randstad-gmail'],{command:join(dir,'bin','node'),args:[join(app,'gmail','server.mjs')]});
  assert.ok(existsSync(claudeConfig+'.bak'));
  assert.equal(setup('gmail','jan.kowalski@randstad.com').status,0);
  assert.equal(JSON.parse(readFileSync(bridge,'utf8')).token,key.token,'rerun keeps the token so the extension needs no reload');
});
test('bad input and unreadable Claude config change nothing',{skip:process.platform==='win32'},()=>{
  for(const args of [['gmail'],['gmail','not-an-email'],['chat','jan@randstad.com','/no/such/file.json'],['other']]) assert.notEqual(setup(...args).status,0);
  writeFileSync(claudeConfig,'{broken');
  const run=setup('gmail','jan.kowalski@randstad.com');
  assert.notEqual(run.status,0);assert.match(run.stderr,/Cannot read/);
  assert.equal(readFileSync(claudeConfig,'utf8'),'{broken');
});
test('uninstall removes only this tool from Claude and deletes the Gmail key',{skip:process.platform==='win32'},()=>{
  writeFileSync(claudeConfig,JSON.stringify({mcpServers:{other:{command:'x'}}}));
  assert.equal(setup('gmail','jan.kowalski@randstad.com').status,0);
  assert.equal(setup('uninstall').status,0);
  assert.deepEqual(JSON.parse(readFileSync(claudeConfig,'utf8')).mcpServers,{other:{command:'x'}});
  assert.equal(existsSync(bridge),false);
});
