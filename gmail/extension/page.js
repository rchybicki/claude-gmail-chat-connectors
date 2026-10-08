// Gmail DOM selectors derived from cafferychen777/gmail-mcp (MIT).
// Identity, search and thread access; unread opening requires a separate explicit action.
export function gmailPageOperation({ action, expectedAccount, query, emailId, limit = 10 }) {
  const labels = [...document.querySelectorAll('#gb [aria-label], header [aria-label], [role="banner"] [aria-label]')]
    .map(el => el.getAttribute('aria-label'))
    .filter(label => /^(Google Account|Konto Google):\s/.test(label || ''));
  const accounts = [...new Set(labels.flatMap(label => label.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map(email => email.toLowerCase()))];
  if (accounts.length !== 1 || accounts[0] !== expectedAccount) throw new Error('Gmail account identity missing or mismatched');
  if (action === 'identity') return { account: accounts[0], baseUrl: location.origin + location.pathname };
  if (!['search', 'read', 'read_and_mark_read', 'archive_select', 'archive_ready', 'archive_click', 'archive_status'].includes(action)) throw new Error('Action not allowed');
  const currentQuery = location.hash.startsWith('#search/') ? decodeURIComponent(location.hash.slice(8).replaceAll('+', ' ')) : null;
  if (currentQuery !== query) throw new Error('Search page not ready');
  if (action === 'archive_status') {
    const alerts=[...document.querySelectorAll('[role="alert"]')].map(el=>el.innerText).join(' ');
    return {acknowledged:/Conversation archived|Rozmowa została zarchiwizowana|Wątek został zarchiwizowany/i.test(alerts)};
  }
  const rows = [...document.querySelectorAll('tr.zA')].filter(r => r.getClientRects().length);
  const emails = rows.map(row => {
    const thread = row.querySelector('[data-legacy-thread-id]');
    if (!thread) throw new Error('Unsupported Gmail row: no stable thread ID');
    return {
      id: thread.getAttribute('data-legacy-thread-id'),
      subject: row.querySelector('.bog')?.textContent?.trim() || '',
      sender: row.querySelector('[email]')?.getAttribute('email') || '',
      snippet: row.querySelector('.y2')?.textContent?.trim() || '',
      unread: row.classList.contains('zE'),
      read: row.classList.contains('yO') && !row.classList.contains('zE'),
    };
  });
  if (action === 'search') {
    if (!rows.length) {
      const main = document.querySelector('[role="main"]');
      if (!main || !/No conversations found|No messages matched|No results found|Nie znaleziono rozmów|Żadne wiadomości nie pasują/i.test(main.innerText)) {
        throw new Error('Search result list not ready or unsupported');
      }
    }
    return { account: accounts[0], query, emails: emails.slice(0, limit), visibleCount: emails.length,
      coverage: 'First rendered result page only; use narrower Gmail queries for more results.' };
  }
  const index = emails.findIndex(e => e.id === emailId);
  if (index < 0) throw new Error('Thread not in this search result page');
  const row = rows[index];
  if (action === 'archive_select' || action === 'archive_ready' || action === 'archive_click') {
    if (rows.length !== 1) throw new Error('Archive requires a query matching exactly one inbox thread');
    const checkbox = row.querySelector('[role="checkbox"]');
    if (!checkbox) throw new Error('Thread selection control missing');
    if (action === 'archive_select') {
      if (checkbox.getAttribute('aria-checked') !== 'false') throw new Error('Unexpected existing selection');
      checkbox.click();
      return {selected:emailId};
    }
    const main = document.querySelector('[role="main"]');
    const selected = [...main.querySelectorAll('tr.zA [role="checkbox"][aria-checked="true"]')];
    const buttons = [...main.querySelectorAll('[role="button"]')].filter(el =>
      el.getClientRects().length && !el.closest('tr.zA') && el.getAttribute('aria-disabled') !== 'true' &&
      ['Archive','Archiwizuj'].includes(el.getAttribute('aria-label')));
    if (action === 'archive_ready') return {ready:selected.length === 1 && selected[0] === checkbox && buttons.length === 1};
    if (selected.length !== 1 || selected[0] !== checkbox) throw new Error('Archive selection does not match requested thread');
    if (buttons.length !== 1) throw new Error('Unique Archive button not ready');
    // Gmail's Closure toolbar activates on mouseup after mousedown; .click()
    // alone does not activate this control. Dispatch one press/release only.
    buttons[0].dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0,buttons:1,view:window}));
    buttons[0].dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,button:0,buttons:0,view:window}));
    return {archiveRequested:emailId,wasUnread:row.classList.contains('zE')};
  }
  const unread = row.classList.contains('zE');
  if (unread ? action !== 'read_and_mark_read' : !row.classList.contains('yO')) throw new Error('Unread or unknown read-state thread: not opened, because opening marks it read. Use read_email_and_mark_read only if the user allows that');
  // Identity and read-state checks occur synchronously immediately before this click.
  row.querySelector('[data-legacy-thread-id]').click();
  return { opened: emailId, wasUnread: unread };
}

export function extractReadThread({ expectedAccount, emailId }) {
  const accountLabel = document.querySelector('#gb [aria-label^="Google Account:"], #gb [aria-label^="Konto Google:"]')?.getAttribute('aria-label');
  const accounts = [...new Set((accountLabel?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map(email => email.toLowerCase()))];
  const account = accounts[0];
  if (accounts.length !== 1 || account !== expectedAccount) throw new Error('Gmail account identity missing or mismatched');
  const heading = document.querySelector('h2[data-legacy-thread-id]');
  if (heading?.getAttribute('data-legacy-thread-id') !== emailId) throw new Error('Requested thread not loaded');
  const bodies = [...document.querySelectorAll('.a3s')].filter(el => el.getClientRects().length);
  if (!bodies.length) throw new Error('No visible message body loaded');
  return { account, id: emailId, subject: heading.textContent.trim(), messages: bodies.map(el => ({content:el.innerText.trim()})),
    coverage: 'Visible expanded messages only; collapsed messages and attachments are not extracted.' };
}
