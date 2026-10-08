import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, realpathSync, symlinkSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Isolated copy and home folder: never touches the real Claude configuration.
const dir=realpathSync(mkdtempSync(join(tmpdir(),'randstad-setup-test-'))),home=join(dir,'home'),app=join(dir,'app');
cpSync(new URL('..',import.meta.url),app,{recursive:true,filter:src=>!/(\.git|bridge-local\.json|token\.json)$/.test(src)});
const claudeConfig=join(home,'Library','Application Support','Claude','claude_desktop_config.json');
const bridge=join(app,'gmail','extension','bridge-local.json');
const setup=(...args)=>spawnSync(process.execPath,[join(app,'setup.mjs'),...args],{encoding:'utf8',env:{...process.env,HOME:home,PATH:join(dir,'bin')},timeout:20000});
mkdirSync(join(dir,'bin'));writeFileSync(join(dir,'bin','node'),'',{mode:0o755});
mkdirSync(join(dir,'bad'));writeFileSync(join(dir,'bad','node'),'',{mode:0o644});
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
  assert.deepEqual(config.mcpServers['gmail-chrome'],{command:join(dir,'bin','node'),args:[join(app,'gmail','server.mjs')]});
  assert.ok(existsSync(claudeConfig+'.bak'));
  assert.equal(setup('gmail','jan.kowalski@randstad.com').status,0);
  assert.equal(JSON.parse(readFileSync(bridge,'utf8')).token,key.token,'rerun keeps the token so the extension needs no reload');
});
test('bad input and unreadable Claude config change nothing',{skip:process.platform==='win32'},()=>{
  for(const args of [['gmail'],['gmail','not-an-email'],['chat'],['chat','not-an-email'],['other']]) assert.notEqual(setup(...args).status,0);
  const before=readFileSync(bridge,'utf8');
  for(const text of ['{broken','[]','{"mcpServers":[]}','null']) {
    writeFileSync(claudeConfig,text);
    const run=setup('gmail','someone.else@randstad.com');
    assert.notEqual(run.status,0);assert.match(run.stderr,/Cannot read/);
    assert.equal(readFileSync(claudeConfig,'utf8'),text);
    assert.equal(readFileSync(bridge,'utf8'),before,'the Gmail account is not changed either');
  }
});
test('uninstall removes only this tool from Claude and deletes the Gmail key',{skip:process.platform==='win32'},()=>{
  writeFileSync(claudeConfig,JSON.stringify({mcpServers:{other:{command:'x'}}}));
  assert.equal(setup('gmail','jan.kowalski@randstad.com').status,0);
  assert.equal(setup('uninstall').status,0);
  assert.deepEqual(JSON.parse(readFileSync(claudeConfig,'utf8')).mcpServers,{other:{command:'x'}});
  assert.equal(existsSync(bridge),false);
});
test('a node file that cannot run is not registered',{skip:process.platform==='win32'},()=>{
  writeFileSync(claudeConfig,'{}');
  const run=spawnSync(process.execPath,[join(app,'setup.mjs'),'gmail','jan.kowalski@randstad.com'],{encoding:'utf8',env:{...process.env,HOME:home,PATH:join(dir,'bad')}});
  assert.equal(run.status,0);
  assert.equal(JSON.parse(readFileSync(claudeConfig,'utf8')).mcpServers['gmail-chrome'].command,process.execPath);
});
test('setup also registers in Claude Code when the claude command exists, and uninstall removes it',{skip:process.platform==='win32'},()=>{
  const bin=join(dir,'cc-bin'),log=join(dir,'claude.log');
  mkdirSync(bin);writeFileSync(join(bin,'node'),'',{mode:0o755});
  writeFileSync(join(bin,'claude'),'#!/bin/sh\necho "$@" >> "'+log+'"\n',{mode:0o755});
  writeFileSync(claudeConfig,'{}');
  const run=args=>spawnSync(process.execPath,[join(app,'setup.mjs'),...args],{encoding:'utf8',env:{...process.env,HOME:home,PATH:bin+':/bin:/usr/bin'}});
  const out=run(['gmail','jan.kowalski@randstad.com']);
  assert.equal(out.status,0);assert.match(out.stdout,/Added gmail-chrome to Claude Code/);
  assert.deepEqual(readFileSync(log,'utf8').trim().split('\n'),[
    'mcp remove --scope user gmail-chrome',
    'mcp add --scope user gmail-chrome -- '+join(bin,'node')+' '+join(app,'gmail','server.mjs')]);
  rmSync(log);
  assert.equal(run(['uninstall']).status,0);
  assert.deepEqual(readFileSync(log,'utf8').trim().split('\n'),['mcp remove --scope user gmail-chrome','mcp remove --scope user google-chat']);
});
test('without the claude command, the printed command passes the exact arguments, even for odd folder names',{skip:process.platform==='win32'},()=>{
  const odd=join(dir,"it's $(echo X) app");
  cpSync(app,odd,{recursive:true,filter:src=>!src.includes('node_modules')});
  symlinkSync(join(app,'node_modules'),join(odd,'node_modules'));
  writeFileSync(claudeConfig,'{}');
  const out=spawnSync(process.execPath,[join(odd,'setup.mjs'),'gmail','jan.kowalski@randstad.com'],{encoding:'utf8',env:{...process.env,HOME:home,PATH:join(dir,'bin')}});
  assert.equal(out.status,0);
  const command=out.stdout.match(/run: (claude .*)/)[1];
  const received=spawnSync('/bin/sh',['-c',`claude() { printf '%s\\n' "$@"; }; ${command}`],{encoding:'utf8'}).stdout.trim().split('\n');
  assert.deepEqual(received,['mcp','add','--scope','user','gmail-chrome','--',join(dir,'bin','node'),join(odd,'gmail','server.mjs')]);
});
test('uninstall reports a Claude Code removal that failed',{skip:process.platform==='win32'},()=>{
  const bin=join(dir,'fail-bin');
  mkdirSync(bin);writeFileSync(join(bin,'node'),'',{mode:0o755});
  writeFileSync(join(bin,'claude'),'#!/bin/sh\necho boom >&2\nexit 1\n',{mode:0o755});
  writeFileSync(claudeConfig,'{}');
  const out=spawnSync(process.execPath,[join(app,'setup.mjs'),'uninstall'],{encoding:'utf8',env:{...process.env,HOME:home,PATH:bin+':/bin:/usr/bin'}});
  assert.equal(out.status,0);
  assert.match(out.stdout,/Could not remove gmail-chrome from Claude Code\. Run: claude 'mcp' 'remove' '--scope' 'user' 'gmail-chrome'/);
  assert.match(out.stdout,/Could not remove google-chat/);
});
test('the backup keeps the file from before the first setup, and uninstall without a settings file creates none',{skip:process.platform==='win32'},()=>{
  writeFileSync(claudeConfig,JSON.stringify({mcpServers:{original:{command:'x'}}}));
  rmSync(claudeConfig+'.bak',{force:true});
  assert.equal(setup('gmail','jan.kowalski@randstad.com').status,0);
  assert.equal(setup('gmail','jan.kowalski@randstad.com').status,0);
  assert.deepEqual(JSON.parse(readFileSync(claudeConfig+'.bak','utf8')),{mcpServers:{original:{command:'x'}}});
  rmSync(claudeConfig);rmSync(claudeConfig+'.bak');
  assert.equal(setup('uninstall').status,0);
  assert.equal(existsSync(claudeConfig),false);
});
