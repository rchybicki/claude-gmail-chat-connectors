const {account} = await (await fetch(chrome.runtime.getURL('bridge-local.json'))).json();
document.getElementById('account').textContent = account;
document.getElementById('signin').href = 'https://mail.google.com/mail/u/?authuser='+encodeURIComponent(account);
