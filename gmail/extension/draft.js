// Draft creation only. No send control or send shortcut is used.
export async function prepareDraft({expectedAccount,to,subject,body,verifyOnly=false,emailId}) {
  const identity = () => {
    const labels=[...document.querySelectorAll('#gb [aria-label]')].map(e=>e.getAttribute('aria-label')).filter(s=>/^(Google Account|Konto Google):\s/.test(s||''));
    const accounts=[...new Set(labels.flatMap(s=>s.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)||[]).map(s=>s.toLowerCase()))];
    if(accounts.length!==1||accounts[0]!==expectedAccount)throw new Error('Randstad account identity missing or mismatched');
  };
  identity();
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
  const text=document.createElement('div');
  text.style.whiteSpace='pre-wrap';text.textContent=body.replace(/\r\n?/g,'\n');
  bodyField.replaceChildren(text);
  bodyField.dispatchEvent(new Event('input',{bubbles:true}));
  bodyField.dispatchEvent(new Event('change',{bubbles:true}));
  bodyField.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true}));
  bodyField.blur();
  }
  // Allow Gmail to commit the recipient before checking the form.
  await new Promise(r=>setTimeout(r,2000));
  identity();
  const recipients=[...dialog.querySelectorAll('[email]')].map(e=>e.getAttribute('email').toLowerCase());
  const normalize=s=>s.replace(/\r\n?/g,'\n').replaceAll('\u00a0',' ').trimEnd();
  const from=dialog.querySelector('input[name="from"]')?.value || '';
  const senders=[...new Set((from.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)||[]).map(s=>s.toLowerCase()))];
  // Gmail leaves the hidden From value empty when the default mailbox sender is used.
  if((from&&(senders.length!==1||senders[0]!==expectedAccount))||!recipients.length||recipients.some(e=>e!==to.toLowerCase())||subjectField.value!==subject||normalize(bodyField.innerText)!==normalize(body))throw new Error('Draft fields could not be verified; inspect the open draft and do not retry automatically');
  close.click();
  for(let i=0;i<20&&dialog.isConnected;i++)await new Promise(r=>setTimeout(r,250));
  if(dialog.isConnected)throw new Error('Draft save/close not confirmed; inspect the open draft');
  await new Promise(r=>setTimeout(r,1500));
  return {account:expectedAccount,status:verifyOnly?'saved_content_verified':'save_requested',to,subject,sent:false};
}
