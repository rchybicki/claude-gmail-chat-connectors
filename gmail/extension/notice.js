document.addEventListener('visibilitychange', ()=>{ if (document.visibilityState === 'visible') chrome.runtime.sendMessage('recheck').catch(()=>{}); });
try {
  const {account} = await (await fetch(chrome.runtime.getURL('bridge-local.json'))).json();
  document.getElementById('account').textContent = account;
  document.getElementById('signin').href = 'https://accounts.google.com/AddSession?'+new URLSearchParams({service:'mail',Email:account,
    continue:'https://mail.google.com/mail/u/?authuser='+encodeURIComponent(account)});
} catch {
  // Without the setup file the account is unknown, so there is no sign-in link to give.
  document.getElementById('account').textContent = 'your work account';
  document.getElementById('signin').remove();
}
