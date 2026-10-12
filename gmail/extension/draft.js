// Creates a draft, or reopens a saved draft to check it. With send, it fills a new message,
// checks it the same way and presses Send once instead of Save & close; no send shortcut is used.
export async function prepareDraft({expectedAccount,to,subject,body,format='plain',verifyOnly=false,emailId,send=false}) {
  // A small Markdown subset becomes formatting through DOM methods only; no HTML is parsed, so the
  // text cannot add images, styles or scripts. Links must be http, https or mailto.
  const render=()=>{
    const root=document.createElement('div');
    if(format!=='markdown'){root.style.whiteSpace='pre-wrap';root.textContent=body.replace(/\r\n?/g,'\n');return [root];}
    const inline=(parent,line)=>{
      const re=/\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/g;
      let last=0,m;
      while((m=re.exec(line))){
        parent.append(line.slice(last,m.index));
        const el=document.createElement(m[1]!==undefined?'b':m[2]!==undefined?'i':'a');
        el.textContent=m[1]??m[2]??m[3];
        if(m[4])el.href=m[4];
        parent.append(el);last=re.lastIndex;
      }
      parent.append(line.slice(last));
    };
    const blocks=[];let list=null;
    for(const line of body.replace(/\r\n?/g,'\n').split('\n')){
      const item=/^\s*(?:[-*]|(\d+)[.)])\s+(.*)$/.exec(line);
      if(item){
        const tag=item[1]?'OL':'UL';
        if(list?.tagName!==tag){list=document.createElement(tag);blocks.push(list);}
        const li=document.createElement('li');inline(li,item[2]);list.append(li);
        continue;
      }
      list=null;
      const div=document.createElement('div');
      if(line.trim())inline(div,line);else div.append(document.createElement('br'));
      blocks.push(div);
    }
    return blocks;
  };
  const identity = () => {
    const labels=[...document.querySelectorAll('#gb [aria-label]')].map(e=>e.getAttribute('aria-label')).filter(s=>/^(Google Account|Konto Google):\s/.test(s||''));
    const accounts=[...new Set(labels.flatMap(s=>s.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)||[]).map(s=>s.toLowerCase()))];
    if(accounts.length!==1||accounts[0]!==expectedAccount)throw new Error('Gmail account identity missing or mismatched');
  };
  identity();
  if(send&&verifyOnly)throw new Error('Send works only in a new message');
  const dialogs=()=>[...document.querySelectorAll('[role="dialog"]')].filter(e=>e.getClientRects().length&&e.querySelector('input[name="subjectbox"]'));
  if(dialogs().length)throw new Error('Existing composer found; will not modify it');
  if(verifyOnly) {
    const matches=[...document.querySelectorAll('tr.zA [data-legacy-thread-id]')].filter(e=>e.getAttribute('data-legacy-thread-id')===emailId&&e.getClientRects().length);
    if(matches.length!==1)throw new Error('Saved draft row is not unique');
    matches[0].click();
  }else{
    const compose=[...document.querySelectorAll('[role="button"]')].filter(e=>e.getClientRects().length&&e.textContent.trim()==='Compose');
    if(compose.length!==1)throw new Error('Compose button unavailable');
    compose[0].click();
  }
  for(let i=0;i<20&&!dialogs().length;i++)await new Promise(r=>setTimeout(r,250));
  const all=dialogs();
  if(all.length!==1)throw new Error('New composer not found');
  const dialog=all[0];
  const recipient=dialog.querySelector('input[aria-label="To recipients"]');
  const subjectField=dialog.querySelector('input[name="subjectbox"]');
  const bodyField=dialog.querySelector('[contenteditable="true"][aria-label="Message Body"]');
  const close=dialog.querySelector('[aria-label="Save & close"]');
  if((!verifyOnly&&!recipient)||!subjectField||!bodyField||!close)throw new Error('Unsupported composer; draft tab left open');
  identity();
  if(!verifyOnly){
  recipient.focus();recipient.value=to;
  recipient.dispatchEvent(new Event('input',{bubbles:true}));
  recipient.dispatchEvent(new Event('change',{bubbles:true}));
  recipient.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}));
  subjectField.focus();subjectField.value=subject;
  subjectField.dispatchEvent(new Event('input',{bubbles:true}));
  subjectField.dispatchEvent(new Event('change',{bubbles:true}));
  bodyField.focus();
  bodyField.replaceChildren(...render());
  bodyField.dispatchEvent(new Event('input',{bubbles:true}));
  bodyField.dispatchEvent(new Event('change',{bubbles:true}));
  bodyField.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true}));
  bodyField.blur();
  }
  // Allow Gmail to commit the recipient before checking the form.
  await new Promise(r=>setTimeout(r,2000));
  identity();
  const recipients=[...dialog.querySelectorAll('[email]')].map(e=>e.getAttribute('email').toLowerCase());
  // Compares characters without whitespace: a minimized or background tab has no layout, so
  // innerText loses line breaks, but any changed, missing or added text still fails.
  const squash=s=>s.replace(/\s+/g,'');
  const from=dialog.querySelector('input[name="from"]')?.value || '';
  const senders=[...new Set((from.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)||[]).map(s=>s.toLowerCase()))];
  // Gmail leaves the hidden From value empty when the default mailbox sender is used.
  if((from&&(senders.length!==1||senders[0]!==expectedAccount))||!recipients.length||recipients.some(e=>e!==to.toLowerCase())||subjectField.value!==subject||squash(bodyField.textContent)!==squash(render().map(n=>n.textContent).join('')))throw new Error('Draft fields could not be verified; inspect the open draft and do not retry automatically');
  if(send){
    // Gmail opens the composer minimized in a background tab, so the Send button has no size.
    // A click sends it; a press and release, as for Archive, does not.
    const buttons=[...dialog.querySelectorAll('[role="button"]')].filter(e=>e.textContent.trim()==='Send');
    if(buttons.length!==1)throw new Error('Unique Send button not found; nothing was sent. Inspect the open draft');
    identity();
    buttons[0].click();
  }else close.click();
  for(let i=0;i<20&&dialog.isConnected;i++)await new Promise(r=>setTimeout(r,250));
  if(dialog.isConnected)throw new Error(send?'Send not confirmed; the email may have been sent. Check Sent and Drafts':'Draft save/close not confirmed; inspect the open draft');
  await new Promise(r=>setTimeout(r,1500));
  return {account:expectedAccount,status:send?'send_requested':verifyOnly?'saved_content_verified':'save_requested',to,subject,sent:false};
}
