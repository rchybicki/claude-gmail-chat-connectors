import { gmailPageOperation, extractReadThread } from './page.js';
import { prepareDraft } from './draft.js';
let polling = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const config = fetch(chrome.runtime.getURL('bridge-local.json')).then(r => r.json());
async function page(tabId, func, args) {
  const result = await chrome.scripting.executeScript({ target: {tabId}, func, args: [args] });
  if (result[0]?.error) throw new Error('Page operation failed');
  if (!result[0]?.result) throw new Error('Page returned no result');
  return result[0].result;
}
async function run(request) {
  if (!['identity','search','read','read_and_mark_read','draft','archive'].includes(request.action)) throw new Error('Action not allowed');
  const {account:ACCOUNT} = await config;
  let identity;
  for (const tab of await chrome.tabs.query({url:'https://mail.google.com/*'})) {
    try {
      identity = await page(tab.id, gmailPageOperation, {action:'identity',expectedAccount:ACCOUNT});
      break;
    } catch { /* A different account is never a fallback. */ }
  }
  if (!identity) throw new Error('Open the Randstad Gmail account in this Chrome profile');
  if (request.action === 'identity') return {...identity,extensionVersion:chrome.runtime.getManifest().version};
  const base = new URL(identity.baseUrl);
  if (base.origin !== 'https://mail.google.com' || !/^\/mail\/u\/\d+\/$/.test(base.pathname)) throw new Error('Unsupported Gmail account URL');
  if(request.action==='draft') {
    const query='in:drafts subject:"'+request.subject+'" to:'+request.to;
    const tab=await chrome.tabs.create({url:base.href+'#search/'+encodeURIComponent(query),active:false});
    try {
      let ready=false;
      for(let i=0;i<40;i++) {
        try {
          const existing=await page(tab.id,gmailPageOperation,{action:'search',expectedAccount:ACCOUNT,query,limit:50});
          if(existing.emails.some(e=>e.subject===request.subject)){
            await chrome.tabs.remove(tab.id);
            return {account:ACCOUNT,status:'existing_draft',sent:false,url:base.href+'#drafts',note:'A draft with this subject and recipient already exists; no draft was created or changed.'};
          }
          ready=true;break;
        }
        catch {await sleep(500);}
      }
      if(!ready)throw new Error('Draft tab did not load');
      const result=await page(tab.id,prepareDraft,{...request,expectedAccount:ACCOUNT});
      // Reload the search to verify persistence independently of the composer DOM.
      await chrome.tabs.reload(tab.id);
      for(let i=0;i<40;i++) {
        try {
          const found=await page(tab.id,gmailPageOperation,{action:'search',expectedAccount:ACCOUNT,query,limit:50});
          const matches=found.emails.filter(e=>e.subject===request.subject);
          if(matches.length===1){
            await page(tab.id,prepareDraft,{...request,expectedAccount:ACCOUNT,verifyOnly:true,emailId:matches[0].id});
            await chrome.tabs.remove(tab.id);
            return {...result,status:'saved_draft',bodyVerified:true,id:matches[0].id,url:base.href+'#drafts',coverage:'New plain-text draft, one recipient. No attachments, reply threading or sending.'};
          }
        }catch { /* Wait for the saved draft search to load. */ }
        await sleep(500);
      }
      throw new Error('Draft save could not be uniquely verified');
    } catch(error) {
      throw new Error((error.message||'Draft operation failed')+'; inspect Drafts or the open draft tab before retrying. Nothing was sent.');
    }
  }
  if (request.action === 'archive') {
    const query = 'in:inbox (' + request.query + ')';
    let tab = await chrome.tabs.create({url:base.href+'#search/'+encodeURIComponent(query),active:false});
    const args = {...request,query,expectedAccount:ACCOUNT,limit:50};
    let archiveAttempted = false;
    let verificationTab;
    try {
      let found;
      for (let i=0;i<40;i++) {
        try { found=await page(tab.id,gmailPageOperation,{...args,action:'search'});break; }
        catch { await sleep(500); }
      }
      if (!found || found.visibleCount !== 1 || found.emails[0].id !== request.emailId)
        throw new Error('Archive requires a query matching exactly the requested inbox thread');
      await page(tab.id,gmailPageOperation,{...args,action:'archive_select'});
      // Selection updates asynchronously. Only readiness checks can be retried;
      // the actual Archive click is dispatched once and never replayed.
      let ready=false;
      for (let i=0;i<10;i++) {
        if ((await page(tab.id,gmailPageOperation,{...args,action:'archive_ready'})).ready) {ready=true;break;}
        await sleep(250);
      }
      if (!ready) throw new Error('Archive selection or toolbar not ready; no Archive click was attempted');
      archiveAttempted = true;
      const clicked=await page(tab.id,gmailPageOperation,{...args,action:'archive_click'});
      let acknowledged=false;
      for (let i=0;i<20;i++) {
        const status=await page(tab.id,gmailPageOperation,{...args,action:'archive_status'});
        if(status.acknowledged){acknowledged=true;break;}
        await sleep(500);
      }
      if (!acknowledged) throw new Error('Gmail did not acknowledge the Archive action');
      // Search rows can remain visible after Archive. Verify in a separate
      // document, keeping the mutation tab alive until persistence is checked.
      verificationTab = await chrome.tabs.create({url:base.href+'#search/'+encodeURIComponent(query),active:false});
      for (let i=0;i<20;i++) {
        try {
          const verified=await page(verificationTab.id,gmailPageOperation,{...args,action:'search'});
          if (verified.visibleCount===0) return {account:ACCOUNT,id:request.emailId,status:'archived',
            wasUnread:clicked.wasUnread,verification:'Absent from the uniquely matched inbox search in a fresh tab; thread was not opened.'};
        } catch { /* Wait for the fresh search. */ }
        await sleep(500);
      }
      throw new Error('Archive persistence could not be verified');
    } catch(error) {
      throw new Error(error.message + (archiveAttempted ? '; the thread may already be archived. Check Gmail before retrying.' : ''));
    } finally {
      if(verificationTab)await chrome.tabs.remove(verificationTab.id).catch(()=>{});
      await chrome.tabs.remove(tab.id).catch(()=>{});
    }
  }
  const tab = await chrome.tabs.create({url:base.href+'#search/'+encodeURIComponent(request.query),active:false});
  try {
    const args = {...request, expectedAccount:ACCOUNT};
    let result, lastError;
    for (let i=0;i<40;i++) {
      try { result = await page(tab.id, gmailPageOperation, {...args,action:'search'}); break; }
      catch (error) { lastError=error; await sleep(500); }
    }
    if (!result) throw new Error(lastError?.message || 'Search page timed out');
    if (request.action === 'search') return result;
    const opened = await page(tab.id, gmailPageOperation, args);
    for (let i=0;i<20;i++) {
      try { return {...await page(tab.id, extractReadThread, args), wasUnread:opened.wasUnread,
        readStateEffect:opened.wasUnread ? 'Opened in Gmail; Gmail may mark it read. Search again to verify current state.' : 'Already read.'}; }
      catch (error) { lastError=error; await sleep(500); }
    }
    throw new Error((lastError?.message || 'Thread load timed out') +
      (opened.wasUnread ? '; the thread was opened and may now be marked read. Do not retry automatically.' : ''));
  } finally {
    await chrome.tabs.remove(tab.id).catch(()=>{});
  }
}
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const {token,port} = await config;
    const BRIDGE = 'http://127.0.0.1:'+port;
    // The key never leaves the extension: messages carry HMAC signatures (see gmail/server.mjs).
    const hex = bytes => [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
    const unhex = text => new Uint8Array(text.match(/../g).map(h=>parseInt(h,16)));
    const key = await crypto.subtle.importKey('raw',unhex(token),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
    const sign = async text => hex(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(text)));
    const verify = async (signature,text) => /^[a-f0-9]{64}$/.test(signature||'') &&
      crypto.subtle.verify('HMAC',key,unhex(signature),new TextEncoder().encode(text));
    while (true) {
      const nonce = crypto.randomUUID();
      const response = await fetch(BRIDGE+'/poll',{headers:{'X-Nonce':nonce,'X-Signature':await sign('poll\n'+nonce)},signal:AbortSignal.timeout(25000)});
      if (!response.ok) throw new Error('Bridge unavailable');
      const {payload,signature} = await response.json();
      if (payload) {
        if (!await verify(signature,'request\n'+nonce+'\n'+payload)) throw new Error('Unsigned bridge request');
        const request = JSON.parse(payload);
        let result;
        try { result = {data:await run(request)}; }
        catch(error) { result = {error:error.message}; }
        const body = JSON.stringify({id:request.id,...result});
        await fetch(BRIDGE+'/response',{method:'POST',headers:{'Content-Type':'application/json','X-Signature':await sign('response\n'+body)},body,signal:AbortSignal.timeout(5000)});
      }
      await sleep(500);
    }
  } catch { /* Retry without logging mailbox data or authentication material. */ }
  finally { polling = false; }
}
chrome.alarms.create('gmail-mcp-poll',{periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener(poll);
chrome.runtime.onStartup.addListener(poll);
chrome.runtime.onInstalled.addListener(poll);
poll();
